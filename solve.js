// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// Same answer, byte for byte, on every input {text, header}: {columns, rows, errors}.
// The reference walks the text one character at a time; this reader jumps instead:
// most records hold no quote and no stray carriage return, so a record is read with
// a few native scans (indexOf / slice / split) and only the records that hold a
// quote, a stray CR or a broken row fall back to a field-by-field scan. Every scan
// that could run past the record is bounded by a slice of the record or the field,
// so a missing character never scans the rest of the file.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the next.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xFEFF) pos = 1;

  // The record being read: the line it starts on and its index in rows (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // Reads unquoted characters onto `init` up to the next comma or line break.
  // A CR not followed by LF is dropped (stray_cr). The answer lands in uqVal,
  // uqEnd and uqAdd (`added` counts the characters this call kept, not the
  // ones already in `init`); returning them in an array would allocate per field.
  let uqVal = '';
  let uqEnd = END;
  let uqAdd = 0;
  function readUnquoted(init) {
    let value = init;
    let added = 0;
    for (;;) {
      const comma = text.indexOf(',', pos);
      const nl = text.indexOf('\n', pos);
      if (comma === -1 && nl === -1) {
        // The field runs to the end of the text; a CR in the tail is stray.
        const tail = text.slice(pos);
        const k = tail.indexOf('\r');
        if (k === -1) {
          if (pos < n) { value += tail; added += n - pos; pos = n; }
          uqVal = value; uqEnd = END; uqAdd = added; return;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (k > 0) { value += tail.slice(0, k); added += k; }
        pos += k + 1;
        continue;
      }
      let d, kind;
      if (comma === -1) { d = nl; kind = LINE_BREAK; }
      else if (nl === -1 || comma < nl) { d = comma; kind = COMMA; }
      else { d = nl; kind = LINE_BREAK; }
      // A CR inside [pos, d) is stray, unless it is the CR of the CRLF that ends the field.
      const seg = text.slice(pos, d);
      const k = seg.indexOf('\r');
      if (k === -1) {
        if (d > pos) { value += seg; added += d - pos; }
        pos = d + 1;
        if (kind === LINE_BREAK) line += 1;
        uqVal = value; uqEnd = kind; uqAdd = added; return;
      }
      if (kind === LINE_BREAK && pos + k === d - 1) {
        if (k > 0) { value += seg.slice(0, k); added += k; }
        pos = d + 1;
        line += 1;
        uqVal = value; uqEnd = LINE_BREAK; uqAdd = added; return;
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      if (k > 0) { value += seg.slice(0, k); added += k; }
      pos += k + 1;
    }
  }

  // Places one record's fields: the header, or a row at the first record's width.
  function emit(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) { columns = fields; return; }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: a record with no quote and no stray CR is its line's comma split.
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? n : nl;
    const seg = text.slice(pos, end);
    if (seg.indexOf('"') === -1) {
      const crAt = seg.indexOf('\r');
      if (crAt === -1 || (nl !== -1 && crAt === seg.length - 1)) {
        const body = crAt === seg.length - 1 ? seg.slice(0, -1) : seg;
        if (body.length === 0) {
          pos = nl === -1 ? n : nl + 1;
          if (nl !== -1) line += 1;
          continue;
        }
        emit(body.split(','));
        pos = nl === -1 ? n : nl + 1;
        if (nl !== -1) line += 1;
        continue;
      }
    }

    // Slow path: the record holds a quote or a stray CR; read it field by field.
    const fields = [];
    let ended = END;
    let quoted = false;
    do {
      let value;
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        const open = pos;
        const openLine = line;
        pos += 1;
        let q = text.indexOf('"', pos);
        let doubled = false;
        while (q !== -1 && text.charCodeAt(q + 1) === 34) { doubled = true; q = text.indexOf('"', q + 2); }
        if (q === -1) {
          // The quote never closes: it is a literal character, and the text after it
          // is read again as unquoted.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          pos = open + 1;
          line = openLine;
          readUnquoted('"');
          value = uqVal; ended = uqEnd;
        } else {
          const raw = text.slice(pos, q);
          if (!doubled && raw.indexOf('\n') === -1 && raw.indexOf('\r') === -1) {
            value = raw;
          } else {
            const br = raw.match(/\r\n?|\n/g);
            if (br) line += br.length;
            value = raw.replace(/""/g, '"').replace(/\r\n?/g, '\n');
          }
          pos = q + 1;
          if (pos >= n) {
            ended = END;
          } else {
            const c = text.charCodeAt(pos);
            if (c === 44) { pos += 1; ended = COMMA; }
            else if (c === 10) { pos += 1; line += 1; ended = LINE_BREAK; }
            else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; ended = LINE_BREAK; }
            else {
              // What follows the closing quote is appended as it stands.
              readUnquoted(value);
              value = uqVal; ended = uqEnd;
              if (uqAdd > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
            }
          }
        }
      } else {
        quoted = false;
        readUnquoted('');
        value = uqVal; ended = uqEnd;
      }
      fields.push(value);
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    emit(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
