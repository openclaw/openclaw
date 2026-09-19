import crypto from "node:crypto";
import { isSqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type {
  DetachedRunningTaskCreateParams,
  CreatedDetachedTaskRun,
} from "./detached-task-runtime-contract.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import {
  ensureTaskFlowRegistryReadyAsync,
  runTaskFlowRegistryWorkerMutation,
} from "./task-flow-runtime-internal.js";
import type { InitialTaskFlowLinkResult } from "./task-initial-flow.kernel.js";
import { isOneTaskFlowEligible } from "./task-initial-flow.rules.js";
import { clearTaskActivity, flushTaskActivity } from "./task-registry-activity.js";
import type { TaskCreateResult } from "./task-registry-create.kernel.js";
import {
  maybeDeliverTaskStateChangeUpdate,
  maybeDeliverTaskTerminalUpdate,
} from "./task-registry-delivery.js";
import { retainCommittedTaskFlowEffects } from "./task-registry-flow-sync.js";
import {
  cloneTaskRecord,
  isEquivalentTaskRecord,
  matchesTaskPersistenceReceipt,
  type CreateTaskRecordParams,
} from "./task-registry-records.js";
import {
  ensureTaskRegistryReadyAsync,
  assertTaskRegistryOwnerCurrent,
  runTaskRegistryWorkerMutation,
  taskFlowSyncOwner,
  syncFlowFromTaskAfterTaskMutationAsync,
  tasks,
} from "./task-registry-state.js";
import type { TaskRecordTransitionReceipt } from "./task-registry-transition.kernel.js";
import { getTaskRegistryStore, type TaskRegistryStore } from "./task-registry.store.js";
import type { TaskPersistenceReceipt, TaskRecord } from "./task-registry.types.js";

const log = createSubsystemLogger("tasks/executor");
type FlowStore = ReturnType<typeof getTaskFlowRegistryStore>;
type CoreTaskCreation = {
  task: TaskRecord;
  context: OpenClawStateWorkerContext;
  store: TaskRegistryStore;
  flowStore: FlowStore;
  assertStores: () => void;
};

export async function createRunningTaskRunCoreWithReceiptAsync(
  params: DetachedRunningTaskCreateParams,
  assertCurrent?: () => void,
): Promise<CreatedDetachedTaskRun | null> {
  const creation = await createTaskRun({ ...params, status: "running" }, assertCurrent);
  const acknowledged = cloneTaskRecord(creation.task);
  let settlement: Promise<boolean> | undefined;
  return {
    task: cloneTaskRecord(acknowledged),
    settleUnstarted(terminal, canSettle) {
      return (settlement ??= settleUnstartedTask(creation, acknowledged, terminal, canSettle));
    },
  };
}

async function createTaskRun(
  params: CreateTaskRecordParams,
  assertCurrent?: () => void,
): Promise<CoreTaskCreation> {
  const context = captureOpenClawStateWorkerContext();
  const store = getTaskRegistryStore();
  const flowStore = getTaskFlowRegistryStore();
  const input = { params: structuredClone(params), taskId: crypto.randomUUID(), now: Date.now() };
  const assertStores = () => {
    context.admission.assertCurrent();
    if (getTaskRegistryStore() !== store || getTaskFlowRegistryStore() !== flowStore) {
      throw new Error("Initial task mutation lost its selected registry owners");
    }
  };
  const assertCreationCurrent = () => {
    assertStores();
    assertCurrent?.();
  };
  assertCreationCurrent();
  await ensureTaskRegistryReadyAsync(context);
  assertCreationCurrent();
  if (input.params.parentFlowId?.trim()) {
    await ensureTaskFlowRegistryReadyAsync(context);
    assertCreationCurrent();
  }
  const scope = {
    taskId: input.taskId,
    runId: input.params.runId?.trim(),
    childSessionKey: input.params.childSessionKey?.trim(),
  };
  let committed: TaskCreateResult | undefined;
  let flowHookEntered = false;
  const created = await runTaskRegistryWorkerMutation(
    {
      scope,
      admission: context.admission,
      publicationRecords: () =>
        new Map<string, TaskRecord>(
          committed && committed.mutation !== "reused"
            ? [[committed.task.taskId, committed.task]]
            : [],
        ),
      beforeObservers: async () => {
        flowHookEntered = true;
        if (committed && committed.mutation !== "reused") {
          await finishTaskMutation(context, store, flowStore, committed.task.taskId, {
            operation: committed.mutation === "created" ? "create" : "update",
            assertCurrent: assertStores,
          });
        }
      },
      forcePublish: () => (committed?.mutation === "updated" ? committed.task : undefined),
    },
    async () => {
      const result = await store.runInitialMutationAsync(
        context,
        { type: "tasks.createRecord", input },
        assertCreationCurrent,
      );
      committed = result;
      return result;
    },
    () => store.loadMutationSnapshotAsync(context, scope),
  );
  if (!flowHookEntered && created.mutation !== "reused") {
    retainTaskMutationFlowEffects(
      context,
      store,
      flowStore,
      created.task,
      created.mutation === "created" ? "create" : "update",
    );
  }
  const task = await ensureSingleTaskFlowAsync(
    context,
    store,
    flowStore,
    created.task,
    input.params.requesterOrigin,
    assertCreationCurrent,
    assertStores,
  );
  return { task, context, store, flowStore, assertStores };
}

