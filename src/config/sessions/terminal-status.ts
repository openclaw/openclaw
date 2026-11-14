import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Returns true for terminal statuses that a later visible turn may recover in place. */
export function isRecoverableTerminalSessionStatus(
  status: SessionEntry["status"] | undefined,
): boolean {
  return status === "failed" || status === "timeout" || status === "killed";
}

/** When a user's Stop ended this incarnation's work; a Stop carried into another sessionId is not its. */
export function resolveUserStoppedAt(entry: SessionEntry | undefined): number | undefined {
  return entry?.sessionId && entry.userStoppedSessionId === entry.sessionId
    ? entry.userStoppedAt
    : undefined;
}

/** Clears stale terminal lifecycle fields before reusing a recoverable session entry. */
export function recoverTerminalSessionEntryForVisibleTurn(entry: SessionEntry): SessionEntry {
  return {
    ...entry,
    status: undefined,
    lifecycleRunId: undefined,
    lastRunId: undefined,
    startedAt: undefined,
    endedAt: undefined,
    runtimeMs: undefined,
    lastRunError: undefined,
    suppressErrorNotice: undefined,
    abortedLastRun: undefined,
  };
}
