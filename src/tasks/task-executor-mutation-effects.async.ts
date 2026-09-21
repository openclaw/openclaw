import { isSqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import {
  ensureTaskFlowRegistryReadyAsync,
  runTaskFlowRegistryWorkerMutation,
} from "./task-flow-runtime-internal.js";
import { retainCommittedTaskFlowEffects } from "./task-registry-flow-sync.js";
import {
  taskFlowSyncOwner,
  syncFlowFromTaskAfterTaskMutationAsync,
  tasks,
} from "./task-registry-state.js";
import type { TaskRegistryStore } from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";

const log = createSubsystemLogger("tasks/executor");
type FlowStore = ReturnType<typeof getTaskFlowRegistryStore>;

/** Report unfinished effects without discarding their existing repair or failure handling. */
export async function finishTaskMutation(
  context: OpenClawStateWorkerContext,
  store: TaskRegistryStore,
  flowStore: FlowStore,
  taskId: string,
  options: { operation: "create" | "update"; assertCurrent: () => void },
): Promise<boolean> {
  const task = tasks.get(taskId);
  const flowId = task?.parentFlowId?.trim();
  if (!task || !flowId) {
    return true;
  }
  try {
    await ensureTaskFlowRegistryReadyAsync(context);
    options.assertCurrent();
    const flowSettled = await syncFlowFromTaskAfterTaskMutationAsync(
      context,
      store,
      task,
      options.operation,
      flowStore,
    );
    if (options.operation === "update") {
      const cancellationSettled = await finishManagedTaskCancellation(
        context,
        store,
        flowStore,
        taskId,
        options.assertCurrent,
      );
      return flowSettled && cancellationSettled;
    }
    return flowSettled;
  } catch (error) {
    if (!isSqliteWorkerError(error, "overloaded")) {
      throw error;
    }
    retainTaskMutationFlowEffects(context, store, flowStore, task, options.operation);
    return false;
  }
}

async function finishManagedTaskCancellation(
  context: OpenClawStateWorkerContext,
  store: TaskRegistryStore,
  flowStore: FlowStore,
  taskId: string,
  assertCurrent: () => void,
): Promise<boolean> {
  const flowId = tasks.get(taskId)?.parentFlowId?.trim();
  if (!flowId) {
    return true;
  }
  try {
    assertCurrent();
    await ensureTaskFlowRegistryReadyAsync(context);
    assertCurrent();
    let publicationSettled = true;
    await runTaskFlowRegistryWorkerMutation(
      {
        flowId,
        admission: context.admission,
        onPublicationError: () => {
          publicationSettled = false;
        },
      },
      () =>
        store.runInitialMutationAsync(
          context,
          { type: "flows.finalizeTaskCancellation", input: { taskId, flowId, now: Date.now() } },
          assertCurrent,
        ),
      async () => {
        assertCurrent();
        const flow = await flowStore.readFlowAsync(context, flowId);
        assertCurrent();
        return flow;
      },
    );
    return publicationSettled;
  } catch (error) {
    if (isSqliteWorkerError(error, "overloaded")) {
      throw error;
    }
    log.warn("Failed to finalize managed flow cancellation from task update", {
      taskId,
      flowId,
      error,
    });
    return false;
  }
}

export function retainTaskMutationFlowEffects(
  context: OpenClawStateWorkerContext,
  store: TaskRegistryStore,
  flowStore: FlowStore,
  task: TaskRecord,
  operation: "create" | "update",
): void {
  try {
    const owner = taskFlowSyncOwner(task.taskId, flowStore);
    retainCommittedTaskFlowEffects(
      context,
      store,
      task,
      operation,
      owner,
      operation === "update"
        ? async (retryContext) => {
            await finishManagedTaskCancellation(retryContext, store, flowStore, task.taskId, () => {
              owner.assertCurrent(retryContext, store);
            });
          }
        : undefined,
    );
  } catch (error) {
    log.warn("Failed to retain committed task flow effects", {
      taskId: task.taskId,
      operation,
      error,
    });
  }
}
