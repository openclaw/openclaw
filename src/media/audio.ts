import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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

/** Returns true if ffmpeg is available in the system PATH. */
export function hasFFmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Transcodes an audio file to a standard OGG/Opus voice format.
 * Returns the path to the new file if successful, or the original path if failed.
 */
export function transcodeToOggOpus(inputPath: string): string {
  if (!inputPath || !existsSync(inputPath)) {
    return inputPath;
  }
  const outputPath = inputPath.replace(/\.[^.]+$/, ".ogg");
  try {
    execFileSync(
      "ffmpeg",
      ["-i", inputPath, "-acodec", "libopus", "-ac", "1", "-ar", "24000", outputPath, "-y"],
      { stdio: "ignore" },
    );
    if (existsSync(outputPath)) {
      return outputPath;
    }
  } catch {
    // Ignore errors and return original path as fallback
  }
  return inputPath;
}
