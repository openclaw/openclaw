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
  "image/tiff": ".tiff",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/flac": ".flac",
  "audio/aac": ".aac",
  "audio/opus": ".opus",
  "audio/x-m4a": ".m4a",
  "audio/mp4": ".m4a",
  "audio/webm": ".webm",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/avi": ".avi",
  "video/x-matroska": ".mkv",
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
  "text/javascript": ".js",
  "text/typescript": ".ts",
  "application/xml": ".xml",
  "application/javascript": ".js",
  "application/typescript": ".ts",
  "application/yaml": ".yaml",
  "application/x-yaml": ".yml",
};

const MIME_BY_EXT: Record<string, string> = {
  ...Object.fromEntries(Object.entries(EXT_BY_MIME).map(([mime, ext]) => [ext, mime])),
  // Additional extension aliases
  ".jpeg": "image/jpeg",
  ".js": "text/javascript",
  ".htm": "text/html",
  ".xml": "text/xml",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".yaml": "application/yaml",
  ".yml": "application/x-yaml",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".avi": "video/avi",
  ".mkv": "video/x-matroska",
  ".ts": "text/typescript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
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
  ".webm",
]);

const IMAGE_FILE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".heic",
  ".heif",
  ".tiff",
  ".tif",
  ".svg",
  ".bmp",
]);

const VIDEO_FILE_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".webm",
  ".avi",
  ".mkv",
]);

const DOCUMENT_FILE_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".txt",
  ".md",
  ".csv",
  ".html",
  ".htm",
  ".xml",
  ".json",
  ".yaml",
  ".yml",
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

export function isImageFileName(fileName?: string | null): boolean {
  const ext = getFileExtension(fileName);
  if (!ext) {
    return false;
  }
  return IMAGE_FILE_EXTENSIONS.has(ext);
}

export function isVideoFileName(fileName?: string | null): boolean {
  const ext = getFileExtension(fileName);
  if (!ext) {
    return false;
  }
  return VIDEO_FILE_EXTENSIONS.has(ext);
}

export function isDocumentFileName(fileName?: string | null): boolean {
  const ext = getFileExtension(fileName);
  if (!ext) {
    return false;
  }
  return DOCUMENT_FILE_EXTENSIONS.has(ext);
}

export function isImageMime(mime?: string | null): boolean {
  const normalized = normalizeMimeType(mime);
  return normalized !== undefined && normalized.startsWith("image/");
}

export function isVideoMime(mime?: string | null): boolean {
  const normalized = normalizeMimeType(mime);
  return normalized !== undefined && normalized.startsWith("video/");
}

export function isAudioMime(mime?: string | null): boolean {
  const normalized = normalizeMimeType(mime);
  return normalized !== undefined && normalized.startsWith("audio/");
}

export function isDocumentMime(mime?: string | null): boolean {
  const normalized = normalizeMimeType(mime);
  if (!normalized) return false;
  return normalized === "application/pdf" || 
         normalized.startsWith("text/") || 
         (normalized.startsWith("application/") && !normalized.startsWith("application/octet-stream"));
}
