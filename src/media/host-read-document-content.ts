import { getFileExtension, normalizeMimeType } from "@openclaw/media-core/mime";

function getTextStats(text: string): { printableRatio: number } {
  if (!text) {
    return { printableRatio: 0 };
  }
  let printable = 0;
  let control = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13 || code === 32) {
      printable += 1;
      continue;
    }
    if (code < 32 || (code >= 0x7f && code <= 0x9f)) {
      control += 1;
      continue;
    }
    printable += 1;
  }
  const total = printable + control;
  if (total === 0) {
    return { printableRatio: 0 };
  }
  return { printableRatio: printable / total };
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
  if (buffer.length === 0) {
    return "";
  }
  // UTF-16 decoding is intentionally omitted: TextDecoder("utf-16le/be") never throws on
  // arbitrary byte pairs, so every byte pair is a valid (if meaningless) Unicode scalar —
  // an attacker can prepend a BOM and pass getTextStats with printableRatio≈1.0 on pure
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
  const { printableRatio } = getTextStats(text);
  return printableRatio > 0.95 ? text : undefined;
}

// FictionBook documents carry a fixed namespace on their root element. Match only that
// root (after an optional BOM, XML declaration, comments, or doctype) so host-read
// accepts demonstrable FictionBook content rather than every text-valid XML file.
const FICTIONBOOK_ROOT_RE =
  /^\uFEFF?(?:\s*(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>))*\s*<(?:(?<prefix>[A-Za-z_][\w.-]*):)?FictionBook(?=[\s/>])(?<attributes>[^>]*)>/u;
const FICTIONBOOK_NAMESPACE = "http://www.gribuser.ru/xml/fictionbook/2.0";
const XML_ROOT_ATTRIBUTE_RE =
  /\s+(?<name>[A-Za-z_:][\w:.-]*)\s*=\s*(?<quote>["'])(?<value>[\s\S]*?)\k<quote>/guy;

function readXmlRootAttribute(attributes: string, name: string): string | undefined {
  let cursor = 0;
  let value: string | undefined;
  while (cursor < attributes.length) {
    XML_ROOT_ATTRIBUTE_RE.lastIndex = cursor;
    const attribute = XML_ROOT_ATTRIBUTE_RE.exec(attributes);
    if (!attribute) {
      break;
    }
    cursor = XML_ROOT_ATTRIBUTE_RE.lastIndex;
    if (attribute.groups?.name !== name) {
      continue;
    }
    if (value !== undefined) {
      return undefined;
    }
    value = attribute.groups.value;
  }
  return /^\s*\/?\s*$/u.test(attributes.slice(cursor)) ? value : undefined;
}

function hasFictionBookDocumentShape(text: string): boolean {
  const root = FICTIONBOOK_ROOT_RE.exec(text.slice(0, 8192));
  if (!root) {
    return false;
  }
  const rootPrefix = root.groups?.prefix;
  const namespaceAttribute = rootPrefix ? `xmlns:${rootPrefix}` : "xmlns";
  return (
    readXmlRootAttribute(root.groups?.attributes ?? "", namespaceAttribute) ===
    FICTIONBOOK_NAMESPACE
  );
}

export function isAllowedHostReadFictionBook(params: {
  sniffedContentType?: string;
  filePath?: string;
  buffer?: Buffer;
}): boolean {
  const sniffedMime = normalizeMimeType(params.sniffedContentType);
  if (sniffedMime && sniffedMime !== "application/xml" && sniffedMime !== "text/xml") {
    return false;
  }
  if (![".fb2", ".xml"].includes(getFileExtension(params.filePath) ?? "")) {
    return false;
  }
  // The extension only signals operator intent; the accept decision is content-based for
  // both .fb2 and .xml so the host-read boundary stays format-specific.
  const text = getValidatedHostReadText(params.buffer);
  return text !== undefined && hasFictionBookDocumentShape(text);
}
