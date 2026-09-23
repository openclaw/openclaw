import { isSqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runWithGatewayDetachedWorkContinuation } from "../process/gateway-work-admission.js";
import { restoreAgentSchemaInspectionError } from "../state/openclaw-agent-schema-inspection-response.js";
import { runOutsideOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import {
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
  | {
      kind: "live";
      owner: TaskFlowSyncLiveOwner;
      afterSync?: (context: OpenClawStateWorkerContext) => Promise<void>;
    };
type TaskFlowSyncRetryTimer = {
  timer: ReturnType<typeof setTimeout>;
  selection: TaskFlowSyncRetrySelection;
};
const taskFlowSyncRetryTimers = new Map<TaskRegistryStore, Map<string, TaskFlowSyncRetryTimer>>();

async function syncLiveTaskFlow(
  context: OpenClawStateWorkerContext,
  store: TaskRegistryStore,
  owner: TaskFlowSyncLiveOwner,
  projectionPrepared = false,
  onPublicationError?: (error: unknown) => void,
): Promise<TaskLiveFlowSyncOutcome> {
  const prepared = projectionPrepared || (await owner.prepare(context, store, 1));
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
    { flowId, admission: context.admission, onPublicationError },
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
      if (kind === undefined || retry.selection.kind === kind) {
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
  upgradePending = false,
): void {
  const id = taskId.trim();
  const identityKey = context.admission.identity.key;
  const key = `${identityKey}\u0000${selection.kind}\u0000${id}`;
  const timers = taskFlowSyncRetryTimers.get(store) ?? new Map<string, TaskFlowSyncRetryTimer>();
  if (!id) {
    return;
  }
  const pending = timers.get(key);
  if (pending) {
    if (selection.kind === "live" && pending.selection.kind === "live") {
      const hasIncomingEffects = selection.afterSync !== undefined;
      const hasPendingEffects = pending.selection.afterSync !== undefined;
      if (
        (hasIncomingEffects && !hasPendingEffects) ||
        (upgradePending && (hasIncomingEffects || !hasPendingEffects))
      ) {
        // Keep effects with their owner; an older retry cannot replace newer pending effects.
        pending.selection = selection;
      }
    }
    return;
  }
  const delayMs = TASK_FLOW_SYNC_RETRY_DELAYS_MS[attempt];
  if (delayMs === undefined) {
    log.warn("Exhausted parent flow sync retries from task", { operation, taskId: id });
    return;
  }
  const retry = () => {
    const retrySelection = scheduled.selection;
    timers.delete(key);
    if (timers.size === 0) {
      taskFlowSyncRetryTimers.delete(store);
    }
    void runWithGatewayDetachedWorkContinuation(async () => {
      const current = captureOpenClawStateWorkerContext({
        path: context.admission.databasePath,
        env: context.environment,
      });
      if (current.admission.identity.key !== identityKey) {
        return;
      }
      if (retrySelection.kind === "live") {
        if (getTaskRegistryStore() !== store) {
          return;
        }
        try {
          const outcome = await syncLiveTaskFlow(current, store, retrySelection.owner);
          const failure =
            outcome.kind === "result" && !outcome.result.ok ? outcome.result : undefined;
          if (outcome.kind === "retry" || failure) {
            log.warn("Failed to retry parent flow sync from task", {
              operation,
              taskId: id,
              flowId: failure?.current.flowId,
              reason: outcome.kind === "retry" ? outcome.reason : failure?.reason,
            });
            scheduleTaskFlowSyncRetry(current, store, id, operation, retrySelection, attempt + 1);
          } else {
            retrySelection.owner.assertCurrent(current, store);
            await retrySelection.afterSync?.(current);
            retrySelection.owner.assertCurrent(current, store);
          }
        } catch (error) {
          if (isSqliteWorkerError(error, "overloaded")) {
            current.admission.assertCurrent();
            if (getTaskRegistryStore() === store) {
              scheduleTaskFlowSyncRetry(current, store, id, operation, retrySelection, attempt + 1);
            }
          }
          throw error;
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
            scheduleTaskFlowSyncRetry(current, store, id, operation, retrySelection, attempt + 1);
          }
        }
        throw error;
      }
      if (outcome.kind === "error") {
        scheduleTaskFlowSyncRetry(current, store, id, operation, retrySelection, attempt + 1);
        throw restoreAgentSchemaInspectionError(outcome.error);
      }
      if (!outcome.result.ok) {
        log.warn("Failed to retry parent flow sync from task", {
          operation,
          taskId: id,
          flowId: outcome.flowId,
          reason: outcome.result.reason,
        });
        scheduleTaskFlowSyncRetry(current, store, id, operation, retrySelection, attempt + 1);
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
  const scheduled: TaskFlowSyncRetryTimer = { timer, selection };
  timers.set(key, scheduled);
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

/** Report completed flow work while retaining the existing retry when it is deferred. */
export async function syncTaskFlowWithLiveRetryAsync(
  context: OpenClawStateWorkerContext,
  store: TaskRegistryStore,
  task: TaskRecord,
  operation: string,
  owner: TaskFlowSyncLiveOwner,
): Promise<boolean> {
  let outcome: TaskLiveFlowSyncOutcome;
  let publicationSettled = true;
  try {
    outcome = await syncLiveTaskFlow(context, store, owner, true, () => {
      publicationSettled = false;
    });
  } catch (error) {
    if (!isSqliteWorkerError(error, "overloaded")) {
      throw error;
    }
    owner.assertCurrent(context, store);
    scheduleTaskFlowSyncRetry(context, store, task.taskId, operation, { kind: "live", owner });
    return false;
  }
  if (outcome.kind === "retry" || (outcome.kind === "result" && !outcome.result.ok)) {
    log.warn("Failed to sync parent flow from task mutation", {
      operation,
      taskId: task.taskId,
      flowId: task.parentFlowId,
    });
    scheduleTaskFlowSyncRetry(context, store, task.taskId, operation, { kind: "live", owner });
    return false;
  }
  return publicationSettled;
}

/** A known commit whose publication hook never ran still owns its flow follow-up. */
export function retainCommittedTaskFlowEffects(
  context: OpenClawStateWorkerContext,
  store: TaskRegistryStore,
  task: TaskRecord,
  operation: string,
  owner: TaskFlowSyncLiveOwner,
  afterSync?: (context: OpenClawStateWorkerContext) => Promise<void>,
): void {
  if (!task.parentFlowId?.trim()) {
    return;
  }
  owner.assertCurrent(context, store);
  // Upgrade pending work without moving its deadline or dropping cancellation settlement.
  scheduleTaskFlowSyncRetry(
    context,
    store,
    task.taskId,
    operation,
    { kind: "live", owner, afterSync },
    0,
    true,
  );
}
