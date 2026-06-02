import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { defaultVoiceWakeTriggers } from "../infra/voicewake.js";

/** Normalizes configured voice wake phrases while preserving safe defaults when empty. */
export function normalizeVoiceWakeTriggers(input: unknown): string[] {
  // Voicewake config is user-editable; cap count and phrase length before the
  // values reach runtime matching so config mistakes cannot create huge scans.
  const cleaned = normalizeTrimmedStringList(input)
    .slice(0, 32)
    .map((value) => value.slice(0, 64));
  return cleaned.length > 0 ? cleaned : defaultVoiceWakeTriggers();
}

/** Formats unknown gateway errors into compact operator-facing diagnostics. */
export function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  const statusValue = (err as { status?: unknown })?.status;
  const codeValue = (err as { code?: unknown })?.code;
  const hasStatus = statusValue !== undefined;
  const hasCode = codeValue !== undefined;
  if (hasStatus || hasCode) {
    const statusText =
      typeof statusValue === "string" || typeof statusValue === "number"
        ? String(statusValue)
        : "unknown";
    const codeText =
      typeof codeValue === "string" || typeof codeValue === "number"
        ? String(codeValue)
        : "unknown";
    return `status=${statusText} code=${codeText}`;
  }
  try {
    return JSON.stringify(err, null, 2);
  } catch {
    return String(err);
  }
}
