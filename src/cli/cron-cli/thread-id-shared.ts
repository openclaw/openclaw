// Cron CLI parsing helpers for Telegram topic thread ids and session targets.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { CronCliError } from "./cron-cli-error.js";

export function parseCronThreadIdOption(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const raw = normalizeOptionalString(value);
  if (!raw || !/^\d+$/.test(raw)) {
    throw new CronCliError("--thread-id must be a positive integer Telegram topic thread id");
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CronCliError("--thread-id must be a safe positive integer Telegram topic thread id");
  }
  return parsed;
}

export function normalizeCronSessionTargetOption(value: unknown): string | undefined {
  // Preserve explicit session ids after `session:` while normalizing the mode prefix.
  const raw = normalizeOptionalString(value);
  if (!raw) {
    return undefined;
  }
  const lower = normalizeLowercaseStringOrEmpty(raw);
  if (lower === "main" || lower === "isolated" || lower === "current") {
    return lower;
  }
  if (lower.startsWith("session:")) {
    const id = normalizeOptionalString(raw.slice(8));
    return id ? `session:${id}` : undefined;
  }
  return undefined;
}
