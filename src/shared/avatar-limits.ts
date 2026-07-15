// Browser-safe avatar payload limits shared by Gateway and Control UI projections.

/** Maximum avatar payload size accepted by local file and Gateway upload paths. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

// SVG has the longest MIME prefix among supported local avatar formats.
const MAX_AVATAR_DATA_URL_PREFIX_LENGTH = "data:image/svg+xml;base64,".length;

/** Maximum encoded byte length of a supported local avatar at AVATAR_MAX_BYTES. */
export const AVATAR_MAX_DATA_URL_CHARS =
  Math.ceil(AVATAR_MAX_BYTES / 3) * 4 + MAX_AVATAR_DATA_URL_PREFIX_LENGTH;

const AVATAR_IMAGE_DATA_URL_RE = /^data:image\//i;


/** Returns the UTF-8 byte length of a string. Works in browsers and Node.js. */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Accepts image data URLs that fit the Gateway and Control UI payload boundary. */
export function isRenderableAvatarImageDataUrl(value: string): boolean {
  // Fast rejection: UTF-16 length is a lower bound for UTF-8 byte length.
  // Reject obviously oversized strings before the full UTF-8 encoding.
  if (value.length > AVATAR_MAX_DATA_URL_CHARS) return false;
  return utf8ByteLength(value) <= AVATAR_MAX_DATA_URL_CHARS && AVATAR_IMAGE_DATA_URL_RE.test(value);
}
