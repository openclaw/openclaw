import { clearAllCliSessions } from "./cli-session-binding.js";
import { COMPACTION_RUN_USAGE_CLEAR_PATCH } from "./session-entry-projection.js";
import type { InternalSessionEntry } from "./types.js";

/** Manual transcript trimming clears accounting and harness state for the replaced history. */
export function projectManuallyCompactedSessionEntry(
  previous: InternalSessionEntry,
  nowMs?: number,
): InternalSessionEntry {
  const next = structuredClone(previous);
  delete next.contextBudgetStatus;
  Object.assign(next, COMPACTION_RUN_USAGE_CLEAR_PATCH);
  delete next.totalTokens;
  delete next.totalTokensFresh;
  delete next.totalTokensVersion;
  clearAllCliSessions(next);
  next.updatedAt = nowMs ?? Date.now();
  return next;
}
