import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { GatewayStateOwnerContentionError } from "../infra/gateway-state-owner.js";
import { isSqliteLockError } from "../infra/sqlite-error-diagnostics.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../infra/sqlite-worker-operation-settlement.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import type {
  TaskLiveFlowAuthority,
  TaskLiveFlowSyncOutcome,
} from "./task-registry.store.types.js";

/** This local refusal is benign only after the worker attests native settlement. */
class TaskFlowSelectionChanged extends Error {}

export async function syncLiveTaskFlowWithWorker(
  context: OpenClawStateWorkerContext,
  params: { taskId: string; flowId: string },
  authority: TaskLiveFlowAuthority,
): Promise<TaskLiveFlowSyncOutcome> {
  const notSelected = new TaskFlowSelectionChanged("Task is no longer the live flow selection");
  let settlement: Promise<SqliteWorkerOperationSettlement> | undefined;
  try {
    return await runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute({ type: "flows.syncLiveMirroredTask", input: params }),
      {
        assertCurrent: () => authority.assertCurrent(),
        createAdmission(retained) {
          // Record factory entry even when its first authority assertion refuses.
          settlement = retained.settled;
          authority.assertCurrent();
          let requested = false;
          return {
            nativeLocations: [context.admission.databasePath],
            admission: createSqliteWorkerOperationAdmission((request, grant) => {
              authority.assertCurrent();
              const facts = request.facts;
              if (
                requested ||
                request.stage !== "transaction" ||
                !isRecord(facts) ||
                facts.kind !== "task-live-flow" ||
                facts.taskId !== params.taskId ||
                facts.flowId !== params.flowId ||
                typeof facts.createdAt !== "number" ||
                !Number.isFinite(facts.createdAt)
              ) {
                throw new Error("Live task-flow worker admission differs from its owner");
              }
              requested = true;
              if (!authority.isSelected({ ...params, createdAt: facts.createdAt })) {
                throw notSelected;
              }
              authority.assertCurrent();
              if (!grant()) {
                throw new Error("Live task-flow worker admission expired");
              }
            }),
          };
        },
      },
    );
  } catch (error) {
    if (
      !settlement &&
      (isSqliteLockError(error) || error instanceof GatewayStateOwnerContentionError)
    ) {
      // Database opening can refuse before command admission or dispatch.
      authority.assertCurrent();
      return { kind: "retry", reason: "storage_contention" };
    }
    if (error === notSelected && (await settlement)?.kind === "completed") {
      return { kind: "not-selected" };
    }
    throw error;
  } finally {
    await settlement;
  }
}
