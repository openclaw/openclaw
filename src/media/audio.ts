import { getFileExtension, normalizeMimeType } from "./mime.js";

export const TELEGRAM_VOICE_AUDIO_EXTENSIONS = new Set([".oga", ".ogg", ".opus", ".mp3", ".m4a"]);

/**
 * MIME types compatible with voice messages.
 * Telegram sendVoice supports OGG/Opus, MP3, and M4A.
 * https://core.telegram.org/bots/api#sendvoice
 */
export const TELEGRAM_VOICE_MIME_TYPES = new Set([
  "audio/ogg",
  "audio/opus",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/x-m4a",
  "audio/m4a",
]);

export function isTelegramVoiceCompatibleAudio(opts: {
  contentType?: string | null;
  fileName?: string | null;
}): boolean {
  const mime = normalizeMimeType(opts.contentType);
  if (mime && TELEGRAM_VOICE_MIME_TYPES.has(mime)) {
    return true;
  }
  const fileName = opts.fileName?.trim();
  if (!fileName) {
    return false;
  }
  const ext = getFileExtension(fileName);
  if (!ext) {
    return false;
  }
  return TELEGRAM_VOICE_AUDIO_EXTENSIONS.has(ext);
}

/**
 * Backward-compatible alias used across plugin/runtime call sites.
 * Keeps existing behavior while making Telegram-specific policy explicit.
 */
export function isVoiceCompatibleAudio(opts: {
  contentType?: string | null;
  fileName?: string | null;
}): boolean {
  return isTelegramVoiceCompatibleAudio(opts);
}
