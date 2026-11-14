/** Format admission for host-readable media; file access remains with the read owner. */
import { createHash } from "node:crypto";
import type { MediaKind } from "@openclaw/media-core/constants";
import {
  getFileExtension,
  kindFromMime,
  mimeTypeFromFilePath,
  normalizeMimeType,
} from "@openclaw/media-core/mime";
import { HostReadMediaTypeError } from "./local-media-access.js";

// file-type returns undefined (no magic bytes) for plain-text formats like CSV,
// Markdown, TXT, JSON, and YAML, so host-read needs an explicit "this really
// decodes as text" fallback.
const HOST_READ_TEXT_PLAIN_ALIASES = new Set([
  "text/csv",
  "text/markdown",
  "text/plain",
  "application/json",
  "application/yaml",
]);
const HOST_READ_ALLOWED_DOCUMENT_MIMES = new Set([
  "application/msword",
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/gzip",
  "application/x-7z-compressed",
  "application/x-tar",
  "application/zip",
  ...HOST_READ_TEXT_PLAIN_ALIASES,
]);
// HTML needs generated-output provenance or an explicit publication operation;
// extension-declared .html must never fall through to binary/media sniffing.
const HOST_READ_DECLARED_TEXT_MIMES = new Set([...HOST_READ_TEXT_PLAIN_ALIASES, "text/html"]);
export const HOST_READ_DECLARED_TEXT_ERROR =
  "hostReadCapability permits only validated plain-text documents " +
  "and validated HTML reports with generated provenance or explicit publication for local reads";

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

function getValidatedHostReadText(buffer?: Buffer): string | undefined {
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

function hasHtmlDocumentShape(text: string): boolean {
  const sample = text.trimStart().slice(0, 8192);
  return /^(?:<!doctype\s+html\b|<html\b)/iu.test(sample) || /<\/(?:html|body)>/iu.test(sample);
}

export type HostReadHtmlTrust =
  | { source: "temp-root" }
  | { source: "outbound"; expectedSha256: string; expectedSize: number };

function isAllowedHostReadHtml(params: {
  sniffedContentType?: string;
  buffer?: Buffer;
  trustedGeneratedHtmlPath?: HostReadHtmlTrust;
  explicitHtmlPublication?: boolean;
}): boolean {
  const sniffedMime = normalizeMimeType(params.sniffedContentType);
  if (sniffedMime && sniffedMime !== "text/html") {
    return false;
  }
  if (!params.trustedGeneratedHtmlPath && !params.explicitHtmlPublication) {
    return false;
  }
  const text = getValidatedHostReadText(params.buffer);
  if (text === undefined || !hasHtmlDocumentShape(text)) {
    return false;
  }
  if (params.explicitHtmlPublication || params.trustedGeneratedHtmlPath?.source === "temp-root") {
    return true;
  }
  return (
    params.trustedGeneratedHtmlPath?.source === "outbound" &&
    params.buffer?.length === params.trustedGeneratedHtmlPath.expectedSize &&
    createHash("sha256").update(params.buffer).digest("hex") ===
      params.trustedGeneratedHtmlPath.expectedSha256
  );
}

function isAllowedHostReadTextAlias(mime: string | undefined, filePath?: string): boolean {
  if (!mime || !HOST_READ_TEXT_PLAIN_ALIASES.has(mime)) {
    return false;
  }
  return mime !== "text/plain" || getFileExtension(filePath) === ".txt";
}

export function assertHostReadMediaAllowed(params: {
  sniffedContentType?: string;
  contentType?: string;
  filePath?: string;
  kind: MediaKind | undefined;
  buffer?: Buffer;
  trustedGeneratedHtmlPath?: HostReadHtmlTrust;
  explicitHtmlPublication?: boolean;
}): void {
  const declaredMime = normalizeMimeType(mimeTypeFromFilePath(params.filePath));
  const normalizedMime = normalizeMimeType(params.contentType);
  // For extension-declared plain-text aliases such as .csv/.html/.md, trust only the
  // text validator path. Some opaque blobs can still produce bogus binary MIME
  // hits (for example BOM-prefixed 0xFF data sniffing as audio/mpeg), and
  // host-read should reject those instead of returning early on the sniff.
  if (declaredMime && HOST_READ_DECLARED_TEXT_MIMES.has(declaredMime)) {
    if (
      declaredMime === "text/html" &&
      isAllowedHostReadHtml({
        sniffedContentType: params.sniffedContentType,
        buffer: params.buffer,
        trustedGeneratedHtmlPath: params.trustedGeneratedHtmlPath,
        explicitHtmlPublication: params.explicitHtmlPublication,
      })
    ) {
      return;
    }
    if (
      isAllowedHostReadTextAlias(declaredMime, params.filePath) &&
      !params.sniffedContentType &&
      params.buffer &&
      getValidatedHostReadText(params.buffer) !== undefined
    ) {
      return;
    }
    throw new HostReadMediaTypeError(HOST_READ_DECLARED_TEXT_ERROR);
  }
  const sniffedKind = kindFromMime(params.sniffedContentType);
  if (sniffedKind === "image" || sniffedKind === "audio" || sniffedKind === "video") {
    return;
  }
  const sniffedMime = normalizeMimeType(params.sniffedContentType);
  if (
    sniffedKind === "document" &&
    sniffedMime &&
    HOST_READ_ALLOWED_DOCUMENT_MIMES.has(sniffedMime)
  ) {
    return;
  }
  if (
    sniffedMime === "application/x-cfb" &&
    [".doc", ".ppt", ".xls"].includes(getFileExtension(params.filePath) ?? "")
  ) {
    return;
  }
  // Plain-text document exception: file-type v22 returns undefined (not "text/plain")
  // for text buffers that have no binary magic bytes. Allow these formats when:
  // - sniffedMime is undefined (no binary signature detected by file-type)
  // - The extension-derived MIME is an allowed text/document MIME (operator intent)
  // - The buffer decodes as actual text instead of opaque binary bytes
  if (
    !sniffedMime &&
    normalizedMime &&
    isAllowedHostReadTextAlias(normalizedMime, params.filePath) &&
    params.buffer &&
    getValidatedHostReadText(params.buffer) !== undefined
  ) {
    return;
  }
  if (
    params.kind === "document" &&
    normalizedMime &&
    HOST_READ_ALLOWED_DOCUMENT_MIMES.has(normalizedMime)
  ) {
    throw new HostReadMediaTypeError(
      `Host-local media sends require buffer-verified media/document types (got fallback ${normalizedMime}).`,
    );
  }
  throw new HostReadMediaTypeError(
    `Host-local media sends only allow buffer-verified images, audio, video, PDF, Office documents, archives, and validated plain-text documents (got ${sniffedMime ?? normalizedMime ?? "unknown"}).`,
  );
}
