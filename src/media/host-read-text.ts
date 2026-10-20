import { getFileExtension } from "@openclaw/media-core/mime";

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

function decodeHostReadCsv(buffer: Buffer, filePath?: string): string | undefined {
  if (getFileExtension(filePath) !== ".csv") {
    return undefined;
  }
  let text: string;
  try {
    // WHATWG shift_jis includes the Windows-31J (CP932) Excel export mappings.
    text = new TextDecoder("shift_jis", { fatal: true }).decode(buffer);
  } catch {
    return undefined;
  }
  // Decoding alone is insufficient: many binary byte pairs are valid Shift JIS.
  // Require printable, rectangular CSV records before admitting this fallback.
  if (textPrintableRatio(text) !== 1 || hasHtmlDocumentShape(text)) {
    return undefined;
  }
  let state: "start" | "plain" | "quoted" | "closed" = "start";
  let columns = 1;
  let width = 0;
  let rows = 0;
  for (let index = 0; index <= text.length; index += 1) {
    const char = text[index];
    if (state === "quoted") {
      if (char === undefined) {
        return undefined;
      }
      if (char === '"') {
        if (text[index + 1] === '"') {
          index += 1;
        } else {
          state = "closed";
        }
      }
      continue;
    }
    if (char === undefined || char === "\r" || char === "\n") {
      if (char === undefined && columns === 1 && state === "start") {
        break;
      }
      width ||= columns;
      if (columns < 2 || columns !== width) {
        return undefined;
      }
      rows += 1;
      columns = 1;
      state = "start";
      if (char === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
    } else if (char === ",") {
      columns += 1;
      state = "start";
    } else if (char === '"' && state === "start") {
      state = "quoted";
    } else if (char === '"' || state === "closed") {
      return undefined;
    } else {
      state = "plain";
    }
  }
  return rows >= 2 ? text : undefined;
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

export function getValidatedHostReadText(buffer?: Buffer, filePath?: string): string | undefined {
  if (!buffer) {
    return undefined;
  }
  if (buffer.length === 0) {
    return "";
  }
  const text = decodeHostReadText(buffer);
  if (text !== undefined && textPrintableRatio(text) > 0.95) {
    return text;
  }
  return decodeHostReadCsv(buffer, filePath);
}

export function hasHtmlDocumentShape(text: string): boolean {
  const sample = text.trimStart().slice(0, 8192);
  return /^(?:<!doctype\s+html\b|<html\b)/iu.test(sample) || /<\/(?:html|body)>/iu.test(sample);
}
