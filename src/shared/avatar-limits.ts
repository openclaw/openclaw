// Browser-safe avatar payload limits shared by Gateway and Control UI projections.

/** Maximum avatar payload size accepted by local file and Gateway upload paths. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

// SVG has the longest MIME prefix among supported local avatar formats.
const MAX_AVATAR_DATA_URL_PREFIX_LENGTH = "data:image/svg+xml;base64,".length;

/** Maximum encoded length of a supported local avatar at AVATAR_MAX_BYTES. */
export const AVATAR_MAX_DATA_URL_CHARS =
  Math.ceil(AVATAR_MAX_BYTES / 3) * 4 + MAX_AVATAR_DATA_URL_PREFIX_LENGTH;

const AVATAR_IMAGE_DATA_URL_RE = /^data:image\//i;


/** Supported image MIME types for avatar data URLs, matching formats recognized by AVATAR_MIME_BY_EXT. */
export const AVATAR_ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/x-icon",
  "image/tiff",
  "image/bmp",
]);

/** Returns true when the MIME type is an allowed avatar image format. */
export function isAllowedAvatarMimeType(mime: string): boolean {
  return AVATAR_ALLOWED_MIME_TYPES.has(mime);
}

/** Extract MIME type from a data URL. Returns undefined when the format is unrecognizable. */
function extractDataUrlMime(value: string): string | undefined {
  const afterData = value.slice("data:".length);
  const mimeEnd = afterData.indexOf(";") !== -1 ? afterData.indexOf(";") : afterData.indexOf(",");
  if (mimeEnd === -1) return undefined;
  return afterData.slice(0, mimeEnd);
}

/** Accepts image data URLs that fit the Gateway and Control UI payload boundary. */
export function isRenderableAvatarImageDataUrl(value: string): boolean {
  if (value.length > AVATAR_MAX_DATA_URL_CHARS) return false;
  if (!AVATAR_IMAGE_DATA_URL_RE.test(value)) return false;
  const mime = extractDataUrlMime(value);
  return mime !== undefined && isAllowedAvatarMimeType(mime);
}