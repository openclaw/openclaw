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
