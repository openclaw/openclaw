// Pure URI parsing shared by output extraction and native media resolution.
type MediaReferenceErrorCode = "invalid-path" | "path-not-allowed";

/** Error raised when a media reference cannot be mapped to an allowed local media file. */
export class MediaReferenceError extends Error {
  code: MediaReferenceErrorCode;

  constructor(code: MediaReferenceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "MediaReferenceError";
  }
}

type InboundMediaUri = {
  id: string;
  normalizedSource: string;
};

/** Strips legacy MEDIA: prefixes while preserving canonical media:// references. */
export function normalizeMediaReferenceSource(source: string): string {
  const trimmed = source.trim();
  if (/^media:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return trimmed.replace(/^\s*MEDIA\s*:\s*/i, "").trim();
}

/** Parses canonical inbound media-store URIs and rejects nested or cross-bucket references. */
export function parseInboundMediaUri(source: string): InboundMediaUri | null {
  const normalizedSource = normalizeMediaReferenceSource(source);
  if (!/^media:\/\//i.test(normalizedSource)) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(normalizedSource);
  } catch (err) {
    throw new MediaReferenceError("invalid-path", `Invalid media URI: ${normalizedSource}`, {
      cause: err,
    });
  }

  if (parsed.hostname !== "inbound") {
    throw new MediaReferenceError(
      "path-not-allowed",
      `Unsupported media URI location: ${parsed.hostname || "(missing)"}`,
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new MediaReferenceError("invalid-path", `Invalid media URI: ${normalizedSource}`);
  }

  let id: string;
  try {
    id = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  } catch (err) {
    throw new MediaReferenceError("invalid-path", `Invalid media URI: ${normalizedSource}`, {
      cause: err,
    });
  }

  const invalidId = !id || id === "." || id === "..";
  if (invalidId || id.includes("/") || id.includes("\\") || id.includes("\0")) {
    throw new MediaReferenceError("invalid-path", `Invalid media URI: ${normalizedSource}`);
  }

  return {
    id,
    normalizedSource,
  };
}
