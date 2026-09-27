import crypto from "node:crypto";
import type { SqliteWorkerNativeSettlementOwner } from "../infra/sqlite-worker-operation-settlement.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type {
  DetachedRunningTaskCreateParams,
  DetachedTaskCreateParams,
  CreatedDetachedTaskRun,
} from "./detached-task-runtime-contract.js";
import { captureTaskExecutionOwner } from "./task-execution-owner.js";
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
import { retainTaskAgentEventLineage } from "./task-registry-agent-event-lineage.js";
import { readTaskCreationEventTarget } from "./task-registry-agent-event-target.js";
import type { TaskCreateResult } from "./task-registry-create.kernel.js";
import { captureTaskRegistryReadFence } from "./task-registry-listener-state.js";
import {
  cloneTaskRecord,
  captureTaskPersistenceReceipt,
  matchesTaskPersistenceReceipt,
  type CreateTaskRecordParams,
} from "./task-registry-records.js";
import {
  ensureTaskRegistryReadyAsync,
  runTaskRegistryWorkerMutation,
  tasks,
} from "./task-registry-state.js";
import type { TaskRegistryStore } from "./task-registry.store.js";
import {
  isTerminalTaskStatus,
  type TaskPersistenceReceipt,
  type TaskRecord,
} from "./task-registry.types.js";
import { captureTaskRunOwnerBinding, getTaskRunOwner } from "./task-run-owner.js";

const log = createSubsystemLogger("tasks/executor");
type FlowStore = ReturnType<typeof getTaskFlowRegistryStore>;
type RunningTaskReceiptLineage = {
  current?: TaskPersistenceReceipt;
  close: () => void;
};

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

export async function createRunningTaskRunCoreAsync(
  params: DetachedRunningTaskCreateParams,
  assertCurrent?: () => void,
): Promise<TaskRecord> {
  return (await createTaskRun({ ...params, status: "running" }, assertCurrent)).task;
}

export async function createRunningTaskRunCoreWithReceiptAsync(
  params: DetachedRunningTaskCreateParams,
  assertCurrent?: () => void,
): Promise<CreatedDetachedTaskRun | null> {
  const lineage: RunningTaskReceiptLineage = { close() {} };
  try {
    const creation = await createTaskRun({ ...params, status: "running" }, assertCurrent, lineage);
    if (isTerminalTaskStatus(creation.task.status)) {
      lineage.close();
    }
    const receipt = createTaskRunReceipt(creation, lineage);
    let settlement: Promise<boolean> | undefined;
    return {
      task: receipt.task,
      bindRunOwner: receipt.bindRunOwner,
      finalizeActive: receipt.finalizeActive,
      settleUnstarted(terminal, canSettle) {
        return (settlement ??= receipt
          .settleUnstarted(terminal, canSettle)
          .then((task) => task !== null));
      },
    };
  } catch (error) {
    lineage.close();
    throw error;
  }
}

export async function createQueuedTaskRunCoreWithReceiptAsync(
  params: DetachedTaskCreateParams,
  assertCurrent?: () => void,
): Promise<CreatedTaskRunReceipt> {
  const receipt = createTaskRunReceipt(
    await createTaskRun({ ...params, status: "queued" }, assertCurrent),
  );
  return { task: receipt.task, settleUnstarted: receipt.settleUnstarted };
}

