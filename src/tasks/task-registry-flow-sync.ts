import { isSqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { restoreAgentSchemaInspectionError } from "../state/openclaw-agent-schema-inspection-response.js";
import { runOutsideOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import {
  reconcileTaskFlowWorkerReceipts,
  runTaskFlowRegistryWorkerMutation,
  syncFlowFromTaskResult,
} from "./task-flow-runtime-internal.js";
import type {
  TaskMirroredFlowSyncOutcome,
  TaskRegistryRestoreResult,
} from "./task-registry-restore.worker.js";
import { getTaskRegistryStore, type TaskRegistryStore } from "./task-registry.store.js";
import type {
  TaskLiveFlowSelection,
  TaskLiveFlowSyncOutcome,
} from "./task-registry.store.types.js";
import type { TaskRecord } from "./task-registry.types.js";

const log = createSubsystemLogger("tasks/registry");
const TASK_FLOW_SYNC_RETRY_DELAYS_MS = [1_000, 5_000, 25_000, 120_000, 600_000] as const;
type TaskFlowSyncLiveOwner = {
  prepare: (
    context: OpenClawStateWorkerContext,
    store: TaskRegistryStore,
    maxAttempts: number,
  ) => Promise<boolean>;
  assertCurrent: (context: OpenClawStateWorkerContext, store: TaskRegistryStore) => void;
  selectCurrent: () => TaskLiveFlowSelection | undefined;
};
type TaskFlowSyncRetrySelection =
  | { kind: "restored" }
  | { kind: "live"; owner: TaskFlowSyncLiveOwner };
type TaskFlowSyncRetryTimer = {
  timer: ReturnType<typeof setTimeout>;
  kind: TaskFlowSyncRetrySelection["kind"];
};
const taskFlowSyncRetryTimers = new Map<TaskRegistryStore, Map<string, TaskFlowSyncRetryTimer>>();

async function syncLiveTaskFlow(
  context: OpenClawStateWorkerContext,
  store: TaskRegistryStore,
  owner: TaskFlowSyncLiveOwner,
): Promise<TaskLiveFlowSyncOutcome> {
  const prepared = await owner.prepare(context, store, 1);
  owner.assertCurrent(context, store);
  if (!prepared) {
    return { kind: "retry", reason: "projection_changed" };
  }
  const selected = owner.selectCurrent();
  if (!selected) {
    return { kind: "not-selected" };
  }
  const { taskId, flowId } = selected;
  const flowStore = getTaskFlowRegistryStore();
  const assertCurrent = () => {
    owner.assertCurrent(context, store);
    if (getTaskFlowRegistryStore() !== flowStore) {
      throw new Error("Live task-flow retry store is no longer current");
    }
  };
  const outcome = await runTaskFlowRegistryWorkerMutation(
    { flowId, admission: context.admission },
    () =>
      store.syncLiveTaskFlowAsync(
        context,
        { taskId, flowId },
        {
          assertCurrent,
          isSelected(selection) {
            const latest = owner.selectCurrent();
            return (
              latest?.taskId === selection.taskId &&
              latest.flowId === selection.flowId &&
              latest.createdAt === selection.createdAt
            );
          },
        },
      ),
    async () => {
      assertCurrent();
      const flow = await flowStore.readFlowAsync(context, flowId);
      assertCurrent();
      return flow;
    },
  );
  assertCurrent();
  return outcome;
}

export function clearTaskFlowSyncRetries(kind?: TaskFlowSyncRetrySelection["kind"]): void {
  for (const [store, timers] of taskFlowSyncRetryTimers) {
    for (const [key, retry] of timers) {
      if (kind === undefined || retry.kind === kind) {
        clearTimeout(retry.timer);
        timers.delete(key);
      }
    }
    if (timers.size === 0) {
      taskFlowSyncRetryTimers.delete(store);
    }
  }
}

function scheduleTaskFlowSyncRetry(
  context: OpenClawStateWorkerContext,
  store: TaskRegistryStore,
  taskId: string,
  operation: string,
  selection: TaskFlowSyncRetrySelection,
  attempt = 0,
): void {
  const id = taskId.trim();
  const identityKey = context.admission.identity.key;
  const key = `${identityKey}\u0000${selection.kind}\u0000${id}`;
  const timers = taskFlowSyncRetryTimers.get(store) ?? new Map<string, TaskFlowSyncRetryTimer>();
  if (!id || timers.has(key)) {
    return;
  }
  const delayMs = TASK_FLOW_SYNC_RETRY_DELAYS_MS[attempt];
  if (delayMs === undefined) {
    log.warn("Exhausted parent flow sync retries from task", { operation, taskId: id });
    return;
  }
  const retry = () => {
    timers.delete(key);
    if (timers.size === 0) {
      taskFlowSyncRetryTimers.delete(store);
    }
    void runWithGatewayIndependentRootWorkAdmission(async () => {
      const current = captureOpenClawStateWorkerContext({
        path: context.admission.databasePath,
        env: context.environment,
      });
      if (current.admission.identity.key !== identityKey) {
        return;
      }
      if (selection.kind === "live") {
        if (getTaskRegistryStore() !== store) {
          return;
        }
        let outcome: TaskLiveFlowSyncOutcome;
        try {
          outcome = await syncLiveTaskFlow(current, store, selection.owner);
        } catch (error) {
          if (isSqliteWorkerError(error, "overloaded")) {
            current.admission.assertCurrent();
            if (getTaskRegistryStore() === store) {
              scheduleTaskFlowSyncRetry(current, store, id, operation, selection, attempt + 1);
            }
          }
          throw error;
        }
        const failure =
          outcome.kind === "result" && !outcome.result.ok ? outcome.result : undefined;
        if (outcome.kind === "retry" || failure) {
          log.warn("Failed to retry parent flow sync from task", {
            operation,
            taskId: id,
            flowId: failure?.current.flowId,
            reason: outcome.kind === "retry" ? outcome.reason : failure?.reason,
          });
          scheduleTaskFlowSyncRetry(current, store, id, operation, selection, attempt + 1);
        }
        return;
      }
      // The durable row, link and latest-task order are reread by the same owner.
      let outcome: TaskMirroredFlowSyncOutcome;
      try {
        outcome = await store.syncTaskFlowAsync(current, { taskId: id });
      } catch (error) {
        if (isSqliteWorkerError(error, "overloaded")) {
          // Capacity rejects before dispatch; retain only the still-admitted bounded attempt.
          current.admission.assertCurrent();
          if (current.admission.identity.key === identityKey) {
            scheduleTaskFlowSyncRetry(current, store, id, operation, selection, attempt + 1);
          }
        }
        throw error;
      }
      if (outcome.kind === "error") {
        scheduleTaskFlowSyncRetry(current, store, id, operation, selection, attempt + 1);
        throw restoreAgentSchemaInspectionError(outcome.error);
      }
      if (!outcome.result.ok) {
        log.warn("Failed to retry parent flow sync from task", {
          operation,
          taskId: id,
          flowId: outcome.flowId,
          reason: outcome.result.reason,
        });
        scheduleTaskFlowSyncRetry(current, store, id, operation, selection, attempt + 1);
      }
      if (outcome.flowId) {
        await reconcileTaskFlowWorkerReceipts(current, [outcome.flowId]);
      }
    }, "tasks:mutation").catch((error: unknown) => {
      log.warn("Failed to admit parent flow sync retry from task", {
        operation,
        taskId: id,
        error,
      });
    });
  };
  const timer = runOutsideOpenClawDatabaseMaintenanceScope(() => setTimeout(retry, delayMs));
  timer.unref?.();
  timers.set(key, { timer, kind: selection.kind });
  taskFlowSyncRetryTimers.set(store, timers);
}

/** Returned settlement remains durable even when its registry projection is superseded. */
export function retainTaskRegistryRestoreFlowObligations(
  context: OpenClawStateWorkerContext,
  store: TaskRegistryStore,
  settledTasks: readonly TaskRecord[],
): void {
  for (const task of settledTasks) {
    if (task.parentFlowId?.trim()) {
      scheduleTaskFlowSyncRetry(context, store, task.taskId, "restore", { kind: "restored" });
    }
  }
}

/** Register durable follow-up before a superseded projection receipt can be discarded. */
export function receiveTaskRegistryRestoreResult(
  result: TaskRegistryRestoreResult,
  context: OpenClawStateWorkerContext,
  store: TaskRegistryStore,
): void {
  let firstError: Error | undefined;
  for (const outcome of result.flowSyncs) {
    if (outcome.kind === "error") {
      scheduleTaskFlowSyncRetry(context, store, outcome.taskId, "restore", { kind: "restored" });
      firstError ??= restoreAgentSchemaInspectionError(outcome.error);
      continue;
    }
    if (!outcome.result.ok) {
      log.warn("Failed to sync parent flow from task mutation", {
        operation: "restore",
        taskId: outcome.taskId,
        flowId: outcome.flowId,
        reason: outcome.result.reason,
      });
      scheduleTaskFlowSyncRetry(context, store, outcome.taskId, "restore", { kind: "restored" });
    }
  }
  if (firstError) {
    throw firstError;
  }
}

/** Initial synchronous mutation ordering stays intact; retries use the awaited live owner. */
export function syncTaskFlowWithLiveRetry(
  task: TaskRecord,
  operation: string,
  owner: TaskFlowSyncLiveOwner,
): void {
  const result = syncFlowFromTaskResult(task);
  if (result.ok) {
    return;
  }
  log.warn("Failed to sync parent flow from task mutation", {
    operation,
    taskId: task.taskId,
    flowId: task.parentFlowId,
    reason: result.reason,
  });
  try {
    scheduleTaskFlowSyncRetry(
      captureOpenClawStateWorkerContext(),
      getTaskRegistryStore(),
      task.taskId,
      operation,
      { kind: "live", owner },
    );
  } catch (error) {
    log.warn("Failed to admit parent flow sync retry from task", {
      operation,
      taskId: task.taskId,
      error,
    });
  }
}
