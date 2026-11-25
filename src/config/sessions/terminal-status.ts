import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Returns true for terminal statuses that a later visible turn may recover in place. */
export function isRecoverableTerminalSessionStatus(
  status: SessionEntry["status"] | undefined,
): boolean {
  return status === "failed" || status === "timeout" || status === "killed";
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

/** The row narrows candidates; the initiating transcript key confirms the exact wire ID. */
export function matchesPersistedClientRunId(stored: string, wire: string): boolean {
  return stored === wire || stored === wire.trim();
}

/** Projection refreshes can retain a recovered result only while the same attempt owns the row. */
export function samePersistedSessionRun(
  before: SessionEntry | undefined,
  after: SessionEntry | undefined,
): boolean {
  return (
    before === after ||
    (before?.sessionId === after?.sessionId &&
      before?.lastRunId === after?.lastRunId &&
      before?.lifecycleRunId === after?.lifecycleRunId &&
      before?.status === after?.status &&
      before?.startedAt === after?.startedAt &&
      before?.endedAt === after?.endedAt)
  );
}
