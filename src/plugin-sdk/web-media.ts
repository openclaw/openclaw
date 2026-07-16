/**
 * Public SDK subpath for loading and optimizing local or remote web media.
 */
export {
  getDefaultLocalRoots,
  LocalMediaAccessError,
  MediaSizeLimitError,
  loadWebMedia,
  loadWebMediaRaw,
  optimizeImageToJpeg,
  optimizeImageToPng,
  type WebMediaResult,
} from "../media/web-media.js";
export type { LocalMediaAccessErrorCode } from "../media/web-media.js";
export { MediaFetchError } from "../media/fetch.js";
