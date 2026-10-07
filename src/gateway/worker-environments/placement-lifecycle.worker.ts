import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
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
import {
  retireWorkerSessionPlacement,
  type WorkerSessionPlacementRetirement,
} from "./placement-retirement.js";
import {
  find,
  readWorkerPlacementsInDatabase,
  readWorkerPlacementsForReconcileInDatabase,
  updateTransition,
} from "./placement-row-codec.js";
import type { PlacementStoreRuntime } from "./placement-runtime.js";
import { consumePreparedEnvironment } from "./prepared-environment-store.js";

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
  "workerPlacements.readMove": (input: { sessionId: string }, { open }: WorkerOperationContext) =>
    readWorkerPlacementMovesReadOnly(open().db, [input.sessionId]).get(input.sessionId),
  "workerPlacements.readReconcile": (
    input: { sessionKey?: string },
    { open }: WorkerOperationContext,
  ) => readWorkerPlacementsForReconcileInDatabase(open().db, input.sessionKey),
} satisfies WorkerOperationHandlers;

export const placementLifecycleOperations = {
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
