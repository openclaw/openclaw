import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { drainWorkerSessionPlacement } from "./placement-drain.js";
import {
  nextGeneration,
  normalizeEpoch,
  placementTurnOwner,
  projectWorkerSessionTurnClaim,
  required,
  type WorkerSessionPlacementTransitionPatch,
} from "./placement-record.js";
import { getRequired, query, transitionValues, updateTransition } from "./placement-row-codec.js";
import type { PlacementStoreRuntime } from "./placement-runtime.js";
import {
  assertNoRunningWorkerSessionToolOperations,
  clearWorkerTurnToolState,
} from "./placement-session-tool-operations.kernel.js";
import {
  canTransitionWorkerSessionPlacement,
  type WorkerSessionPlacementState,
} from "./placement-state.js";
import type { PlacementTurnClaimReceipt } from "./placement-turn-claims.types.js";
import { hasWorkerWorkspacePendingResult } from "./placement-workspace-result.js";
import { boundedWorkerError } from "./worker-error.js";

export function createPlacementTransitionOps(runtime: PlacementStoreRuntime) {
  const { now, write } = runtime;
  return {
    transition(input: {
      sessionId: string;
      from: WorkerSessionPlacementState;
      to: WorkerSessionPlacementState;
      expectedGeneration: number;
      patch?: WorkerSessionPlacementTransitionPatch;
    }): PlacementTurnClaimReceipt {
      if (!canTransitionWorkerSessionPlacement(input.from, input.to)) {
        throw new Error(
          `Illegal worker session placement transition: ${input.from} -> ${input.to}`,
        );
      }
      if (input.from === "draining" && input.to === "reconciling") {
        throw new Error("Use startReconcile after fencing the drained worker environment");
      }
      if (input.to === "failed") {
        throw new Error("Use fail to record terminal worker placement diagnostics");
      }
      const sessionId = required(input.sessionId, "session id");
      return write((db) => {
        const current = getRequired(db, sessionId);
        if (current.state !== input.from || current.generation !== input.expectedGeneration) {
          throw new Error(
            `Worker session placement ${sessionId} changed: expected ${input.from}@${input.expectedGeneration}, found ${current.state}@${current.generation}`,
          );
        }
        if (current.turnClaim) {
          throw new Error(`Cannot transition session ${sessionId} during an active turn`);
        }
        let environmentActivation: PlacementTurnClaimReceipt["environmentActivation"];
        const placement = updateTransition(
          db,
          current,
          input.to,
          input.patch ?? {},
          now(),
          (environmentId, lastActivatedAtMs) => {
            environmentActivation = { environmentId, lastActivatedAtMs };
          },
        );
        return { placement, environmentActivation };
      });
    },

    startDrain(input: {
      sessionId: string;
      environmentId: string;
      ownerEpoch: number;
      expectedGeneration: number;
      expectedUpdatedAtMs?: number;
      workspaceBaseManifestRef?: string;
      requireUnclaimed?: true;
      expectedTurnClaim?: Parameters<typeof drainWorkerSessionPlacement>[1]["expectedTurnClaim"];
    }): PlacementTurnClaimReceipt {
      return write((db) => ({ placement: drainWorkerSessionPlacement(db, input, now()) }));
    },

    startReconcile(input: {
      sessionId: string;
      environmentId: string;
      ownerEpoch: number;
      expectedGeneration: number;
      forceLocalClaim?: true;
    }): PlacementTurnClaimReceipt {
      const sessionId = required(input.sessionId, "session id");
      const environmentId = required(input.environmentId, "environment id");
      const ownerEpoch = normalizeEpoch(input.ownerEpoch, "active owner epoch");
      return write((db) => {
        const current = getRequired(db, sessionId);
        if (
          current.state !== "draining" ||
          current.generation !== input.expectedGeneration ||
          current.environmentId !== environmentId ||
          current.activeOwnerEpoch !== ownerEpoch
        ) {
          throw new Error(`Cannot reconcile stale worker placement for session ${sessionId}`);
        }
        if (hasWorkerWorkspacePendingResult(db, sessionId)) {
          throw new Error(
            `Cannot reconcile session ${sessionId} with a pending cloud workspace result`,
          );
        }
        // Clear the last claim in the same CAS that opens post-worker
        // reconciliation. Pending results block this authority fence.
        const claim = current.turnClaim;
        if (claim?.owner === "local" && input.forceLocalClaim !== true) {
          throw new Error(`Cannot reconcile session ${sessionId} while its local turn is active`);
        }
        if (claim) {
          assertNoRunningWorkerSessionToolOperations(db, {
            sessionId,
            claimId: claim.claimId,
          });
          clearWorkerTurnToolState(db, {
            sessionId,
            claimId: claim.claimId,
          });
        }
        const values = transitionValues(current, "reconciling", {}, now());
        const update = query(db)
          .updateTable("worker_session_placements")
          .set(values)
          .where("session_id", "=", sessionId)
          .where("state", "=", "draining")
          .where("transition_generation", "=", current.generation)
          .where("environment_id", "=", environmentId)
          .where("active_owner_epoch", "=", ownerEpoch);
        const guardedUpdate = claim
          ? update
              .where("turn_claim_owner", "=", claim.owner)
              .where("turn_claim_id", "=", claim.claimId)
              .where("turn_claim_run_id", "=", claim.runId)
              .where("turn_claim_generation", "=", claim.generation)
              .where(
                "turn_claim_owner_epoch",
                claim.owner === "worker" ? "=" : "is",
                claim.ownerEpoch,
              )
          : update.where("turn_claim_owner", "is", null);
        const result = executeSqliteQuerySync(db, guardedUpdate);
        if (result.numAffectedRows !== 1n) {
          throw new Error(`Worker session placement ${sessionId} changed during reconcile`);
        }
        const updated = getRequired(db, sessionId);
        return {
          placement: updated,
          closedClaim: claim
            ? {
                sessionId,
                claimId: claim.claimId,
                runId: claim.runId,
                placementGeneration: claim.generation,
                owner: placementTurnOwner(current),
              }
            : undefined,
        };
      });
    },

    fail(input: {
      sessionId: string;
      recoveryError: string;
      expectedGeneration?: number;
    }): PlacementTurnClaimReceipt {
      const sessionId = required(input.sessionId, "session id");
      const recoveryError = boundedWorkerError(input.recoveryError);
      return write((db) => {
        const current = getRequired(db, sessionId);
        if (
          input.expectedGeneration !== undefined &&
          current.generation !== input.expectedGeneration
        ) {
          throw new Error(`Worker session placement ${sessionId} changed before failure`);
        }
        if (current.state === "failed") {
          const result = executeSqliteQuerySync(
            db,
            query(db)
              .updateTable("worker_session_placements")
              .set({ recovery_error: recoveryError, updated_at_ms: now() })
              .where("session_id", "=", sessionId)
              .where("state", "=", "failed")
              .where("transition_generation", "=", current.generation),
          );
          if (result.numAffectedRows !== 1n) {
            throw new Error(`Worker session placement ${sessionId} changed during failure update`);
          }
          return { placement: getRequired(db, sessionId) };
        }
        if (!canTransitionWorkerSessionPlacement(current.state, "failed")) {
          throw new Error(`Cannot fail worker session placement from ${current.state}`);
        }
        const localClaim = current.turnClaim?.owner === "local" ? current.turnClaim : null;
        const updatedAtMs = now();
        const result = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_session_placements")
            .set({
              state: "failed",
              transition_generation: nextGeneration(current.generation),
              recovery_error: recoveryError,
              terminal_reason: recoveryError,
              terminal_at_ms: updatedAtMs,
              turn_claim_owner: localClaim ? "local" : null,
              turn_claim_id: localClaim?.claimId ?? null,
              turn_claim_run_id: localClaim?.runId ?? null,
              turn_claim_generation: localClaim?.generation ?? null,
              turn_claim_owner_epoch: null,
              updated_at_ms: updatedAtMs,
              state_changed_at_ms: updatedAtMs,
            })
            .where("session_id", "=", sessionId)
            .where("state", "=", current.state)
            .where("transition_generation", "=", current.generation),
        );
        if (result.numAffectedRows !== 1n) {
          throw new Error(`Worker session placement ${sessionId} changed during failure`);
        }
        const updated = getRequired(db, sessionId);
        return { placement: updated, closedClaim: projectWorkerSessionTurnClaim(current) };
      });
    },
  };
}
