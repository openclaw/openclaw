import { requestSessionEntryCurrentAdmission } from "../../config/sessions/session-entry-current-admission.worker.js";
import type { SessionEntryCurrentSource } from "../../config/sessions/session-entry-current.types.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { deferSqliteWorkerCommitReceipt } from "../../infra/sqlite-worker-operation-admission.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type {
  WorkerOperationContext,
  WorkerOperationHandlers,
} from "../../state/worker-operation-registry.js";
import { drainWorkerSessionPlacement } from "./placement-drain.js";
import { readWorkerPlacementMovesReadOnly } from "./placement-move-intent.js";
import { createPlacementPendingFailureOps } from "./placement-pending-failure.js";
import {
  advanceCursor,
  normalizeEpoch,
  required,
  resolvePlacementTurnEnvironment,
  type WorkerSessionTurnClaim,
  type WorkerTurnClaimInput,
} from "./placement-record.js";
import { find, getRequired, query } from "./placement-row-codec.js";
import type { PlacementStoreRuntime } from "./placement-runtime.js";
import { createPlacementTransitionOps } from "./placement-transitions.worker.js";
import { createPlacementTurnClaimOps } from "./placement-turn-claims.js";
import type {
  PlacementAckCursorInput,
  PlacementTurnClaimReceipt,
} from "./placement-turn-claims.types.js";
import {
  createPlacementWorkspaceResultOps,
  hasCurrentWorkspaceResultClaim,
  insertWorkerWorkspacePendingResult,
  listPendingWorkerWorkspaceResultsInDatabase,
  recordStagedWorkerWorkspaceResult,
} from "./placement-workspace-result.js";
import type { WorkerWorkspacePendingResult } from "./placement-workspace-result.types.js";

type TransitionOps = ReturnType<typeof createPlacementTransitionOps>;
type TransitionInput<Method extends keyof TransitionOps> = Parameters<TransitionOps[Method]>[0] & {
  nowMs?: number;
};

type ClaimInput = {
  claim: WorkerSessionTurnClaim;
  nowMs?: number;
  sessionEntryCurrentSource?: SessionEntryCurrentSource;
};

function operation<
  Input extends {
    nowMs?: number;
    gatewayInstanceId?: string;
    sessionEntryCurrentSource?: SessionEntryCurrentSource;
  } & (
    | { claim: { sessionId: string } }
    | { pending: WorkerWorkspacePendingResult }
    | { sessionId: string }
  ),
>(
  type: string,
  execute: (runtime: PlacementStoreRuntime, input: Input) => PlacementTurnClaimReceipt,
  guardedWorkspaceWrite = false,
) {
  return (input: Input, { open }: WorkerOperationContext): PlacementTurnClaimReceipt => {
    const database = open();
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        const sessionId =
          "claim" in input
            ? input.claim.sessionId
            : "pending" in input
              ? input.pending.sessionId
              : input.sessionId;
        const move = () =>
          type === "placementTurns.updateWorkspaceBaseManifest" ||
          type === "placementTurns.completeResult"
            ? (readWorkerPlacementMovesReadOnly(db, [sessionId]).get(sessionId) ?? null)
            : undefined;
        const source = guardedWorkspaceWrite ? input.sessionEntryCurrentSource : undefined;
        const admit = (stage: "transaction" | "commit", facts: unknown) =>
          requestSessionEntryCurrentAdmission(source, { stage, facts }, { lookup: "logical" });
        admit("transaction", { placement: find(db, sessionId), placementMove: move() });
        const receipt = execute(
          {
            path: database.path,
            instanceId: input.gatewayInstanceId ?? "",
            now: () => input.nowMs ?? Date.now(),
            read: () => db,
            write: (write) => write(db),
          },
          input,
        );
        receipt.workspaceResult =
          listPendingWorkerWorkspaceResultsInDatabase(db, sessionId)[0] ?? null;
        receipt.placementMove = move();
        admit("commit", receipt);
        deferSqliteWorkerCommitReceipt(db, receipt);
        return receipt;
      },
      { database },
      { operationLabel: type },
    );
  };
}

