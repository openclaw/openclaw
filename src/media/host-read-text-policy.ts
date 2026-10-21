// file-type returns undefined (no magic bytes) for plain-text formats like CSV,
// Markdown, TXT, JSON, and YAML, so host-read needs an explicit "this really
// decodes as text" fallback.
export const HOST_READ_TEXT_PLAIN_ALIASES = new Set([
  "text/csv",
  "text/markdown",
  "text/plain",
  "application/json",
  "text/x-sql",
  "application/sql",
  "application/yaml",
]);

function textPrintableRatio(text: string): number {
  let printable = 0;
  let total = 0;
  for (const char of text) {
    total += 1;
    const code = char.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && (code < 0x7f || code > 0x9f))) {
      printable += 1;
    }
  }
  return total === 0 ? 0 : printable / total;
}

function hasSingleByteTextShape(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return true;
  }
  let asciiText = 0;
  let control = 0;
  for (const byte of buffer) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 0x20 && byte <= 0x7e)) {
      asciiText += 1;
      continue;
    }
    if (byte < 0x20 || byte === 0x7f) {
      control += 1;
    }
  }
  const total = buffer.length;
  const highBytes = total - asciiText - control;
  return control === 0 && asciiText / total >= 0.7 && highBytes / total <= 0.3;
}

function decodeHostReadText(buffer: Buffer): string | undefined {
  // UTF-16 decoding is intentionally omitted: TextDecoder("utf-16le/be") never throws on
  // arbitrary byte pairs, so every byte pair is a valid (if meaningless) Unicode scalar —
  // an attacker can prepend a BOM and get a printable ratio near 1.0 on pure
  // binary garbage. The Latin-1 path below already covers the most common non-UTF-8
  // real-world case (Excel CSV exports with accented chars like é, ñ) while remaining
  // safe because hasSingleByteTextShape gates on byte shape *before* any decode.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    if (!hasSingleByteTextShape(buffer)) {
      return undefined;
    }
    // WHATWG latin1 decodes common Excel-style single-byte exports via Windows-1252 mapping.
    return new TextDecoder("latin1").decode(buffer);
  }
}

export function getValidatedHostReadText(buffer?: Buffer): string | undefined {
  if (!buffer) {
    return undefined;
  }
  if (buffer.length === 0) {
    return "";
  }
  const text = decodeHostReadText(buffer);
  if (text === undefined) {
    return undefined;
  }
  return textPrintableRatio(text) > 0.95 ? text : undefined;
}
