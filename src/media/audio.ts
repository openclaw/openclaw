import { normalizeOptionalString } from "../shared/string-coerce.js";
import { getFileExtension, normalizeMimeType } from "./mime.js";

export const TELEGRAM_VOICE_AUDIO_EXTENSIONS = new Set([".oga", ".ogg", ".opus", ".mp3", ".m4a"]);
export const WHATSAPP_VOICE_AUDIO_EXTENSIONS = new Set([".oga", ".ogg", ".opus"]);

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
export const WHATSAPP_VOICE_MIME_TYPES = new Set(["audio/ogg", "audio/opus"]);

// Backward-compatible SDK aliases. Keep the legacy export names mapped to the
// Telegram-compatible voice set, which matches the pre-split behavior.
export const VOICE_MESSAGE_AUDIO_EXTENSIONS = TELEGRAM_VOICE_AUDIO_EXTENSIONS;
export const VOICE_MESSAGE_MIME_TYPES = TELEGRAM_VOICE_MIME_TYPES;

export function isTelegramVoiceCompatibleAudio(opts: {
  contentType?: string | null;
  fileName?: string | null;
}): boolean {
  const mime = normalizeMimeType(opts.contentType);
  if (mime && TELEGRAM_VOICE_MIME_TYPES.has(mime)) {
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
  return TELEGRAM_VOICE_AUDIO_EXTENSIONS.has(ext);
}

export function isWhatsAppVoiceCompatibleAudio(opts: {
  contentType?: string | null;
  fileName?: string | null;
}): boolean {
  const mime = normalizeMimeType(opts.contentType);
  if (mime && WHATSAPP_VOICE_MIME_TYPES.has(mime)) {
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
  return WHATSAPP_VOICE_AUDIO_EXTENSIONS.has(ext);
}

export function isVoiceMessageCompatibleAudio(opts: {
  contentType?: string | null;
  fileName?: string | null;
}): boolean {
  return isTelegramVoiceCompatibleAudio(opts);
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