export const placementTurnClaimOperations = {
  "placementTurns.completeUnreadyRepositoryTurn": operation(
    "placementTurns.completeUnreadyRepositoryTurn",
    (runtime, input: TransitionInput<"completeUnreadyRepositoryTurn">) =>
      createPlacementTransitionOps(runtime).completeUnreadyRepositoryTurn(input),
  ),
  "placementTurns.settleRepository": operation(
    "placementTurns.settleRepository",
    (runtime, input: TransitionInput<"settleRepository">) =>
      createPlacementTransitionOps(runtime).settleRepository(input),
  ),
  "placementTurns.transition": operation(
    "placementTurns.transition",
    (runtime, input: TransitionInput<"transition">) =>
      createPlacementTransitionOps(runtime).transition(input),
  ),
  "placementTurns.startDrain": operation(
    "placementTurns.startDrain",
    (runtime, input: TransitionInput<"startDrain">) =>
      createPlacementTransitionOps(runtime).startDrain(input),
  ),
  "placementTurns.startReconcile": operation(
    "placementTurns.startReconcile",
    (runtime, input: TransitionInput<"startReconcile">) =>
      createPlacementTransitionOps(runtime).startReconcile(input),
  ),
  "placementTurns.fail": operation(
    "placementTurns.fail",
    (runtime, input: TransitionInput<"fail">) => createPlacementTransitionOps(runtime).fail(input),
  ),
  "placementTurns.failResult": operation(
    "placementTurns.failResult",
    (
      runtime,
      input: { pending: WorkerWorkspacePendingResult; recoveryError: string; nowMs?: number },
    ) =>
      createPlacementPendingFailureOps(runtime).failWorkspaceResultAndReleaseTurn(
        input.pending,
        input.recoveryError,
      ),
  ),
  "placementTurns.claimReclaimResult": operation(
    "placementTurns.claimReclaimResult",
    (
      runtime,
      input: { claim: WorkerTurnClaimInput; gatewayInstanceId: string; nowMs?: number },
    ) => {
      const claim = createPlacementTurnClaimOps(runtime).claimReclaimWorkspaceResult(input.claim);
      return { claim, placement: getRequired(runtime.read(), claim.sessionId) };
    },
  ),
  "placementTurns.claimMutationResult": operation(
    "placementTurns.claimMutationResult",
    (
      runtime,
      input: {
        claim: WorkerTurnClaimInput;
        gatewayInstanceId: string;
        nowMs?: number;
        sessionEntryCurrentSource?: SessionEntryCurrentSource;
      },
    ) => {
      const claim = createPlacementTurnClaimOps(runtime).claimWorkspaceMutationResult(input.claim);
      return { claim, placement: getRequired(runtime.read(), claim.sessionId) };
    },
    true,
  ),
  "placementTurns.markResultPending": operation(
    "placementTurns.markResultPending",
    (runtime, input: ClaimInput & { gatewayInstanceId: string }) => {
      createPlacementWorkspaceResultOps(runtime).markWorkspaceResultPending(input.claim);
      return { placement: getRequired(runtime.read(), input.claim.sessionId) };
    },
  ),
  "placementTurns.acceptResult": operation(
    "placementTurns.acceptResult",
    (runtime, input: ClaimInput) => {
      createPlacementWorkspaceResultOps(runtime).acceptWorkspaceResult(input.claim);
      return { placement: getRequired(runtime.read(), input.claim.sessionId) };
    },
    true,
  ),
  "placementTurns.handoffResult": operation(
    "placementTurns.handoffResult",
    (runtime, input: ClaimInput & { gatewayInstanceId: string }) => {
      createPlacementWorkspaceResultOps(runtime).handoffWorkspaceResultRecovery(input.claim);
      return { placement: getRequired(runtime.read(), input.claim.sessionId) };
    },
  ),
  "placementTurns.abandonResult": operation(
    "placementTurns.abandonResult",
    (runtime, input: { pending: WorkerWorkspacePendingResult }) => {
      createPlacementWorkspaceResultOps(runtime).abandonWorkspaceResult(input.pending);
      return { placement: find(runtime.read(), input.pending.sessionId) };
    },
  ),
  "placementTurns.drainResult": operation(
    "placementTurns.drainResult",
    (runtime, input: ClaimInput) => {
      const { claim } = input;
      const db = runtime.read();
      const current = getRequired(db, required(claim.sessionId, "session id"));
      const ownsWorkspaceResult = hasCurrentWorkspaceResultClaim(db, claim);
      const currentOwner = resolvePlacementTurnEnvironment(current, claim);
      const owner =
        currentOwner ??
        (ownsWorkspaceResult &&
        current.state === "active" &&
        current.environmentId &&
        current.activeOwnerEpoch !== null
          ? {
              environmentId: current.environmentId,
              ownerEpoch: current.activeOwnerEpoch,
            }
          : undefined);
      if (current.state !== "active" || !owner || !ownsWorkspaceResult) {
        throw new Error(`Cannot drain stale workspace result for session ${claim.sessionId}`);
      }
      return {
        placement: drainWorkerSessionPlacement(
          db,
          {
            sessionId: current.sessionId,
            environmentId: owner.environmentId,
            ownerEpoch: owner.ownerEpoch,
            expectedGeneration: current.generation,
            allowPendingWorkspaceResult: true,
          },
          runtime.now(),
        ),
      };
    },
  ),
  "placementTurns.completeResult": operation(
    "placementTurns.completeResult",
    (runtime, input: ClaimInput) => ({
      placement: createPlacementTurnClaimOps(runtime).completeWorkspaceResultAndReleaseTurn(
        input.claim,
      ),
    }),
    true,
  ),
  "placementTurns.cancelResult": operation(
    "placementTurns.cancelResult",
    (runtime, input: ClaimInput & { gatewayInstanceId: string; reason?: "node-disconnect" }) => ({
      placement: createPlacementTurnClaimOps(runtime).cancelWorkspaceResultAndReleaseTurn(
        input.claim,
        input.reason ? { reason: input.reason } : undefined,
      ),
    }),
  ),
  "placementTurns.updateAckCursors": operation(
    "placementTurns.updateAckCursors",
    (runtime, input: PlacementAckCursorInput & { gatewayInstanceId: string; nowMs?: number }) => {
      const sessionId = required(input.claim.sessionId, "session id");
      const claimId = required(input.claim.claimId, "turn claim id");
      const runId = required(input.claim.runId, "turn claim run id");
      if (
        !Number.isSafeInteger(input.claim.placementGeneration) ||
        input.claim.placementGeneration < 0
      ) {
        throw new Error("Worker session placement turn claim generation is invalid");
      }
      if (input.claim.owner.kind !== "worker") {
        throw new Error("Only a worker turn claim can acknowledge worker cursors");
      }
      const placementGeneration = input.claim.placementGeneration;
      const environmentId = required(input.claim.owner.environmentId, "environment id");
      const ownerEpoch = normalizeEpoch(input.claim.owner.ownerEpoch, "active owner epoch");
      const db = runtime.read();
      const current = getRequired(db, sessionId);
      const persisted = current.turnClaim;
      const workerMayFinish = current.state === "active" || current.state === "draining";
      if (
        !workerMayFinish ||
        current.environmentId !== environmentId ||
        current.activeOwnerEpoch !== ownerEpoch ||
        persisted?.owner !== "worker" ||
        persisted.claimId !== claimId ||
        persisted.runId !== runId ||
        persisted.generation !== placementGeneration ||
        persisted.ownerEpoch !== ownerEpoch
      ) {
        throw new Error(`Cannot ACK stale worker turn for session ${sessionId}`);
      }
      // Successful RPC replays can carry an older sequence. Preserve the
      // durable high-water mark while acknowledging the idempotent replay.
      const transcript = advanceCursor(
        current.lastTranscriptAckCursor,
        input.transcript,
        "transcript ACK cursor",
      );
      const liveEvent = advanceCursor(
        current.lastLiveEventAckCursor,
        input.liveEvent,
        "live ACK cursor",
      );
      const result = executeSqliteQuerySync(
        db,
        query(db)
          .updateTable("worker_session_placements")
          .set({
            last_transcript_ack_cursor: transcript,
            last_live_event_ack_cursor: liveEvent,
            updated_at_ms: runtime.now(),
          })
          .where("session_id", "=", sessionId)
          .where("state", "=", current.state)
          .where("transition_generation", "=", current.generation)
          .where("environment_id", "=", environmentId)
          .where("active_owner_epoch", "=", ownerEpoch)
          .where("turn_claim_owner", "=", "worker")
          .where("turn_claim_id", "=", claimId)
          .where("turn_claim_run_id", "=", runId)
          .where("turn_claim_generation", "=", placementGeneration)
          .where("turn_claim_owner_epoch", "=", ownerEpoch),
      );
      if (result.numAffectedRows !== 1n) {
        throw new Error(`Worker session placement ${sessionId} changed during ACK`);
      }
      if (input.liveEvent !== undefined) {
        // The terminal event is not ACKed until crash recovery has a durable
        // fence protecting remote workspace results from stale-claim teardown.
        insertWorkerWorkspacePendingResult(db, input.claim, runtime.now(), runtime.instanceId);
      }
      return { placement: getRequired(db, sessionId) };
    },
    true,
  ),
  "placementTurns.claim": operation(
    "placementTurns.claim",
    (runtime, input: { claim: WorkerTurnClaimInput; nowMs?: number }) => {
      const claim = createPlacementTurnClaimOps(runtime).claimTurn(input.claim);
      return { claim, placement: getRequired(runtime.read(), claim.sessionId) };
    },
  ),
  "placementTurns.updateWorkspaceBaseManifest": operation(
    "placementTurns.updateWorkspaceBaseManifest",
    (
      runtime,
      input: ClaimInput & {
        manifestRef: string;
        sessionEntryCurrentSource?: SessionEntryCurrentSource;
      },
    ) => ({ placement: createPlacementTurnClaimOps(runtime).updateWorkspaceBaseManifest(input) }),
    true,
  ),
  "placementTurns.recordStagedResult": operation(
    "placementTurns.recordStagedResult",
    (
      runtime,
      input: ClaimInput & {
        stagedResultRef: string;
        repositoryWorkspaceId?: string;
        sessionEntryCurrentSource?: SessionEntryCurrentSource;
      },
    ) => {
      const db = runtime.read();
      recordStagedWorkerWorkspaceResult(
        db,
        input.claim,
        input.stagedResultRef,
        input.repositoryWorkspaceId,
      );
      return { placement: getRequired(db, input.claim.sessionId) };
    },
    true,
  ),
  "placementTurns.recoverWorkspace": operation(
    "placementTurns.recoverWorkspace",
    (runtime, input: ClaimInput & { gatewayInstanceId: string }) => {
      const results = createPlacementWorkspaceResultOps(runtime);
      results.markWorkspaceResultPending(input.claim);
      results.handoffWorkspaceResultRecovery(input.claim);
      return { placement: getRequired(runtime.read(), input.claim.sessionId) };
    },
  ),
  "placementTurns.handoffRuntimeRefreshResult": operation(
    "placementTurns.handoffRuntimeRefreshResult",
    (
      runtime,
      input: ClaimInput & { expectedGeneration: number; gatewayInstanceId: string; nowMs: number },
    ) => {
      const placement = getRequired(runtime.read(), input.claim.sessionId);
      if (
        placement.state !== "active" ||
        placement.generation !== input.expectedGeneration ||
        input.claim.owner.kind !== "worker"
      ) {
        throw new Error("Worker runtime refresh lost its workspace result owner");
      }
      createPlacementWorkspaceResultOps(runtime).handoffWorkspaceResultRecovery(input.claim);
      return { placement };
    },
  ),
  "placementTurns.releaseIfOwned": operation(
    "placementTurns.releaseIfOwned",
    (runtime, input: ClaimInput) => {
      const claims = createPlacementTurnClaimOps(runtime);
      return claims.validateTurnClaim(input.claim)
        ? { placement: claims.releaseTurn(input.claim) }
        : {};
    },
  ),
  "placementTurns.release": operation("placementTurns.release", (runtime, input: ClaimInput) => ({
    placement: createPlacementTurnClaimOps(runtime).releaseTurn(input.claim),
  })),
} satisfies WorkerOperationHandlers;
