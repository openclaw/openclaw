import path from "node:path";

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
  const ext = path.extname(fileName).toLowerCase();
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
