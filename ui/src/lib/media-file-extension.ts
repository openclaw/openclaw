const SAME_ORIGIN_MEDIA_ROUTE_MARKERS = [
  "/__openclaw__/assistant-media",
  "/__openclaw__/media/",
  "/api/chat/media/outgoing/",
  "/media/inbound/",
];

function isSameOriginMediaRoute(value: string): boolean {
  return (
    value.startsWith("/") &&
    SAME_ORIGIN_MEDIA_ROUTE_MARKERS.some((marker) => value.includes(marker))
  );
}

/** Returns the final filename after decoding one URL path-segment layer. */
function getMediaFileName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const url =
    /^https?:\/\//i.test(trimmed) || isSameOriginMediaRoute(trimmed)
      ? URL.parse(trimmed, "https://openclaw.invalid")
      : null;
  if (!url) {
    return (trimmed.split(/[\\/]/).pop() ?? trimmed) || undefined;
  }
  let filename = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  try {
    // Match media-core: decode only the filename and keep encoded path
    // separators as filename data instead of turning them into boundaries.
    const decodable = filename.replace(/%2f/gi, "%252F").replace(/%5c/gi, "%255C");
    filename = decodeURIComponent(decodable);
  } catch {
    // Preserve the raw filename when its own percent encoding is malformed.
  }
  return filename || undefined;
}

/** Returns a lowercase extension without the leading dot. */
export function getMediaFileExtension(value: string): string | undefined {
  const filename = getMediaFileName(value);
  if (!filename) {
    return undefined;
  }
  return /\.([a-zA-Z0-9]+)$/.exec(filename)?.[1]?.toLowerCase();
}

const VIDEO_MEDIA_FILE_EXTENSIONS = new Set([
  "avi",
  "m4v",
  "mkv",
  "mov",
  "mp4",
  "mpeg",
  "mpg",
  "webm",
]);

export function hasVideoMediaFileExtension(value: string): boolean {
  const extension = getMediaFileExtension(value);
  return extension !== undefined && VIDEO_MEDIA_FILE_EXTENSIONS.has(extension);
}

function normalizeMediaType(mediaType: unknown): string {
  return typeof mediaType === "string" ? mediaType.trim().toLowerCase() : "";
}

export function isImageMediaPath(path: string, mediaType: unknown): boolean {
  const normalized = normalizeMediaType(mediaType);
  if (normalized && normalized !== "application/octet-stream") {
    return normalized.startsWith("image/");
  }
  const ext = getMediaFileExtension(path);
  return (
    ext !== undefined &&
    ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "heif", "avif"].includes(ext)
  );
}

export function isSvgImageMediaPath(path: string, mediaType: unknown): boolean {
  const normalizedMediaType =
    typeof mediaType === "string" ? mediaType.split(";", 1)[0]?.trim().toLowerCase() : "";
  return normalizedMediaType === "image/svg+xml" || getMediaFileExtension(path) === "svg";
}

export function isAudioTranscriptMediaPath(path: string, mediaType: unknown): boolean {
  if (normalizeMediaType(mediaType).startsWith("audio/")) {
    return true;
  }
  const ext = getMediaFileExtension(path);
  return (
    ext !== undefined &&
    ["aac", "flac", "m2a", "m4a", "mp3", "oga", "ogg", "opus", "wav"].includes(ext)
  );
}

export function isVideoTranscriptMediaPath(path: string, mediaType: unknown): boolean {
  return normalizeMediaType(mediaType).startsWith("video/") || hasVideoMediaFileExtension(path);
}

// Collision-safe managed inbound URIs store the original filename plus a
// terminal "---<uuid>" storage suffix in the basename
// (e.g. media://inbound/report---<uuid>.pdf). Restore the original filename by
// removing only that final generated segment, so an original name that itself
// contains a "---<uuid>"-shaped part is preserved; the stored URI is unchanged.
const MANAGED_INBOUND_MEDIA_PREFIX = "media://inbound/";
const MANAGED_INBOUND_UUID_SUFFIX_PATTERN =
  /---[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\.[^./]*$|$)/i;

export function labelForMediaPath(mediaPath: string): string {
  const trimmed = mediaPath.trim();
  if (trimmed.startsWith(MANAGED_INBOUND_MEDIA_PREFIX)) {
    const basename = trimmed.split("/").pop()?.trim() || trimmed;
    return basename.replace(MANAGED_INBOUND_UUID_SUFFIX_PATTERN, "") || basename;
  }
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const parsed = new URL(trimmed);
      return getMediaFileName(trimmed)?.trim() || parsed.hostname || trimmed;
    }
  } catch {}
  return trimmed.split(/[\\/]/).pop()?.trim() || trimmed;
}