/** Cleanup keeps its original target and exact task even after its run cannot activate. */
async function settleUnstartedTask(
  creation: CoreTaskCreation,
  task: TaskRecord,
  terminal: Parameters<CreatedDetachedTaskRun["settleUnstarted"]>[0],
  canSettle: (task: TaskRecord) => boolean,
): Promise<boolean> {
  const { context, store, flowStore, assertStores } = creation;
  const runId = task.runId;
  assertStores();
  if (!runId?.trim() || !canSettle(task)) {
    return false;
  }
  const expectedTask: TaskPersistenceReceipt = {
    taskId: task.taskId,
    runtime: task.runtime,
    ownerKey: task.ownerKey,
    scopeKind: task.scopeKind,
    runId,
    childSessionKey: task.childSessionKey,
    createdAt: task.createdAt,
    taskKind: task.taskKind,
  };
  const assertCleanupCurrent = () => {
    assertStores();
    if (!canSettle(task)) {
      throw new Error("The unstarted task was adopted before cleanup admission");
    }
  };
  // Activity observers may reenter persistence, so flush before entering the worker transaction.
  try {
    assertTaskRegistryOwnerCurrent(context, store);
    const projected = tasks.get(task.taskId);
    if (projected && matchesTaskPersistenceReceipt(projected, expectedTask)) {
      flushTaskActivity(task.taskId);
    }
  } catch (error) {
    log.warn("Retained task cleanup no longer owns the active activity projection", {
      taskId: task.taskId,
      error,
    });
  }
  assertCleanupCurrent();
  const scope = { taskId: task.taskId };
  let committed: TaskRecordTransitionReceipt | null = null;
  let flowHookEntered = false;
  const settled = await runTaskRegistryWorkerMutation(
    {
      scope,
      admission: context.admission,
      publicationRecords: () =>
        new Map<string, TaskRecord>(committed ? [[committed.task.taskId, committed.task]] : []),
      beforeObservers: async () => {
        flowHookEntered = true;
        if (committed) {
          const current = tasks.get(task.taskId);
          if (
            committed.becomesTerminal &&
            current &&
            isEquivalentTaskRecord(current, committed.task)
          ) {
            clearTaskActivity(task.taskId);
          }
          await finishTaskMutation(context, store, flowStore, task.taskId, {
            operation: "update",
            assertCurrent: assertStores,
          });
        }
      },
      forcePublish: () => committed?.task,
    },
    async () => {
      const result = await store.runInitialMutationAsync(
        context,
        {
          type: "tasks.settleUnstarted",
          input: {
            taskId: task.taskId,
            expectedTask,
            terminal: {
              status: terminal.status,
              endedAt: terminal.endedAt,
              error: terminal.error,
              terminalSummary: terminal.terminalSummary,
            },
            now: Date.now(),
          },
        },
        assertCleanupCurrent,
      );
      committed = result;
      return result;
    },
    () => store.loadMutationSnapshotAsync(context, scope),
  );
  if (!flowHookEntered && settled) {
    retainTaskMutationFlowEffects(context, store, flowStore, settled.task, "update");
  }
  if (settled?.deliver && settled.task.deliveryStatus !== "not_applicable") {
    try {
      assertTaskRegistryOwnerCurrent(context, store);
      void maybeDeliverTaskStateChangeUpdate(task.taskId, settled.nextEvent);
      void maybeDeliverTaskTerminalUpdate(task.taskId);
    } catch (error) {
      log.warn("Committed task cleanup could not admit delivery publication", {
        taskId: task.taskId,
        error,
      });
    }
  }
  return settled !== null;
}

async function finishTaskMutation(
  context: OpenClawStateWorkerContext,
  store: TaskRegistryStore,
  flowStore: FlowStore,
  taskId: string,
  options: { operation: "create" | "update"; assertCurrent: () => void },
): Promise<void> {
  const task = tasks.get(taskId);
  const flowId = task?.parentFlowId?.trim();
  if (!task || !flowId) {
    return;
  }
  try {
    await ensureTaskFlowRegistryReadyAsync(context);
    options.assertCurrent();
    await syncFlowFromTaskAfterTaskMutationAsync(
      context,
      store,
      task,
      options.operation,
      flowStore,
    );
    if (options.operation === "update") {
      await finishManagedTaskCancellation(context, store, flowStore, taskId, options.assertCurrent);
    }
  } catch (error) {
    if (!isSqliteWorkerError(error, "overloaded")) {
      throw error;
    }
    retainTaskMutationFlowEffects(context, store, flowStore, task, options.operation);
  }
}

