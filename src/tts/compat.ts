import type { OpenClawConfig } from "../config/config.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import { logVerbose } from "../globals.js";
import { hasFFmpeg, transcodeToOggOpus } from "../media/audio.js";

/**
 * Ensures an audio file is in a format compatible with the target channel's
 * native voice features (e.g. OGG/Opus for Telegram).
 */
export function ensureCompatibleVoiceFormat(params: {
  audioPath: string;
  channel?: string;
  channelId: string | null;
  cfg: OpenClawConfig;
}): { audioPath: string; isNative: boolean } {
  const channelId =
    params.channelId ?? (params.channel ? normalizeChannelId(params.channel) : null);
  const isTelegram =
    channelId === "telegram" || (params.channel?.toLowerCase().includes("telegram") ?? false);
  const tgConfig = params.cfg.channels?.telegram;

  if (isTelegram && tgConfig?.nativeVoiceNotes) {
    if (hasFFmpeg()) {
      return {
        audioPath: transcodeToOggOpus(params.audioPath),
        isNative: true,
      };
    } else {
      logVerbose("Telegram nativeVoiceNotes enabled but ffmpeg missing.");
      return { audioPath: params.audioPath, isNative: false };
    }
  }

  return { audioPath: params.audioPath, isNative: false };
}
