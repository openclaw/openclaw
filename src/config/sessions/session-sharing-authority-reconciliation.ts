import { channel } from "node:diagnostics_channel";
import type { SqliteWorkerOperationSettlement } from "../../infra/sqlite-worker-operation-settlement.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { captureOpenClawAgentDatabaseExecutionAsync } from "../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { invalidateSessionEntryCaches } from "./session-accessor.sqlite-entry-cache-publication.js";
import type { captureSessionSharingAuthorityReconciliation } from "./session-sharing-authority-state.js";
import { createSessionWorkerExecutionSource } from "./session-worker-execution-source.js";

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
      await runOpenClawAgentWorkerWrite(database, async () => {
        const execution = await captureOpenClawAgentDatabaseExecutionAsync(database);
        try {
          const source = createSessionWorkerExecutionSource(
            () => execution.assertCurrent(),
            "Session sharing reconciliation lost its database owner",
          );
          const result = await execution.runExisting(source, (worker) =>
            worker.execute({
              type: "session.entry.read",
              input: {
                sessionKeys: recovery.sessionKeys,
                snapshotFields: [],
                includeMembers: true,
              },
            }),
          );
          execution.assertCurrent();
          if (!result || result.databaseIdentity.identity !== databaseIdentity || !result.members) {
            throw new Error("Session sharing reconciliation did not establish committed facts");
          }
          // The cohort reads entry and membership (including absence) in one native statement.
          // Retire projections before allowing new acquisitions; old grants stay permanently lost.
          invalidateSessionEntryCaches(databaseIdentity);
          sessionChanges.emitBatch(
            recovery.sessionKeys.map((sessionKey) => ({
              agentId: database.agentId,
              storePath: database.path,
              sessionKey,
              factsInvalidated: true,
            })),
          );
        } finally {
          await execution.release();
        }
        recovery.settle();
      });
      report("reconcile-settled");
    } catch {
      recovery.deny("replacement-unavailable");
      report("still-denied");
    }
  });
}
