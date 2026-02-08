import { getFileExtension } from "./mime.js";

const VOICE_AUDIO_EXTENSIONS = new Set([".oga", ".ogg", ".opus", ".mp3", ".m4a"]);

/**
 * Known audio MIME types compatible with Telegram voice messages.
 * Per Telegram Bot API: OGG/Opus, MP3, and M4A are supported for sendVoice.
 * https://core.telegram.org/bots/api#sendvoice
 */
const VOICE_COMPATIBLE_MIME_TYPES = new Set([
  "audio/ogg",
  "audio/opus",
  "audio/mpeg", // MP3
  "audio/mp3",
  "audio/mp4", // M4A container
  "audio/x-m4a",
  "audio/m4a",
  "audio/aac",
]);

export function isVoiceCompatibleAudio(opts: {
  contentType?: string | null;
  fileName?: string | null;
}): boolean {
  const mime = opts.contentType?.toLowerCase().trim();

  // Check against known voice-compatible MIME types
  if (mime) {
    // Exact match first
    if (VOICE_COMPATIBLE_MIME_TYPES.has(mime)) {
      return true;
    }
    // Handle MIME types with parameters (e.g., "audio/ogg; codecs=opus")
    const baseMime = mime.split(";")[0].trim();
    if (VOICE_COMPATIBLE_MIME_TYPES.has(baseMime)) {
      return true;
    }
  }

  // Fall back to file extension check
  const fileName = opts.fileName?.trim();
  if (!fileName) {
    return false;
  }
  const ext = getFileExtension(fileName);
  if (!ext) {
    return false;
  }
  return VOICE_AUDIO_EXTENSIONS.has(ext);
}
