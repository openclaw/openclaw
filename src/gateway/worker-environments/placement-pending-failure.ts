import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";
import { projectPlacementTurnClaim, required } from "./placement-record.js";
import {
  fromRow,
  getRequired,
  query,
  transitionValues,
  turnClaimValues,
} from "./placement-row-codec.js";
import type { PlacementStoreRuntime } from "./placement-runtime.js";
import { clearWorkerTurnToolState } from "./placement-session-tool-operations.kernel.js";
import {
  publishPlacementTurnClaimState,
  publishPlacementWorkspaceResultState,
} from "./placement-turn-authority.js";
import type { PlacementTurnClaimReceipt } from "./placement-turn-claims.types.js";
import { isCurrentWorkerWorkspacePendingResultOwner } from "./placement-workspace-result.js";
import type { WorkerWorkspacePendingResult } from "./placement-workspace-result.types.js";
import { boundedWorkerError } from "./worker-error.js";

export function createPlacementPendingFailureOps(runtime: PlacementStoreRuntime) {
  const { now, write } = runtime;
  return {
    failWorkspaceResultAndReleaseTurn(
      pending: WorkerWorkspacePendingResult,
      error: unknown,
    ): PlacementTurnClaimReceipt {
      const sessionId = required(pending.sessionId, "session id");
      const recoveryError = boundedWorkerError(error);
      return write((db) => {
        const current = getRequired(db, sessionId);
        if (!isCurrentWorkerWorkspacePendingResultOwner(current, pending)) {
          throw new Error(`Session ${sessionId} workspace result owner changed before failure`);
        }
        const persisted = current.turnClaim;
        const pendingQuery =
          getNodeSqliteKysely<Pick<StateDatabase, "worker_workspace_pending_results">>(db);
        const pendingOwner = {
          session_id: sessionId,
          environment_id: pending.environmentId,
          owner_epoch: pending.ownerEpoch,
          placement_generation: pending.placementGeneration,
          claim_id: pending.claimId,
          run_id: pending.runId,
        };
        const exactPending = executeSqliteQuerySync(
          db,
          pendingQuery
            .selectFrom("worker_workspace_pending_results")
            .select("session_id")
            .where((eb) => eb.and(pendingOwner)),
        ).rows[0];
        if (!exactPending) {
          throw new Error(`Session ${sessionId} workspace result changed before failure`);
        }
        const terminalAtMs = now();
        // Intermediate states are private to this transaction; retain their generation steps.
        const draining =
          current.state === "active"
            ? fromRow({
                ...transitionValues(current, "draining", {}, terminalAtMs),
                ...turnClaimValues(persisted),
              })
            : current;
        if (draining.state !== "draining") {
          throw new Error(`Session ${sessionId} workspace result did not reach draining`);
        }
        if (persisted) {
          clearWorkerTurnToolState(db, { sessionId, claimId: persisted.claimId });
        }
        const reconciling = fromRow(transitionValues(draining, "reconciling", {}, terminalAtMs));
        const failed = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_session_placements")
            .set(
              transitionValues(
                reconciling,
                "failed",
                { recoveryError, terminalReason: recoveryError },
                terminalAtMs,
              ),
            )
            .where("session_id", "=", sessionId)
            .where("state", "=", current.state)
            .where("transition_generation", "=", current.generation),
        );
        if (failed.numAffectedRows !== 1n) {
          throw new Error(`Session ${sessionId} workspace result changed during failure`);
        }
        const removed = executeSqliteQuerySync(
          db,
          pendingQuery
            .deleteFrom("worker_workspace_pending_results")
            .where((eb) => eb.and(pendingOwner)),
        );
        if (removed.numAffectedRows !== 1n) {
          throw new Error(`Session ${sessionId} workspace result changed during failure`);
        }
        const record = getRequired(db, sessionId);
        publishPlacementWorkspaceResultState(db, sessionId, null);
        publishPlacementTurnClaimState(db, record, current.state);
        return { placement: record, closedClaim: projectPlacementTurnClaim(current) };
      });
    },
  };
}
