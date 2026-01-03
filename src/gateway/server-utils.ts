import { defaultVoiceWakeTriggers } from "../infra/voicewake.js";

export function normalizeVoiceWakeTriggers(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : [];
  const cleaned = raw
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0)
    .slice(0, 32)
    .map((v) => v.slice(0, 64));
  return cleaned.length > 0 ? cleaned : defaultVoiceWakeTriggers();
}

export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  const statusValue = (err as { status?: unknown })?.status;
  const codeValue = (err as { code?: unknown })?.code;
  const statusText =
    typeof statusValue === "string" || typeof statusValue === "number"
      ? String(statusValue)
      : undefined;
  const codeText =
    typeof codeValue === "string" || typeof codeValue === "number"
      ? String(codeValue)
      : undefined;
  if (statusText || codeText) {
    return [statusText, codeText].filter(Boolean).join(" ");
  }
  try {
    return JSON.stringify(err, null, 2);
  } catch {
    return String(err);
  }
}
