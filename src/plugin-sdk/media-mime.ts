// Narrow media MIME helper surface for plugins that do not need the full media runtime.

export {
  detectMime,
  extensionForMime,
  getFileExtension,
  isVerifiedAudioSource,
  mimeTypeFromFilePath,
  normalizeMimeType,
  sanitizeMediaMime,
} from "../media/mime.js";
export { mediaKindFromMime, type MediaKind } from "../media/constants.js";
