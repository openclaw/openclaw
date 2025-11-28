import path from "node:path";

import { type MediaKind, mediaKindFromMime } from "./constants.js";

// Map common mimes to preferred file extensions.
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "video/mp4": ".mp4",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
};

const MIME_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_BY_MIME).map(([mime, ext]) => [ext, mime]),
);

function normalizeHeaderMime(mime?: string | null): string | undefined {
  if (!mime) return undefined;
  const cleaned = mime.split(";")[0]?.trim().toLowerCase();
  return cleaned || undefined;
}

function sniffMime(buffer?: Buffer): string | undefined {
  if (!buffer || buffer.length < 4) return undefined;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  // GIF: GIF87a / GIF89a
  if (buffer.length >= 6) {
    const sig = buffer.subarray(0, 6).toString("ascii");
    if (sig === "GIF87a" || sig === "GIF89a") return "image/gif";
  }

  // WebP: RIFF....WEBP
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  // PDF: %PDF-
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }

  // Ogg / Opus: OggS
  if (buffer.subarray(0, 4).toString("ascii") === "OggS") {
    return "audio/ogg";
  }

  // MP3: ID3 tag or frame sync FF E0+.
  if (buffer.subarray(0, 3).toString("ascii") === "ID3") {
    return "audio/mpeg";
  }
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
    return "audio/mpeg";
  }

  // MP4: "ftyp" at offset 4.
  if (
    buffer.length >= 12 &&
    buffer.subarray(4, 8).toString("ascii") === "ftyp"
  ) {
    return "video/mp4";
  }

  return undefined;
}

function extFromPath(filePath?: string): string | undefined {
  if (!filePath) return undefined;
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

export function detectMime(opts: {
  buffer?: Buffer;
  headerMime?: string | null;
  filePath?: string;
}): string | undefined {
  const sniffed = sniffMime(opts.buffer);
  if (sniffed) return sniffed;

  const headerMime = normalizeHeaderMime(opts.headerMime);
  if (headerMime) return headerMime;

  const ext = extFromPath(opts.filePath);
  if (ext && MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];

  return undefined;
}

export function extensionForMime(mime?: string | null): string | undefined {
  if (!mime) return undefined;
  return EXT_BY_MIME[mime.toLowerCase()];
}

export function kindFromMime(mime?: string | null): MediaKind {
  return mediaKindFromMime(mime);
}
