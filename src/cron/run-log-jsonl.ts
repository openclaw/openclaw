/** Legacy JSONL run-log parser used during migrations/imports. */
import { resolveFailoverReasonFromError } from "../agents/failover-error.js";
import type { CronRunLogEntry } from "./run-log-types.js";
import { parseCronRunLogEntryObject } from "./run-log/entry-codec.js";

function resolveStoredRunLogReason(error: string | undefined, provider: string | undefined) {
  return resolveFailoverReasonFromError(error, provider) ?? undefined;
}

/** Parses legacy cron run-log JSONL, skipping malformed or non-matching rows. */
export function parseCronRunLogEntriesFromJsonl(
  raw: string,
  opts?: { jobId?: string },
): CronRunLogEntry[] {
  if (!raw.trim()) {
    return [];
  }
  const parsed: CronRunLogEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      // JSONL import preserves shipped read normalization; state-db row migration does not inject.
      const entry = parseCronRunLogEntryObject(
        JSON.parse(trimmed),
        opts,
        resolveStoredRunLogReason,
      );
      if (entry) {
        parsed.push(entry);
      }
    } catch {
      // Legacy JSONL migration ignores malformed historical rows.
    }
  }
  return parsed;
}
