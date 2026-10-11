import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import type {
  WorkerOperationContext,
  WorkerOperationHandlers,
  WorkerWriteOperationContext,
} from "../../state/worker-operation-registry.js";
import type { PreparedEnvironmentSelection } from "./environment-record.js";
import type { PlacementLifecycleReceipt } from "./placement-lifecycle.types.js";
import {
  createPlacementMoveOps,
  readWorkerPlacementMovesReadOnly,
} from "./placement-move-intent.js";
import { readWorkerSessionPlacementProjectionInDatabase } from "./placement-read-projection.js";
import {
  nextGeneration,
  normalizeIdentity,
  normalizeWorkerPlacementExecutionMode,
  type WorkerPlacementExecutionMode,
  type WorkerSessionPlacementDispatchIdentity,
} from "./placement-record.js";
import {
  retireWorkerSessionPlacement,
  type WorkerSessionPlacementRetirement,
} from "./placement-retirement.js";
import {
  ensureLocal,
  find,
  getRequired,
  query,
  readWorkerPlacementsInDatabase,
  readWorkerPlacementsForReconcileInDatabase,
  updateTransition,
} from "./placement-row-codec.js";
import type { PlacementStoreRuntime } from "./placement-runtime.js";
import {
  isFailedWorkerPlacementEnvironmentGone,
  matchesWorkerPlacementTarget,
} from "./placement-target.js";
import { clearLocalTurnClaimsInDatabase } from "./placement-turn-claims.js";
import { assertSessionWorkspaceUnreserved } from "./placement-workspace-reservation.kernel.js";
import { hasWorkerWorkspacePendingResult } from "./placement-workspace-result.js";
import { consumePreparedEnvironment } from "./prepared-environment-store.js";
import { findWorkerEnvironment } from "./store-row-codec.js";

type Moves = ReturnType<typeof createPlacementMoveOps>;
type MoveInput<Method extends keyof Moves> = Parameters<Moves[Method]>[0];

function operation<Input extends { sessionId: string }>(
  type: string,
  execute: (
    runtime: PlacementStoreRuntime,
    input: Input,
    admit: (facts?: PlacementLifecycleReceipt) => void,
  ) => PlacementLifecycleReceipt,
  deferredAdmission = false,
) {
  return (input: Input & { nowMs?: number }, { write }: WorkerWriteOperationContext) => {
    return write(
      ({ db, path }) => {
        const admit = (facts?: PlacementLifecycleReceipt) =>
          requestSqliteWorkerOperationAdmission({ stage: "transaction", facts });
        if (!deferredAdmission) {
          admit();
        }
        const receipt = execute(
          {
            path,
            instanceId: "",
            now: () => input.nowMs ?? Date.now(),
            read: () => db,
            write: (mutate) => mutate(db),
          },
          input,
          admit,
        );
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: receipt });
        deferSqliteWorkerCommitReceipt(db, receipt);
        return receipt;
      },
      { operationLabel: type },
    );
  };
}

export const placementReadOperations = {
  "workerPlacements.read": (
    input: { sessionIds?: readonly string[] },
    { open }: WorkerOperationContext,
  ) => readWorkerPlacementsInDatabase(open().db, input.sessionIds),
  "workerPlacements.readWithMove": (
    input: { sessionId: string },
    { open }: WorkerOperationContext,
  ) => {
    const { projection } = readWorkerSessionPlacementProjectionInDatabase(
      open().db,
      [input.sessionId],
      [],
    );
    return {
      placement: projection.placements.get(input.sessionId),
      move: projection.moves.get(input.sessionId),
    };
  },
  "workerPlacements.readMove": (input: { sessionId: string }, { open }: WorkerOperationContext) =>
    readWorkerPlacementMovesReadOnly(open().db, [input.sessionId]).get(input.sessionId),
  "workerPlacements.readReconcile": (
    input: { sessionKey?: string },
    { open }: WorkerOperationContext,
  ) => readWorkerPlacementsForReconcileInDatabase(open().db, input.sessionKey),
} satisfies WorkerOperationHandlers;

function startWorkerPlacementDispatch(
  runtime: PlacementStoreRuntime,
  input: WorkerSessionPlacementDispatchIdentity,
) {
  const identity = normalizeIdentity(input);
  const executionMode = normalizeWorkerPlacementExecutionMode(input.executionMode);
  const db = runtime.read();
  const nowMs = runtime.now();
  const current = ensureLocal(db, identity, nowMs);
  assertSessionWorkspaceUnreserved(db, identity.sessionId);
  if (current.state !== "local" && current.state !== "reclaimed" && current.state !== "failed") {
    throw new Error(
      `Cannot dispatch session ${identity.sessionId} from placement ${current.state}`,
    );
  }
  const expected = input.expectedPlacement;
  if (expected) {
    if (
      !matchesWorkerPlacementTarget(current, expected) ||
      current.executionMode !== executionMode ||
      (current.state !== "reclaimed" && current.state !== "failed") ||
      current.turnClaim
    ) {
      throw new Error(`Worker placement ${identity.sessionId} changed before redispatch`);
    }
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
        throw new Error(`Failed worker placement ${identity.sessionId} still requires recovery`);
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
        updated_at_ms: nowMs,
        state_changed_at_ms: nowMs,
      })
      .where("session_id", "=", current.sessionId)
      .where("state", "=", current.state)
      .where("transition_generation", "=", current.generation),
  );
  if (result.numAffectedRows !== 1n) {
    throw new Error(`Session ${identity.sessionId} placement changed during dispatch barrier`);
  }
  return getRequired(db, identity.sessionId);
}

