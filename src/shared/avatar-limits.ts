// Browser-safe avatar payload limits shared by state, Gateway, and Control UI projections.

// Profile persistence has a smaller, raster-only contract than general avatar rendering.
export const MAX_USER_PROFILE_AVATAR_BYTES = 512 * 1024;
export const USER_PROFILE_AVATAR_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

/** Maximum avatar payload size accepted by local file and Gateway upload paths. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

// SVG has the longest MIME prefix among supported local avatar formats.
const MAX_AVATAR_DATA_URL_PREFIX_LENGTH = "data:image/svg+xml;base64,".length;

/** Maximum encoded length of a supported local avatar at AVATAR_MAX_BYTES. */
export const AVATAR_MAX_DATA_URL_CHARS =
  Math.ceil(AVATAR_MAX_BYTES / 3) * 4 + MAX_AVATAR_DATA_URL_PREFIX_LENGTH;

const AVATAR_IMAGE_DATA_URL_RE = /^data:image\//i;

/** Avatar images render only as <img>; preserve the existing image/* data URL contract. */
export function isAvatarImageMimeType(value: string): boolean {
  return /^image\//i.test(value);
}

/** Accepts image data URLs that fit the Gateway and Control UI payload boundary. */
export function isRenderableAvatarImageDataUrl(value: string): boolean {
  return value.length <= AVATAR_MAX_DATA_URL_CHARS && AVATAR_IMAGE_DATA_URL_RE.test(value);
}
