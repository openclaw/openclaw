import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  placementTurnOwner,
  required,
  type WorkerSessionPlacementRecord,
  type WorkerSessionTurnClaim,
} from "./placement-record.js";
import { getRequired, query, transitionValues, turnClaimValues } from "./placement-row-codec.js";
import type { PlacementStoreRuntime } from "./placement-runtime.js";
import {
  assertNoRunningWorkerSessionToolOperations,
  clearWorkerTurnToolState,
} from "./placement-session-tool-operations.kernel.js";
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
        const releasedClaim: WorkerSessionTurnClaim | null = persisted
          ? {
              sessionId,
              claimId: persisted.claimId,
              runId: persisted.runId,
              placementGeneration: persisted.generation,
              owner: placementTurnOwner(current),
            }
          : null;
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
        let transitioning: WorkerSessionPlacementRecord = current;
        const transition = (values: ReturnType<typeof transitionValues>, phase: string) => {
          let statement = query(db)
            .updateTable("worker_session_placements")
            .set(values)
            .where("session_id", "=", sessionId)
            .where("state", "=", transitioning.state)
            .where("transition_generation", "=", transitioning.generation);
          if (values.state === "failed") {
            statement = statement.where("turn_claim_owner", "is", null);
          }
          if (executeSqliteQuerySync(db, statement).numAffectedRows !== 1n) {
            throw new Error(`Session ${sessionId} workspace result changed during ${phase}`);
          }
        };
        if (transitioning.state === "active") {
          const values = transitionValues(transitioning, "draining", {}, terminalAtMs);
          Object.assign(values, turnClaimValues(persisted));
          transition(values, "drain");
          transitioning = getRequired(db, sessionId);
        }
        if (transitioning.state !== "draining") {
          throw new Error(`Session ${sessionId} workspace result did not reach draining`);
        }
        if (persisted) {
          assertNoRunningWorkerSessionToolOperations(db, {
            sessionId,
            claimId: persisted.claimId,
          });
          clearWorkerTurnToolState(db, { sessionId, claimId: persisted.claimId });
        }
        transition(transitionValues(transitioning, "reconciling", {}, terminalAtMs), "reconcile");
        transitioning = getRequired(db, sessionId);
        transition(
          transitionValues(
            transitioning,
            "failed",
            { recoveryError, terminalReason: recoveryError },
            terminalAtMs,
          ),
          "failure",
        );
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
        return { placement: record, closedClaim: releasedClaim ?? undefined };
      });
    },
  };
}
