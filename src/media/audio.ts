// Audio media helpers normalize audio mime types, extensions, and load options.
import { getFileExtension, isAudioFileName, normalizeMimeType } from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** File extensions accepted by channel voice-message upload paths. */
const VOICE_MESSAGE_AUDIO_EXTENSIONS = new Set([".oga", ".ogg", ".opus", ".mp3", ".m4a"]);

/** MIME types compatible with voice-message upload paths. */
const VOICE_MESSAGE_MIME_TYPES = new Set([
  "audio/ogg",
  "audio/opus",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/x-m4a",
  "audio/m4a",
]);

/** Checks whether MIME type or filename is compatible with voice-message delivery. */
export function isVoiceMessageCompatibleAudio(opts: {
  contentType?: string | null;
  fileName?: string | null;
}): boolean {
  const mime = normalizeMimeType(opts.contentType);
  if (mime && VOICE_MESSAGE_MIME_TYPES.has(mime)) {
    return true;
  }
  const fileName = normalizeOptionalString(opts.fileName);
  if (!fileName) {
    return false;
  }
  const ext = getFileExtension(fileName);
  if (!ext) {
    return false;
  }
  return VOICE_MESSAGE_AUDIO_EXTENSIONS.has(ext);
}

/**
 * Backward-compatible alias for voice-message audio compatibility checks.
 *
 * @deprecated Use isVoiceMessageCompatibleAudio.
 */
export function isVoiceCompatibleAudio(opts: {
  contentType?: string | null;
  fileName?: string | null;
}): boolean {
  return isVoiceMessageCompatibleAudio(opts);
}

/** Strips a legacy MEDIA: prefix before extension-based classification. */
function normalizeMediaReferenceFileName(mediaUrl: string): string {
  return mediaUrl.trim().replace(/^\s*MEDIA\s*:\s*/i, "");
}

/**
 * Checks whether any reference is non-audio media (an image, a document, a video).
 * Such a payload cannot also carry synthesized speech: one message owns one media set,
 * so the audio would overwrite it. Classification follows the shared extension/MIME
 * table, so it stays in step with the rest of the media layer.
 */
export function hasNonAudioMediaReference(mediaUrls: readonly string[]): boolean {
  return mediaUrls.some((mediaUrl) => {
    const fileName = normalizeOptionalString(mediaUrl);
    return fileName ? !isAudioFileName(normalizeMediaReferenceFileName(fileName)) : false;
  });
}
