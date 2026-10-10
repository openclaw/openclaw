import { buildRestartRecoveryClaimCleanupPatch } from "./restart-recovery-state.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Returns true for terminal statuses that a later visible turn may recover in place. */
export function isRecoverableTerminalSessionStatus(
  status: SessionEntry["status"] | undefined,
): boolean {
  return status === "failed" || status === "timeout" || status === "killed";
}

/** Clears stale terminal lifecycle fields before reusing a recoverable session entry. */
export function recoverTerminalSessionEntryForVisibleTurn(entry: SessionEntry): SessionEntry {
  if (entry.restartRecoveryHarnessCompletion) {
    // A failed completion still owns its source; recover it before a later user turn.
    return { ...entry, abortedLastRun: true };
  }
  return {
    ...entry,
    ...buildRestartRecoveryClaimCleanupPatch({ entry, recordTerminalSource: false }),
    status: undefined,
    lifecycleRunId: undefined,
    lastRunId: undefined,
    startedAt: undefined,
    endedAt: undefined,
    runtimeMs: undefined,
    lastRunError: undefined,
    abortedLastRun: undefined,
  };
}
