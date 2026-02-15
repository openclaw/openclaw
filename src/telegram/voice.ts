import { t } from "../i18n/index.js";
import { isTelegramVoiceCompatibleAudio } from "../media/audio.js";

export function resolveTelegramVoiceDecision(opts: {
  wantsVoice: boolean;
  contentType?: string | null;
  fileName?: string | null;
}): { useVoice: boolean; reason?: string } {
  if (!opts.wantsVoice) {
    return { useVoice: false };
  }
  if (isTelegramVoiceCompatibleAudio(opts)) {
    return { useVoice: true };
  }
  const contentType = opts.contentType ?? "unknown";
  const fileName = opts.fileName ?? "unknown";
  return {
    useVoice: false,
    reason: t("telegram.media.voice_as_audio", { mediaType: contentType, filename: fileName }),
  };
}

export function resolveTelegramVoiceSend(opts: {
  wantsVoice: boolean;
  contentType?: string | null;
  fileName?: string | null;
  logFallback?: (message: string) => void;
}): { useVoice: boolean } {
  const decision = resolveTelegramVoiceDecision(opts);
  if (decision.reason && opts.logFallback) {
    opts.logFallback(decision.reason);
  }
  return { useVoice: decision.useVoice };
}
