import path from "node:path";
import { fileTypeFromBuffer } from "file-type";
import { type MediaKind, mediaKindFromMime } from "./constants.js";

// Map common mimes to preferred file extensions.
const EXT_BY_MIME: Record<string, string> = {
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/flac": ".flac",
  "audio/aac": ".aac",
  "audio/opus": ".opus",
  "audio/x-m4a": ".m4a",
  "audio/mp4": ".m4a",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "application/pdf": ".pdf",
  "application/json": ".json",
  "application/zip": ".zip",
  "application/gzip": ".gz",
  "application/x-tar": ".tar",
  "application/x-7z-compressed": ".7z",
  "application/vnd.rar": ".rar",
  "application/msword": ".doc",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "text/csv": ".csv",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/html": ".html",
  "text/xml": ".xml",
  "text/css": ".css",
  "application/xml": ".xml",
};

const MIME_BY_EXT: Record<string, string> = {
  ...Object.fromEntries(Object.entries(EXT_BY_MIME).map(([mime, ext]) => [ext, mime])),
  // Additional extension aliases
  ".jpeg": "image/jpeg",
  ".js": "text/javascript",
  ".htm": "text/html",
  ".xml": "text/xml",
};

const AUDIO_FILE_EXTENSIONS = new Set([
  ".aac",
  ".caf",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
]);

export function normalizeMimeType(mime?: string | null): string | undefined {
  if (!mime) {
    return undefined;
  }
  const cleaned = mime.split(";")[0]?.trim().toLowerCase();
  return cleaned || undefined;
}

async function sniffMime(buffer?: Buffer): Promise<string | undefined> {
  if (!buffer) {
    return undefined;
  }
  try {
    const type = await fileTypeFromBuffer(buffer);
    return type?.mime ?? undefined;
  } catch {
    return undefined;
  }
}

export function getFileExtension(filePath?: string | null): string | undefined {
  if (!filePath) {
    return undefined;
  }
  try {
    if (/^https?:\/\//i.test(filePath)) {
      const url = new URL(filePath);
      return path.extname(url.pathname).toLowerCase() || undefined;
    }
  } catch {
    // fall back to plain path parsing
  }
  const ext = path.extname(filePath).toLowerCase();
  return ext || undefined;
}

export function mimeTypeFromFilePath(filePath?: string | null): string | undefined {
  const ext = getFileExtension(filePath);
  if (!ext) {
    return undefined;
  }
  return MIME_BY_EXT[ext];
}

export function isAudioFileName(fileName?: string | null): boolean {
  const ext = getFileExtension(fileName);
  if (!ext) {
    return false;
  }
  return AUDIO_FILE_EXTENSIONS.has(ext);
}

/**
 * Determines whether a media payload qualifies as a verified audio source
 * for voice-note delivery.
 */
export function isVerifiedAudioSource(media: {
  kind?: string | null;
  contentType?: string | null;
}): boolean {
  if (media.kind === "audio") {
    return true;
  }
  // Normalize through sanitizeMediaMime before classifying audio content.
  const sanitized = sanitizeMediaMime(media.contentType);
  return sanitized?.startsWith("audio/") === true;
}

/**
 * Validates and normalizes a MIME type for outbound media headers.
 * Returns null when the input is unsafe or malformed.
 */
// Reject ASCII control characters (U+0000-U+001F) and DEL (U+007F) to avoid
// downstream header injection (CWE-93). Implemented via charCodeAt instead of
// a control-character regex to keep the intent explicit and to avoid the
// no-control-regex lint rule.
function hasAsciiControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function sanitizeMediaMime(
  input: string | null | undefined,
  options?: { preserveCodecsParam?: boolean },
): string | null {
  if (input == null) {
    return null;
  }
  const value = input.trim();
  if (!value) {
    return null;
  }

  if (hasAsciiControlChar(value)) {
    return null;
  }

  const parts = value.split(";");
  const base = parts[0]?.trim().toLowerCase() ?? "";
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(base)) {
    return null;
  }

  if (options?.preserveCodecsParam && parts.length > 1) {
    const codecsParam = parts
      .slice(1)
      .map((part) => part.trim().toLowerCase())
      .find((part) => /^codecs=[a-z0-9._-]+$/.test(part));
    if (codecsParam) {
      return `${base}; ${codecsParam}`;
    }
  }

  return base;
}

