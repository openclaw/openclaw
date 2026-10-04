// Browser raster previews and top-level image blobs share this vocabulary.
// Native previews, avatars, and provider inputs have separate format policies.
export const BROWSER_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
