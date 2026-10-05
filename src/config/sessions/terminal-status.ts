import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Call only after archive drain or startup reconciliation has excluded live work. */
export function settleArchivedSessionRun(entry: SessionEntry, now: number): void {
  if (entry.archivedAt === undefined || entry.status !== "running") {
    return;
  }
  // Keep recovery/delivery receipts and known run timing; archive cancels execution.
  entry.status = "killed";
  entry.abortedLastRun = true;
  entry.endedAt ??= now;
  delete entry.lifecycleRunId;
}

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
    abortedLastRun: undefined,
    restartRecoveryForceSafeTools: undefined,
    restartRecoveryDeliveryContext: undefined,
    restartRecoveryDeliveryMediaUrls: undefined,
    restartRecoveryDisableMessageTool: undefined,
    restartRecoverySuppressTextDelivery: undefined,
    restartRecoveryDeliveryRequestFingerprint: undefined,
    restartRecoveryDeliveryRunId: undefined,
    restartRecoveryDeliverySourceRunId: undefined,
    restartRecoverySourceReplyDeliveryMode: undefined,
  };
}