export const placementLifecycleOperations = {
  "workerPlacements.clearLocalTurnClaims": (
    input: { nowMs?: number },
    { write }: WorkerWriteOperationContext,
  ) =>
    write(({ db, path }) => clearLocalTurnClaimsInDatabase(db, path, input.nowMs ?? Date.now()), {
      operationLabel: "workerPlacements.clearLocalTurnClaims",
    }),
  "workerPlacements.startDispatch": operation(
    "workerPlacements.startDispatch",
    (
      runtime,
      input: WorkerSessionPlacementDispatchIdentity & {
        executionMode: WorkerPlacementExecutionMode;
      },
    ) => ({
      sessionId: input.sessionId,
      placement: startWorkerPlacementDispatch(runtime, input),
    }),
  ),
  "workerPlacements.beginMove": operation(
    "workerPlacements.beginMove",
    (runtime, input: MoveInput<"beginPlacementMove">, admit) => ({
      sessionId: input.sessionId,
      ...createPlacementMoveOps(runtime).beginPlacementMove(input, (placement, joined) =>
        admit({ sessionId: input.sessionId, placement, joined }),
      ),
    }),
    true,
  ),
  "workerPlacements.moveError": operation(
    "workerPlacements.moveError",
    (runtime, input: MoveInput<"recordPlacementMoveError">) => ({
      sessionId: input.sessionId,
      changed: createPlacementMoveOps(runtime).recordPlacementMoveError(input),
    }),
  ),
  "workerPlacements.cancelMove": operation(
    "workerPlacements.cancelMove",
    (runtime, input: MoveInput<"cancelPlacementMove">) => ({
      sessionId: input.sessionId,
      changed: createPlacementMoveOps(runtime).cancelPlacementMove(input),
    }),
  ),
  "workerPlacements.completeMoveSource": operation(
    "workerPlacements.completeMoveSource",
    (runtime, input: MoveInput<"completePlacementMoveSourceToLocal">) => ({
      sessionId: input.sessionId,
      ...createPlacementMoveOps(runtime).completePlacementMoveSourceToLocal(input),
    }),
  ),
  "workerPlacements.completeAbandonedMoveSource": operation(
    "workerPlacements.completeAbandonedMoveSource",
    (runtime, input: MoveInput<"completeAbandonedPlacementMoveSourceToLocal">) => ({
      sessionId: input.sessionId,
      ...createPlacementMoveOps(runtime).completeAbandonedPlacementMoveSourceToLocal(input),
    }),
  ),
  "workerPlacements.completeMove": operation(
    "workerPlacements.completeMove",
    (runtime, input: MoveInput<"completePlacementMoveToWorker">) => ({
      sessionId: input.sessionId,
      placement: createPlacementMoveOps(runtime).completePlacementMoveToWorker(input),
    }),
  ),
  "workerPlacements.retire": operation(
    "workerPlacements.retire",
    (runtime, input: WorkerSessionPlacementRetirement) => {
      const db = runtime.read();
      const retired = retireWorkerSessionPlacement(db, input, { onlyIfCurrent: true });
      // Orphan reconciliation may retire the row while this command is queued.
      if (!retired && find(db, input.sessionId)) {
        throw new Error(`Worker session placement ${input.sessionId} changed before retirement`);
      }
      return retired
        ? { sessionId: input.sessionId, retired: input.expectedState }
        : { sessionId: input.sessionId, changed: false };
    },
  ),
  "workerPlacements.bindPrepared": operation(
    "workerPlacements.bindPrepared",
    (runtime, input: Omit<PreparedEnvironmentSelection, "assertCurrent">) => {
      const nowMs = runtime.now();
      const consumed = consumePreparedEnvironment(runtime.read(), input, nowMs);
      if (!consumed) {
        return { sessionId: input.sessionId };
      }
      return {
        sessionId: input.sessionId,
        placement: updateTransition(
          runtime.read(),
          consumed.placement,
          "provisioning",
          { environmentId: input.environmentId },
          nowMs,
        ),
        environment: { environmentId: input.environmentId, patch: consumed.environmentPatch },
      };
    },
  ),
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;
