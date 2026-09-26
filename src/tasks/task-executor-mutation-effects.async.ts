import {
  hasSqliteWorkerOutcomeUnknown,
  isSqliteWorkerError,
} from "../infra/sqlite-worker-contract.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { TaskMutationContext } from "./task-executor.types.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import {
  ensureTaskFlowRegistryReadyAsync,
  prepareTaskFlowRegistryRead,
  runTaskFlowRegistryWorkerMutation,
} from "./task-flow-runtime-internal.js";
import { retainCommittedTaskFlowEffects } from "./task-registry-flow-sync.js";
import {
  taskFlowSyncOwner,
  syncFlowFromTaskAfterTaskMutationAsync,
  tasks,
} from "./task-registry-state.js";
import { getTaskRegistryStore, type TaskRegistryStore } from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";

const log = createSubsystemLogger("tasks/executor");
type FlowStore = ReturnType<typeof getTaskFlowRegistryStore>;
type TaskCancellationSettlement = { committedFlowId?: string };

export function captureTaskMutationContext(): TaskMutationContext {
  const context = captureOpenClawStateWorkerContext();
  const store = getTaskRegistryStore();
  const flowStore = getTaskFlowRegistryStore();
  return {
    context,
    store,
    flowStore,
    assertStores() {
      context.admission.assertCurrent();
      if (getTaskRegistryStore() !== store || getTaskFlowRegistryStore() !== flowStore) {
        throw new Error("Task mutation lost its selected registry owners");
      }
    },
  };
}

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
  const cancellation: TaskCancellationSettlement = {};
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
    const cancellationSettled =
      options.operation !== "update" ||
      (await finishManagedTaskCancellation(
        context,
        store,
        flowStore,
        taskId,
        options.assertCurrent,
        cancellation,
      ));
    if (!flowSettled || !cancellationSettled) {
      retainTaskMutationFlowEffects(
        context,
        store,
        flowStore,
        task,
        options.operation,
        cancellation,
      );
    }
    return flowSettled && cancellationSettled;
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    retainTaskMutationFlowEffects(context, store, flowStore, task, options.operation, cancellation);
    if (!isSqliteWorkerError(error, "overloaded")) {
      throw error;
    }
    return false;
  }
}

async function finishManagedTaskCancellation(
  context: OpenClawStateWorkerContext,
  store: TaskRegistryStore,
  flowStore: FlowStore,
  taskId: string,
  assertCurrent: () => void,
  settlement: TaskCancellationSettlement,
): Promise<boolean> {
  const flowId = settlement.committedFlowId ?? tasks.get(taskId)?.parentFlowId?.trim();
  if (!flowId) {
    return true;
  }
  try {
    assertCurrent();
    if (settlement.committedFlowId) {
      const read = await prepareTaskFlowRegistryRead(context);
      assertCurrent();
      return read?.isTaskFlowCurrent(settlement.committedFlowId) ?? false;
    }
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
      async () => {
        const result = await store.runInitialMutationAsync(
          context,
          { type: "flows.finalizeTaskCancellation", input: { taskId, flowId, now: Date.now() } },
          assertCurrent,
        );
        // Publication repair must never replay the acknowledged native cancellation.
        settlement.committedFlowId = flowId;
        return result;
      },
      async () => {
        assertCurrent();
        const flow = await flowStore.readFlowAsync(context, flowId);
        assertCurrent();
        return flow;
      },
    );
    return publicationSettled;
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error) || isSqliteWorkerError(error, "overloaded")) {
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
  cancellation: TaskCancellationSettlement = {},
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
        ? (retryContext) =>
            finishManagedTaskCancellation(
              retryContext,
              store,
              flowStore,
              task.taskId,
              () => owner.assertCurrent(retryContext, store),
              cancellation,
            )
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
