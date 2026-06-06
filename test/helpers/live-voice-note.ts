import { resolveFfmpegBin } from "openclaw/plugin-sdk/media-runtime";

export function hasTrustedFfmpegForLiveVoiceNote(label: string): boolean {
  try {
    resolveFfmpegBin();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ffmpeg not found in trusted system directories")) {
      console.warn(`[${label}:live] skip voice-note transcode: ffmpeg unavailable`);
      return false;
    }
    throw error;
  }
}
