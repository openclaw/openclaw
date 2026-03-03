import { isTelegramVoiceCompatibleAudio } from "../media/audio.js";
export function resolveTelegramVoiceDecision(opts) {
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
        reason: `media is ${contentType} (${fileName})`,
    };
}
export function resolveTelegramVoiceSend(opts) {
    const decision = resolveTelegramVoiceDecision(opts);
    if (decision.reason && opts.logFallback) {
        opts.logFallback(`Telegram voice requested but ${decision.reason}; sending as audio file instead.`);
    }
    return { useVoice: decision.useVoice };
}
