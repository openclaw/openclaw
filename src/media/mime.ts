import path from "node:path";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { type MediaKind, mediaKindFromMime } from "./constants.js";

/** @internal */
export const FILE_TYPE_SNIFF_MAX_BYTES = 1024 * 1024;

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
  "audio/x-caf": ".caf",
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

const fileTypeModuleLoader = createLazyImportLoader(() => import("file-type"));

export function normalizeMimeType(mime?: string | null): string | undefined {
  if (!mime) {
    return undefined;
  }
  const cleaned = mime.split(";")[0]?.trim().toLowerCase();
  return cleaned || undefined;
}

/** @internal */
export function sliceMimeSniffBuffer(buffer: Buffer): Buffer {
  if (buffer.byteLength <= FILE_TYPE_SNIFF_MAX_BYTES) {
    return buffer;
  }
  return buffer.subarray(0, FILE_TYPE_SNIFF_MAX_BYTES);
}

async function sniffMime(buffer?: Buffer): Promise<string | undefined> {
  if (!buffer) {
    return undefined;
  }
  try {
    const { fileTypeFromBuffer } = await fileTypeModuleLoader.load();
    const type = await fileTypeFromBuffer(sliceMimeSniffBuffer(buffer));
    if (type?.mime) {
      return type.mime;
    }
  } catch {
    // fall through to manual magic-byte sniffs
  }
  return sniffKnownAudioMagic(buffer);
}

// Fallbacks for audio containers `file-type` doesn't recognize natively (e.g.
// Apple's CAF, used by iMessage voice memos when produced by `afconvert`).
// Without this the host-local-media validator drops these buffers as unknown
// binary blobs because the sniff returns undefined, even though the file is
// a valid audio container.
function sniffKnownAudioMagic(buffer: Buffer): string | undefined {
  if (buffer.byteLength >= 4 && buffer.toString("ascii", 0, 4) === "caff") {
    return "audio/x-caf";
  }
  return undefined;
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

/**
 * Returns true only when the caller-provided classified `kind` is `"audio"`.
 * Refuses to infer audio from filename or URL hints, and does not treat a
 * raw `contentType` starting with `audio/` as sufficient on its own. The
 * `contentType` field is kept on the parameter shape as a seam for a
 * future sniffed-MIME extension (e.g. via `detectMime`); it is not read
 * today.
 */
export function isVerifiedAudioSource(media: {
  kind?: string | null;
  contentType?: string | null;
}): boolean {
  return media.kind === "audio";
}

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

/**
 * Validates and normalizes a MIME type for outbound media headers.
 * Returns null when the input is unsafe or malformed. By default all
 * parameters are stripped; pass `preserveCodecsParam: true` to retain a
 * single `codecs=...` parameter when present.
 */
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
  // RFC 2045 token character set (US-ASCII printable minus SPACE, CTLs,
  // and tspecials). Broader than RFC 6838's restricted-name to avoid
  // false-null reject on valid vendor types like `application/vnd.x~v1+json`.
  if (!/^[a-z0-9!#$%&'*+.^_`|~-]+\/[a-z0-9!#$%&'*+.^_`|~-]+$/.test(base)) {
    return null;
  }

  if (options?.preserveCodecsParam && parts.length > 1) {
    // Accept common single-codec, comma-separated multi-codec, and matched
    // quoted-string forms (e.g. `codecs=opus`, `codecs=mp4a.40.2,opus`,
    // `codecs="avc1.42e01e,mp4a.40.2"`). Mismatched quotes, trailing
    // commas, semicolons inside the value, and unrelated parameters fall
    // through to the strip-all-parameters path.
    const codecsParam = parts
      .slice(1)
      .map((part) => part.trim().toLowerCase())
      .find((part) => /^codecs=("?)[a-z0-9._-]+(?:,[a-z0-9._-]+)*\1$/.test(part));
    if (codecsParam) {
      return `${base}; ${codecsParam}`;
    }
  }

  return base;
}
