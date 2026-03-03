import { getFileExtension, normalizeMimeType } from "./mime.js";

export const TELEGRAM_VOICE_BUBBLE_AUDIO_EXTENSIONS = new Set([".oga", ".ogg", ".opus"]);

/**
 * Telegram voice-bubble compatibility (strict).
 *
 * For reliable voice-bubble rendering in Telegram clients, keep this limited
 * to OGG/Opus payloads.
 */
export const TELEGRAM_VOICE_BUBBLE_MIME_TYPES = new Set(["audio/ogg", "audio/opus"]);

/**
 * Cross-channel voice compatibility (broad).
 *
 * This is consumed by runtime integrations beyond Telegram (for example Matrix),
 * so keep legacy behavior here.
 */
export const VOICE_COMPATIBLE_AUDIO_EXTENSIONS = new Set([".oga", ".ogg", ".opus", ".mp3", ".m4a"]);

export const VOICE_COMPATIBLE_MIME_TYPES = new Set([
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
  if (mime && TELEGRAM_VOICE_BUBBLE_MIME_TYPES.has(mime)) {
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
  return TELEGRAM_VOICE_BUBBLE_AUDIO_EXTENSIONS.has(ext);
}

export function isVoiceCompatibleAudio(opts: {
  contentType?: string | null;
  fileName?: string | null;
}): boolean {
  const mime = normalizeMimeType(opts.contentType);
  if (mime && VOICE_COMPATIBLE_MIME_TYPES.has(mime)) {
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
  return VOICE_COMPATIBLE_AUDIO_EXTENSIONS.has(ext);
}
