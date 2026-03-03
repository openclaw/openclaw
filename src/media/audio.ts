import { getFileExtension, normalizeMimeType } from "./mime.js";

export const TELEGRAM_VOICE_AUDIO_EXTENSIONS = new Set([".oga", ".ogg", ".opus"]);

/**
 * MIME types treated as *voice-bubble compatible* by OpenClaw.
 *
 * Note: Telegram Bot API may accept additional audio formats for sendVoice,
 * but many clients render non-Opus/non-Ogg files as regular audio cards.
 * To make `asVoice` reliably produce voice bubbles, we only route OGG/Opus here.
 */
export const TELEGRAM_VOICE_MIME_TYPES = new Set(["audio/ogg", "audio/opus"]);

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