async function finishManagedTaskCancellation(
  context: OpenClawStateWorkerContext,
  store: TaskRegistryStore,
  flowStore: FlowStore,
  taskId: string,
  assertCurrent: () => void,
): Promise<void> {
  const flowId = tasks.get(taskId)?.parentFlowId?.trim();
  if (!flowId) {
    return;
  }
  try {
    assertCurrent();
    await ensureTaskFlowRegistryReadyAsync(context);
    assertCurrent();
    await runTaskFlowRegistryWorkerMutation(
      { flowId, admission: context.admission },
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
  } catch (error) {
    if (isSqliteWorkerError(error, "overloaded")) {
      throw error;
    }
    log.warn("Failed to finalize managed flow cancellation from task update", {
      taskId,
      flowId,
      error,
    });
  }
}

function retainTaskMutationFlowEffects(
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
        ? (retryContext) =>
            finishManagedTaskCancellation(retryContext, store, flowStore, task.taskId, () => {
              owner.assertCurrent(retryContext, store);
            })
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

async function ensureSingleTaskFlowAsync(
  context: OpenClawStateWorkerContext,
  store: TaskRegistryStore,
  flowStore: FlowStore,
  task: TaskRecord,
  requesterOrigin: CreateTaskRecordParams["requesterOrigin"],
  assertCurrent: () => void,
  assertStores: () => void,
): Promise<TaskRecord> {
  if (!isOneTaskFlowEligible(task)) {
    return cloneTaskRecord(task);
  }
  let createdFlow: TaskFlowRecord | undefined;
  let compensation: Promise<void> | undefined;
  const compensate = () =>
    (compensation ??= (async () => {
      const flow = createdFlow;
      if (!flow) {
        return;
      }
      await runTaskFlowRegistryWorkerMutation(
        { flowId: flow.flowId, admission: context.admission },
        () =>
          store.runInitialMutationAsync(
            context,
            { type: "flows.deleteUnlinkedForTask", input: { taskId: task.taskId, flow } },
            assertStores,
          ),
        () => flowStore.readFlowAsync(context, flow.flowId),
      );
    })());
  try {
    assertCurrent();
    await ensureTaskFlowRegistryReadyAsync(context);
    assertCurrent();
    const flowId = crypto.randomUUID();
    const created = await runTaskFlowRegistryWorkerMutation(
      { flowId, admission: context.admission },
      () =>
        store.runInitialMutationAsync(
          context,
          { type: "flows.createForTask", input: { taskId: task.taskId, flowId, requesterOrigin } },
          assertCurrent,
        ),
      () => flowStore.readFlowAsync(context, flowId),
    );
    if (!created.created) {
      return cloneTaskRecord(created.task ?? task);
    }
    createdFlow = created.flow;
    const scope = { taskId: task.taskId, flowId };
    let linkResult: InitialTaskFlowLinkResult | undefined;
    let flowHookEntered = false;
    const linked = await runTaskRegistryWorkerMutation(
      {
        scope,
        admission: context.admission,
        publicationRecords: () =>
          new Map<string, TaskRecord>(
            linkResult?.linked ? [[linkResult.task.taskId, linkResult.task]] : [],
          ),
        beforeObservers: async () => {
          flowHookEntered = true;
          if (linkResult?.linked) {
            await finishTaskMutation(context, store, flowStore, task.taskId, {
              operation: "update",
              assertCurrent: assertStores,
            });
          }
        },
      },
      async () => {
        const result = await store.runInitialMutationAsync(
          context,
          {
            type: "tasks.linkInitialFlow",
            input: { taskId: task.taskId, flow: created.flow, now: Date.now() },
          },
          assertCurrent,
        );
        linkResult = result;
        return result;
      },
      () => store.loadMutationSnapshotAsync(context, scope),
    );
    if (!flowHookEntered && linked.linked) {
      retainTaskMutationFlowEffects(context, store, flowStore, linked.task, "update");
    }
    if (!linked.linked) {
      await compensate();
    }
    return cloneTaskRecord(linked.task ?? task);
  } catch (error) {
    try {
      await compensate();
    } catch (cleanupError) {
      log.warn("Failed to settle the created one-task flow", {
        taskId: task.taskId,
        flowId: createdFlow?.flowId,
        error: cleanupError,
      });
    }
    log.warn("Failed to create one-task flow for detached run", {
      taskId: task.taskId,
      runId: task.runId,
      error,
    });
    return cloneTaskRecord(task);
  }
}
