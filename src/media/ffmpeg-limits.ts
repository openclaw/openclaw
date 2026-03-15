import { detectResourceProfile } from "../infra/platform-profile.js";

const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const LOW_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/**
 * Max buffer for FFmpeg child process stdout.
 * Reduced on low-memory devices to prevent OOM. Override with `OPENCLAW_MEDIA_MAX_BUFFER`.
 */
export function getMediaFfmpegMaxBufferBytes(): number {
  const override = process.env.OPENCLAW_MEDIA_MAX_BUFFER;
  if (override) {
    const parsed = Number(override);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const profile = detectResourceProfile();
  return profile === "low" ? LOW_MAX_BUFFER_BYTES : DEFAULT_MAX_BUFFER_BYTES;
}

/** @deprecated Use `getMediaFfmpegMaxBufferBytes()` for adaptive limits. */
export const MEDIA_FFMPEG_MAX_BUFFER_BYTES = DEFAULT_MAX_BUFFER_BYTES;
export const MEDIA_FFPROBE_TIMEOUT_MS = 10_000;
export const MEDIA_FFMPEG_TIMEOUT_MS = 45_000;
export const MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS = 20 * 60;
