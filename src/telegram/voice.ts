import { getFileExtension } from "../media/mime.js";

export function isTelegramVoiceCompatible(opts: {
  contentType?: string | null;
  fileName?: string | null;
}): boolean {
  const mime = opts.contentType?.toLowerCase();
  if (mime && (mime.includes("ogg") || mime.includes("opus"))) {
    return true;
  }
  const fileName = opts.fileName?.trim();
  if (!fileName) return false;
  const ext = getFileExtension(fileName);
  if (!ext) return false;
  return ext === ".ogg" || ext === ".opus" || ext === ".oga";
}

export function resolveTelegramVoiceDecision(opts: {
  wantsVoice: boolean;
  contentType?: string | null;
  fileName?: string | null;
}): { useVoice: boolean; reason?: string } {
  if (!opts.wantsVoice) return { useVoice: false };
  if (isTelegramVoiceCompatible(opts)) return { useVoice: true };
  const contentType = opts.contentType ?? "unknown";
  const fileName = opts.fileName ?? "unknown";
  return {
    useVoice: false,
    reason: `media is ${contentType} (${fileName})`,
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
    opts.logFallback(
      `Telegram voice requested but ${decision.reason}; sending as audio file instead.`,
    );
  }
  return { useVoice: decision.useVoice };
}
