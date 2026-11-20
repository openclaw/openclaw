import { channel } from "node:diagnostics_channel";
import type { SqliteWorkerOperationSettlement } from "../../infra/sqlite-worker-operation-settlement.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import type { captureSessionSharingAuthorityReconciliation } from "./session-sharing-authority-state.js";

const log = createSubsystemLogger("sessions/sharing");
const diagnostics = channel("openclaw.session-sharing.reconciliation");

/** Prepare one fresh-acquisition read after native settlement; never replay the failed write. */
export function reconcileUnknownSessionSharingAuthority(params: {
  database: OpenClawAgentDatabaseOptions & { path: string };
  databaseIdentity: string;
  recovery: ReturnType<typeof captureSessionSharingAuthorityReconciliation>;
  settlement: SqliteWorkerOperationSettlement | undefined;
  conflictingReceipt: boolean;
}): void {
  const { database, databaseIdentity, recovery, settlement } = params;
  if (recovery.sessionKeys.length === 0) {
    return;
  }
  const report = (event: "reconcile-attempted" | "reconcile-settled" | "still-denied") => {
    // Reporting cannot replace the original mutation's outcome.
    try {
      const details = { event, affectedSessionCount: recovery.sessionKeys.length };
      log.info(event, details);
      diagnostics.publish(details);
    } catch {
      // The publication owner retains the denial independently of log delivery.
    }
  };
  if (
    params.conflictingReceipt ||
    !settlement ||
    (settlement.kind !== "completed" &&
      !(settlement.kind === "unknown" && settlement.nativeStopped))
  ) {
    recovery.deny(params.conflictingReceipt ? "conflicting-receipt" : "native-unsettled");
    report("still-denied");
    return;
  }
  recovery.prepare(database.path, async () => {
    report("reconcile-attempted");
    try {
      // Loaded lazily: the publication owner must not statically reach the execution owner.
      const { readCommittedSessionSharingAuthority } =
        await import("./session-sharing-authority-reconciliation.runtime.js");
      await readCommittedSessionSharingAuthority(
        database,
        databaseIdentity,
        recovery.sessionKeys,
        () => recovery.settle(),
      );
      report("reconcile-settled");
    } catch {
      recovery.deny("replacement-unavailable");
      report("still-denied");
    }
  });
}
