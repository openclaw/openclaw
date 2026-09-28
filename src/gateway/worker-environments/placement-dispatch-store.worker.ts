import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { readWorkerPlacementMovesReadOnly } from "./placement-move-intent.js";
import {
  nextGeneration,
  normalizeIdentity,
  normalizeWorkerPlacementExecutionMode,
  type WorkerPlacementDispatchStoreOperations,
  type WorkerSessionPlacementRecord,
} from "./placement-record.js";
import { assertWorkerPlacementDispatchSource } from "./placement-request-preconditions.js";
import { ensureLocal, getRequired, query } from "./placement-row-codec.js";
import { assertSessionWorkspaceUnreserved } from "./placement-workspace-reservation.js";
import { hasWorkerWorkspacePendingResult } from "./placement-workspace-result.js";
import { isFailedWorkerPlacementEnvironmentGone } from "./session-placement-lifecycle.js";
import { findWorkerEnvironment } from "./store-row-codec.js";

export function startWorkerPlacementDispatchInWorker(
  input: WorkerPlacementDispatchStoreOperations["workerPlacements.startDispatch"]["input"],
  database: OpenClawStateDatabase,
): WorkerSessionPlacementRecord {
  const identity = normalizeIdentity(input.placement);
  const executionMode = normalizeWorkerPlacementExecutionMode(input.placement.executionMode);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const current = ensureLocal(db, identity, input.nowMs);
      assertSessionWorkspaceUnreserved(db, identity.sessionId);
      assertWorkerPlacementDispatchSource(current, { ...input.placement, ...identity });
      const expected = input.placement.expectedPlacement;
      if (expected) {
        const journal = executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<Pick<DB, "worker_workspace_reconciliations">>(db)
            .selectFrom("worker_workspace_reconciliations")
            .select("session_id")
            .where("session_id", "=", identity.sessionId),
        ).rows[0];
        if (
          hasWorkerWorkspacePendingResult(db, identity.sessionId) ||
          journal ||
          readWorkerPlacementMovesReadOnly(db, [identity.sessionId]).has(identity.sessionId)
        ) {
          throw new Error(
            `Worker placement ${identity.sessionId} still has pending workspace recovery`,
          );
        }
        if (current.state === "failed") {
          const environment = current.environmentId
            ? findWorkerEnvironment(db, current.environmentId)
            : undefined;
          if (
            current.activeOwnerEpoch === null ||
            !environment ||
            !isFailedWorkerPlacementEnvironmentGone({
              environmentService: { get: () => environment },
              placement: current,
            })
          ) {
            throw new Error(
              `Failed worker placement ${identity.sessionId} still requires recovery`,
            );
          }
        }
      }
      // The local predecessor keeps its claim until the dispatch barrier drains it.
      const result = executeSqliteQuerySync(
        db,
        query(db)
          .updateTable("worker_session_placements")
          .set({
            state: "requested",
            execution_mode: executionMode,
            environment_id: null,
            transition_generation: nextGeneration(current.generation),
            active_owner_epoch: null,
            workspace_base_manifest_ref: null,
            remote_workspace_dir: null,
            worker_bundle_hash: null,
            last_transcript_ack_cursor: null,
            last_live_event_ack_cursor: null,
            recovery_error: null,
            terminal_reason: null,
            terminal_at_ms: null,
            updated_at_ms: input.nowMs,
            state_changed_at_ms: input.nowMs,
          })
          .where("session_id", "=", current.sessionId)
          .where("state", "=", current.state)
          .where("transition_generation", "=", current.generation),
      );
      if (result.numAffectedRows !== 1n) {
        throw new Error(`Session ${identity.sessionId} placement changed during dispatch barrier`);
      }
      const updated = getRequired(db, identity.sessionId);
      deferSqliteWorkerCommitReceipt(db, updated);
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: updated.turnClaim });
      return updated;
    },
    { database },
    { operationLabel: "workerPlacements.startDispatch" },
  );
}