// Unicode bidirectional and invisible format characters that can be used for
// filename UI spoofing (RTLO trick and similar).
const BIDI_AND_INVISIBLE_CHARS = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g;

/**
 * Sanitizes an outbound document filename for safe use in downstream payloads.
 * Strips ASCII control characters and Unicode bidirectional/invisible format
 * characters, replaces path separators and quotes, caps length at 128 chars,
 * and falls back to "file" when empty.
 *
 * The bidi-stripping prevents UI spoofing via right-to-left override (RTLO,
 * U+202E) and related directional formatting characters.
 * Linear time complexity: the loop bounds itself by min(input length, 128)
 * to avoid O(n^2) build cost on attacker-controlled large filenames.
 */
export function sanitizeFileName(input: string | null | undefined): string {
  const trimmed = (input ?? "").trim().replace(BIDI_AND_INVISIBLE_CHARS, "");
  if (!trimmed) {
    return "file";
  }

  const out: string[] = [];
  for (let i = 0; i < trimmed.length && out.length < 128; i += 1) {
    const ch = trimmed[i];
    if (!ch) {
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      continue;
    }
    out.push(ch === "/" || ch === "\\" || ch === '"' ? "_" : ch);
  }
  const safe = out.join("");
  return safe || "file";
}

export function detectMime(opts: {
  buffer?: Buffer;
  headerMime?: string | null;
  filePath?: string;
}): Promise<string | undefined> {
  return detectMimeImpl(opts);
}

function isGenericMime(mime?: string): boolean {
  if (!mime) {
    return true;
  }
  const m = mime.toLowerCase();
  return m === "application/octet-stream" || m === "application/zip";
}

async function detectMimeImpl(opts: {
  buffer?: Buffer;
  headerMime?: string | null;
  filePath?: string;
}): Promise<string | undefined> {
  const ext = getFileExtension(opts.filePath);
  const extMime = ext ? MIME_BY_EXT[ext] : undefined;

  const headerMime = normalizeMimeType(opts.headerMime);
  const sniffed = await sniffMime(opts.buffer);

  // Prefer sniffed types, but don't let generic container types override a more
  // specific extension mapping (e.g. XLSX vs ZIP).
  if (sniffed && (!isGenericMime(sniffed) || !extMime)) {
    return sniffed;
  }
  if (extMime) {
    return extMime;
  }
  if (headerMime && !isGenericMime(headerMime)) {
    return headerMime;
  }
  if (sniffed) {
    return sniffed;
  }
  if (headerMime) {
    return headerMime;
  }

  return undefined;
}

export function extensionForMime(mime?: string | null): string | undefined {
  const normalized = normalizeMimeType(mime);
  if (!normalized) {
    return undefined;
  }
  return EXT_BY_MIME[normalized];
}

export function isGifMedia(opts: {
  contentType?: string | null;
  fileName?: string | null;
}): boolean {
  if (opts.contentType?.toLowerCase() === "image/gif") {
    return true;
  }
  const ext = getFileExtension(opts.fileName);
  return ext === ".gif";
}

export function imageMimeFromFormat(format?: string | null): string | undefined {
  if (!format) {
    return undefined;
  }
  switch (format.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "heic":
      return "image/heic";
    case "heif":
      return "image/heif";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return undefined;
  }
}

export function kindFromMime(mime?: string | null): MediaKind | undefined {
  return mediaKindFromMime(normalizeMimeType(mime));
}
