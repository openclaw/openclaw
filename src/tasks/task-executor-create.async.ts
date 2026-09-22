import crypto from "node:crypto";
import type { SqliteWorkerNativeSettlementOwner } from "../infra/sqlite-worker-operation-settlement.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type {
  DetachedRunningTaskCreateParams,
  DetachedTaskCreateParams,
  CreatedDetachedTaskRun,
} from "./detached-task-runtime-contract.js";
import {
  captureTaskMutationContext,
  finishTaskMutation,
  retainTaskMutationFlowEffects,
} from "./task-executor-mutation-effects.async.js";
import { finalizeActiveTaskRun } from "./task-executor-terminal.async.js";
import { settleTaskRecordTransitionAsync } from "./task-executor-transition.async.js";
import type { CoreTaskCreation } from "./task-executor.types.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import {
  ensureTaskFlowRegistryReadyAsync,
  runTaskFlowRegistryWorkerMutation,
} from "./task-flow-runtime-internal.js";
import type { InitialTaskFlowLinkResult } from "./task-initial-flow.kernel.js";
import { isOneTaskFlowEligible } from "./task-initial-flow.rules.js";
import { readTaskCreationEventTarget } from "./task-registry-agent-event-target.js";
import type { TaskCreateResult } from "./task-registry-create.kernel.js";
import {
  cloneTaskRecord,
  captureTaskPersistenceReceipt,
  type CreateTaskRecordParams,
} from "./task-registry-records.js";
import {
  ensureTaskRegistryReadyAsync,
  runTaskRegistryWorkerMutation,
} from "./task-registry-state.js";
import type { TaskRegistryStore } from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";

const log = createSubsystemLogger("tasks/executor");
type FlowStore = ReturnType<typeof getTaskFlowRegistryStore>;

type CreatedTaskRunReceipt = {
  task: TaskRecord;
  settleUnstarted: (
    terminal: Parameters<CreatedDetachedTaskRun["settleUnstarted"]>[0] & {
      suppressDelivery?: boolean;
      lastEventAt?: number;
    },
    canSettle: (task: TaskRecord) => boolean,
  ) => Promise<TaskRecord | null>;
};

export async function createRunningTaskRunCoreWithReceiptAsync(
  params: DetachedRunningTaskCreateParams,
  assertCurrent?: () => void,
): Promise<CreatedDetachedTaskRun | null> {
  const creation = await createTaskRun({ ...params, status: "running" }, assertCurrent);
  const receipt = createTaskRunReceipt(creation);
  let settlement: Promise<boolean> | undefined;
  return {
    task: receipt.task,
    finalizeActive(terminal, canSettle) {
      return finalizeActiveTaskRun(creation, creation.task, terminal, canSettle);
    },
    settleUnstarted(terminal, canSettle) {
      return (settlement ??= receipt
        .settleUnstarted(terminal, canSettle)
        .then((task) => task !== null));
    },
  };
}

export async function createQueuedTaskRunCoreWithReceiptAsync(
  params: DetachedTaskCreateParams,
  assertCurrent?: () => void,
): Promise<CreatedTaskRunReceipt> {
  return createTaskRunReceipt(await createTaskRun({ ...params, status: "queued" }, assertCurrent));
}

function createTaskRunReceipt(creation: CoreTaskCreation): CreatedTaskRunReceipt {
  const acknowledged = cloneTaskRecord(creation.task);
  let settlement: Promise<TaskRecord | null> | undefined;
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
  const { context, store, flowStore, assertStores } = captureTaskMutationContext();
  const input = { params: structuredClone(params), taskId: crypto.randomUUID(), now: Date.now() };
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
    flowId: input.params.parentFlowId?.trim(),
    runId: input.params.runId?.trim(),
    childSessionKey: input.params.childSessionKey?.trim(),
  };
  let committed: TaskCreateResult | undefined;
  let creationOwner: SqliteWorkerNativeSettlementOwner | undefined;
  let flowHookEntered = false;
  const created = await runTaskRegistryWorkerMutation(
    {
      scope,
      admission: context.admission,
      readEventTarget: () =>
        readTaskCreationEventTarget(
          creationOwner?.committed?.facts,
          "tasks.createRecord",
          input.taskId,
        ),
      taskRowsWritten: () => committed?.persisted ?? false,
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
        (owner) => {
          creationOwner = owner;
        },
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
  terminal: Parameters<CreatedTaskRunReceipt["settleUnstarted"]>[0],
  canSettle: (task: TaskRecord) => boolean,
): Promise<TaskRecord | null> {
  creation.assertStores();
  if (!task.runId?.trim() || !canSettle(task)) {
    return null;
  }
  const assertCurrent = () => {
    creation.assertStores();
    if (!canSettle(task)) {
      throw new Error("The unstarted task was adopted before cleanup admission");
    }
  };
  const { receipt } = await settleTaskRecordTransitionAsync(
    creation,
    {
      type: "tasks.settleUnstarted",
      input: {
        taskId: task.taskId,
        expectedTask: captureTaskPersistenceReceipt(task),
        terminal: {
          status: terminal.status,
          endedAt: terminal.endedAt,
          error: terminal.error,
          terminalSummary: terminal.terminalSummary,
          suppressDelivery: terminal.suppressDelivery,
          lastEventAt: terminal.lastEventAt,
        },
        now: Date.now(),
      },
    },
    assertCurrent,
  );
  return receipt ? cloneTaskRecord(receipt.task) : null;
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
