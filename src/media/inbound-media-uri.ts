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

  // `new URL` reports hostname "inbound" for inbound:, inbound:123, user@inbound and
  // user:pw@inbound:9 alike, so no combination of parsed fields separates them from the
  // canonical spelling: a bare colon sets no port at all. The grounding matcher keys on
  // the exact portless root and would not redact any of those forms, leaving a reference
  // that still resolves here. Compare the raw authority instead; this scheme names no
  // network location, so userinfo and ports are never valid.
  const rawAuthority = normalizedSource.slice("media://".length).split(/[/?#]/u, 1)[0] ?? "";
  if (parsed.hostname !== "inbound" || rawAuthority !== "inbound") {
    throw new MediaReferenceError(
      "path-not-allowed",
      `Unsupported media URI location: ${rawAuthority || "(missing)"}`,
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