function createTaskRunReceipt(
  creation: CoreTaskCreation,
  lineage?: RunningTaskReceiptLineage,
): CreatedTaskRunReceipt & Pick<CreatedDetachedTaskRun, "bindRunOwner" | "finalizeActive"> {
  const acknowledged = cloneTaskRecord(creation.task);
  const readAcknowledged = () => {
    if (lineage?.current) {
      acknowledged.createdAt = lineage.current.createdAt;
    }
    return acknowledged;
  };
  let settlement: Promise<TaskRecord | null> | undefined;
  return {
    task: cloneTaskRecord(acknowledged),
    async bindRunOwner(cancel, assertCurrent) {
      const binding = captureTaskRunOwnerBinding(
        captureTaskPersistenceReceipt(readAcknowledged()),
        cancel,
      );
      const assertBindingCurrent = () => {
        creation.assertStores();
        assertCurrent();
        binding.assertCurrent();
      };
      assertBindingCurrent();
      const executionOwner = captureTaskExecutionOwner();
      while (true) {
        await captureTaskRegistryReadFence(creation.context.admission);
        assertBindingCurrent();
        const expectedTask = captureTaskPersistenceReceipt(readAcknowledged());
        const { receipt, publicationSettled } = await settleTaskRecordTransitionAsync(
          creation,
          {
            type: "tasks.bindRunOwner",
            input: {
              taskId: expectedTask.taskId,
              expectedTask,
              params: { runId: expectedTask.runId, executionOwner },
              now: Date.now(),
            },
          },
          assertBindingCurrent,
        );
        assertBindingCurrent();
        if (!publicationSettled) {
          throw new Error("Task run owner publication did not settle.");
        }
        if (receipt) {
          break;
        }
        // A null transition wrote nothing. Only this receipt's confirmed event
        // lineage permits reselection; errors and unknown writes never replay.
        await captureTaskRegistryReadFence(creation.context.admission);
        assertBindingCurrent();
        if (matchesTaskPersistenceReceipt(readAcknowledged(), expectedTask)) {
          throw new Error("Task no longer belongs to this live run.");
        }
      }
      await captureTaskRegistryReadFence(creation.context.admission);
      assertBindingCurrent();
      const bound = binding.bind(captureTaskPersistenceReceipt(readAcknowledged()));
      const readCurrent = () => {
        creation.assertStores();
        const current = tasks.get(acknowledged.taskId);
        if (
          !current ||
          getTaskRunOwner(current) !== bound.owner ||
          !matchesTaskPersistenceReceipt(current, captureTaskPersistenceReceipt(readAcknowledged()))
        ) {
          throw new Error("Task creation receipt was replaced or removed.");
        }
        return current;
      };
      bound.owner.readCurrent = readCurrent;
      bound.owner.resumeExecution = async (assertExecutionCurrent) => {
        const assertOwned = () => {
          readCurrent();
          assertExecutionCurrent();
        };
        await captureTaskRegistryReadFence(creation.context.admission);
        assertOwned();
        const expectedTask = captureTaskPersistenceReceipt(readAcknowledged());
        const result = await settleTaskRecordTransitionAsync(
          creation,
          {
            type: "tasks.bindRunOwner",
            input: {
              taskId: expectedTask.taskId,
              expectedTask,
              params: { runId: expectedTask.runId, clearLastToolName: true },
              now: Date.now(),
            },
          },
          assertOwned,
        );
        assertOwned();
        if (!result.publicationSettled || result.receipt?.task.status !== "running") {
          throw new Error("Task successor activation did not settle.");
        }
      };
      return {
        owner: bound.owner,
        release() {
          bound.release();
          lineage?.close();
        },
      };
    },
    finalizeActive(terminal, canSettle) {
      return finalizeActiveTaskRun(creation, readAcknowledged(), terminal, canSettle).finally(() =>
        lineage?.close(),
      );
    },
    settleUnstarted(terminal, canSettle) {
      return (settlement ??= (async () => {
        // Cleanup still owes its terminal write after a committed event reports failure.
        if (lineage) {
          await Promise.allSettled([captureTaskRegistryReadFence(creation.context.admission)]);
        }
        return settleUnstartedTask(creation, readAcknowledged(), terminal, canSettle);
      })().finally(() => lineage?.close()));
    },
  };
}

async function createTaskRun(
  params: CreateTaskRecordParams,
  assertCurrent?: () => void,
  lineage?: RunningTaskReceiptLineage,
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
  if (lineage) {
    lineage.close = retainTaskAgentEventLineage(
      context.admission,
      input.params.runId?.trim() ?? "",
      (previous, next) => {
        const original =
          lineage.current ??
          readTaskCreationEventTarget(
            creationOwner?.committed?.facts,
            "tasks.createRecord",
            input.taskId,
          ) ??
          committed?.task;
        if (original && matchesTaskPersistenceReceipt(original, previous)) {
          lineage.current = captureTaskPersistenceReceipt(next);
        }
      },
    );
  }
  const created = await runTaskRegistryWorkerMutation(
    {
      scope,
      admission: context.admission,
      // Creation only inserts this ID or rewrites an exact run match, never other session runs.
      readIdentity: { kind: "creation", taskId: scope.taskId, runId: scope.runId },
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
