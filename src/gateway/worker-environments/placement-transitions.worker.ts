import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { workerWorkspaceDurabilitySchema } from "../../plugins/worker-retention.js";
import {
  bindSessionRepositoryWorkspaceDiskInDatabase,
  readSessionRepositoryWorkspaceInDatabase,
} from "../../state/session-repository-workspaces.kernel.js";
import { drainWorkerSessionPlacement } from "./placement-drain.js";
import { createPlacementMoveOps } from "./placement-move-intent.js";
import { readWorkerPlacementMovesReadOnly } from "./placement-move-row-codec.js";
import {
  isCurrentPlacementTurnClaim,
  nextGeneration,
  normalizeEpoch,
  projectPlacementTurnClaim,
  projectWorkerSessionTurnClaim,
  required,
  type WorkerSessionPlacementTransitionPatch,
  type WorkerSessionPlacementIdentity,
  type WorkerSessionTurnClaim,
} from "./placement-record.js";
import {
  fromRow,
  ensureLocal,
  getRequired,
  query,
  transitionValues,
  turnClaimValues,
  updateTransition,
} from "./placement-row-codec.js";
import type { PlacementStoreRuntime } from "./placement-runtime.js";
import { clearWorkerTurnToolState } from "./placement-session-tool-operations.kernel.js";
import {
  canTransitionWorkerSessionPlacement,
  type WorkerSessionPlacementState,
} from "./placement-state.js";
import type { PlacementTurnClaimReceipt } from "./placement-turn-claims.types.js";
import { hasWorkerWorkspacePendingResult } from "./placement-workspace-result.js";
import { isWorkerRetainedWindowOpen } from "./retained-work-window.js";
import { findWorkerEnvironment } from "./store-row-codec.js";
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
      localIdentity?: WorkerSessionPlacementIdentity;
      repositoryDiskWorkspaceId?: string;
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
      if (input.repositoryDiskWorkspaceId && (input.from !== "starting" || input.to !== "active")) {
        throw new Error("Repository disk binding requires placement activation");
      }
      const sessionId = required(input.sessionId, "session id");
      return write((db) => {
        const current = input.localIdentity
          ? ensureLocal(db, input.localIdentity, now())
          : getRequired(db, sessionId);
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
        if (placement.state === "active") {
          const environment = findWorkerEnvironment(db, placement.environmentId);
          const durability = workerWorkspaceDurabilitySchema
            .optional()
            .parse(environment?.profileSnapshot.workspaceDurability);
          if (durability?.mode === "retained-disk") {
            const repository = input.repositoryDiskWorkspaceId
              ? readSessionRepositoryWorkspaceInDatabase(db, input.repositoryDiskWorkspaceId)
              : undefined;
            if (
              !repository ||
              repository.agentId !== placement.agentId ||
              repository.sessionKey !== placement.sessionKey ||
              repository.manifestHash !== placement.workspaceBaseManifestRef ||
              !environment?.resourceReceipt ||
              !environment.nodeDeviceId ||
              environment.sharedHost !== false ||
              environment.retention?.policy.computeWindowSeconds !==
                durability.computeWindowSeconds ||
              !isWorkerRetainedWindowOpen(environment, now())
            ) {
              throw new Error("Retained repository activation lost its hydrated exact disk owner");
            }
            // The existing repository publication commits with the active postimage.
            // No routable placement may escape before its disk authority is durable.
            bindSessionRepositoryWorkspaceDiskInDatabase(
              db,
              {
                workspaceId: repository.workspaceId,
                expectedRevision: repository.revision,
                diskAuthority: {
                  environmentId: environment.environmentId,
                  resourceReceipt: environment.resourceReceipt,
                },
              },
              now(),
            );
          } else if (input.repositoryDiskWorkspaceId) {
            throw new Error("Repository disk binding was not selected for this allocation");
          }
        }
        if (current.state === "reconciling" && input.to === "reclaimed") {
          const move = readWorkerPlacementMovesReadOnly(db, [sessionId]).get(sessionId);
          if (
            move &&
            move.source.generation + 2 === current.generation &&
            move.source.environmentId === current.environmentId &&
            move.source.ownerEpoch === current.activeOwnerEpoch
          ) {
            // Stop supersedes this source's Move only after safe teardown commits.
            // The reclaimed tuple and exact intent retirement share this transaction.
            createPlacementMoveOps({
              ...runtime,
              read: () => db,
              write: (run) => run(db),
            }).cancelPlacementMove(move);
          }
        }
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
      requireUnclaimed?: true;
      expectedTurnClaim?: WorkerSessionTurnClaim;
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
        // A same-generation claim replacement must not inherit this caller's teardown.
        if (
          (input.requireUnclaimed && current.turnClaim) ||
          (input.expectedTurnClaim &&
            !isCurrentPlacementTurnClaim(current, input.expectedTurnClaim))
        ) {
          throw new Error(`Cannot reconcile stale worker turn for session ${sessionId}`);
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
          ? update.where((eb) => eb.and(turnClaimValues(claim)))
          : update.where("turn_claim_owner", "is", null);
        const updated = executeSqliteQuerySync(db, guardedUpdate.returningAll()).rows[0];
        if (!updated) {
          throw new Error(`Worker session placement ${sessionId} changed during reconcile`);
        }
        return {
          placement: fromRow(updated),
          closedClaim: projectPlacementTurnClaim(current),
        };
      });
    },

    fail(input: {
      sessionId: string;
      recoveryError: string;
      expectedGeneration?: number;
      localIdentity?: WorkerSessionPlacementIdentity;
    }): PlacementTurnClaimReceipt {
      const sessionId = required(input.sessionId, "session id");
      const recoveryError = boundedWorkerError(input.recoveryError);
      return write((db) => {
        const current = input.localIdentity
          ? ensureLocal(db, input.localIdentity, now())
          : getRequired(db, sessionId);
        if (
          input.expectedGeneration !== undefined &&
          current.generation !== input.expectedGeneration
        ) {
          throw new Error(`Worker session placement ${sessionId} changed before failure`);
        }
        const alreadyFailed = current.state === "failed";
        if (!alreadyFailed && !canTransitionWorkerSessionPlacement(current.state, "failed")) {
          throw new Error(`Cannot fail worker session placement from ${current.state}`);
        }
        const localClaim = current.turnClaim?.owner === "local" ? current.turnClaim : null;
        const updatedAtMs = now();
        const updated = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_session_placements")
            .set({
              recovery_error: recoveryError,
              updated_at_ms: updatedAtMs,
              ...(alreadyFailed
                ? {}
                : {
                    state: "failed" as const,
                    transition_generation: nextGeneration(current.generation),
                    terminal_reason: recoveryError,
                    terminal_at_ms: updatedAtMs,
                    ...turnClaimValues(localClaim),
                    state_changed_at_ms: updatedAtMs,
                  }),
            })
            .where("session_id", "=", sessionId)
            .where("state", "=", current.state)
            .where("transition_generation", "=", current.generation)
            .returningAll(),
        ).rows[0];
        if (!updated) {
          throw new Error(
            `Worker session placement ${sessionId} changed during failure${alreadyFailed ? " update" : ""}`,
          );
        }
        return {
          placement: fromRow(updated),
          ...(alreadyFailed ? {} : { closedClaim: projectWorkerSessionTurnClaim(current) }),
        };
      });
    },
  };
}
