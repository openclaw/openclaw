import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "../infra/errors.js";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import type { OpenClawStateDatabaseReadAdmission } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  openClawStateDatabaseCache,
  registerOpenClawStateDatabaseLifecycleListener,
} from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { restoreTaskExecutionSnapshot } from "./task-execution-owner.js";
import { syncFlowFromTaskResult } from "./task-flow-runtime-internal.js";
import {
  cloneTaskRecord,
  listTasksFromIndex,
  cloneTaskRecordForObserver,
  getTaskRelatedSessionIndexKeys,
  normalizeTaskTimestamps,
} from "./task-registry-records.js";
import {
  getTaskRegistryProcessState,
  type PendingTaskRegistryMutation,
} from "./task-registry.process-state.js";
import {
  getTaskRegistryObservers,
  getTaskRegistryStore,
  type TaskRegistryObserverEvent,
} from "./task-registry.store.js";
import type {
  TaskRegistryMutationScope,
  TaskRegistryStoreSnapshot,
} from "./task-registry.store.types.js";
import type { TaskRecord, TaskRuntime } from "./task-registry.types.js";

export const taskRegistryLog = createSubsystemLogger("tasks/registry");
const TASK_FLOW_SYNC_RETRY_DELAYS_MS = [1_000, 5_000, 25_000, 120_000, 600_000] as const;

const taskRegistryProcessState = getTaskRegistryProcessState();
const TASK_REGISTRY_REVISION_KEY = Symbol.for("openclaw.taskRegistry.revision");
type TaskRegistryRevisionGlobal = typeof globalThis & {
  [TASK_REGISTRY_REVISION_KEY]?: { value: number };
};
// SAFETY: This symbol owns the process-global revision cell assigned below.
const taskRegistryRevisionGlobal = globalThis as TaskRegistryRevisionGlobal;
const taskRegistryRevisionState = (taskRegistryRevisionGlobal[TASK_REGISTRY_REVISION_KEY] ??= {
  value: 0,
});

export function readTaskRegistryRevision(): number {
  return taskRegistryRevisionState.value;
}

export function bumpTaskRegistryRevision(invalidateWorkerReads = true): void {
  taskRegistryRevisionState.value += 1;
  if (invalidateWorkerReads) {
    taskRegistryProcessState.projection.epoch += 1;
  }
}

export const tasks = taskRegistryProcessState.tasks;
export const taskDeliveryStates = taskRegistryProcessState.taskDeliveryStates;
const taskIdsByRunId = taskRegistryProcessState.taskIdsByRunId;
export const taskIdsByOwnerKey = taskRegistryProcessState.taskIdsByOwnerKey;
export const taskIdsByParentFlowId = taskRegistryProcessState.taskIdsByParentFlowId;
export const taskIdsByRelatedSessionKey = taskRegistryProcessState.taskIdsByRelatedSessionKey;
export const tasksWithPendingDelivery = taskRegistryProcessState.tasksWithPendingDelivery;
export const taskActivityByTaskId = taskRegistryProcessState.taskActivityByTaskId;
export const taskProgressBatches = taskRegistryProcessState.taskProgressBatches;
type TaskRegistryRestoreState =
  | { status: "uninitialized" }
  | { status: "restoring" }
  | { status: "ready" }
  | { status: "failed"; error: Error };
let taskRegistryRestoreState: TaskRegistryRestoreState = { status: "uninitialized" };
const taskFlowSyncRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let listenerStarter: () => void = () => {};

export function setTaskRegistryListenerStarter(starter: () => void): void {
  listenerStarter = starter;
}

export function claimTaskRegistryListenerStart(): boolean {
  if (taskRegistryProcessState.listenerStop !== undefined) {
    return false;
  }
  taskRegistryProcessState.listenerStop = null;
  return true;
}

export function setTaskRegistryListenerStop(stop: (() => void) | null): void {
  taskRegistryProcessState.listenerStop = stop;
}

export function resetTaskRegistryListenerState(): void {
  taskRegistryProcessState.listenerStop?.();
  taskRegistryProcessState.listenerStop = undefined;
  clearTaskProgressBatches();
}

function clearTaskProgressBatches(): void {
  for (const batch of taskProgressBatches.values()) {
    clearTimeout(batch.timer);
  }
  taskProgressBatches.clear();
}

function clearTaskFlowSyncRetries(): void {
  for (const timer of taskFlowSyncRetryTimers.values()) {
    clearTimeout(timer);
  }
  taskFlowSyncRetryTimers.clear();
}

export function snapshotTaskRecords(source: ReadonlyMap<string, TaskRecord>): TaskRecord[] {
  return [...source.values()].map((record) => cloneTaskRecord(record));
}

export function emitTaskRegistryObserverEvent(createEvent: () => TaskRegistryObserverEvent): void {
  const observers = getTaskRegistryObservers();
  if (
    !observers?.onEvent &&
    taskRegistryProcessState.projection.pending.size === 0 &&
    taskRegistryProcessState.changeListeners.size === 0
  ) {
    return;
  }
  try {
    const event = createEvent();
    recordTaskRegistryPublication(event);
    observers?.onEvent?.(event);
  } catch (error) {
    taskRegistryLog.warn("Task registry observer failed", {
      event: "task-registry",
      error,
    });
  } finally {
    for (const listener of taskRegistryProcessState.changeListeners) {
      try {
        listener();
      } catch (error) {
        taskRegistryLog.warn("Task registry change listener failed", { error });
      }
    }
  }
}

/** Subscribe to the existing publication owner; readers recheck current task authority. */
export function onTaskRegistryChange(listener: () => void): () => void {
  taskRegistryProcessState.changeListeners.add(listener);
  return () => taskRegistryProcessState.changeListeners.delete(listener);
}

export function clearTaskRegistryMemory(): void {
  clearTaskFlowSyncRetries();
  clearTaskProgressBatches();
  for (const activity of taskActivityByTaskId.values()) {
    if (activity.flushTimer) {
      clearTimeout(activity.flushTimer);
    }
  }
  taskActivityByTaskId.clear();
  tasks.clear();
  bumpTaskRegistryRevision();
  taskDeliveryStates.clear();
  taskIdsByRunId.clear();
  taskIdsByOwnerKey.clear();
  taskIdsByParentFlowId.clear();
  taskIdsByRelatedSessionKey.clear();
  tasksWithPendingDelivery.clear();
}

export function addRunIdIndex(taskId: string, runId?: string) {
  const trimmed = runId?.trim();
  if (!trimmed) {
    return;
  }
  let ids = taskIdsByRunId.get(trimmed);
  if (!ids) {
    ids = new Set<string>();
    taskIdsByRunId.set(trimmed, ids);
  }
  ids.add(taskId);
}

function deleteRunIdIndex(taskId: string, runId?: string): void {
  if (runId?.trim()) {
    deleteIndexedKey(taskIdsByRunId, runId.trim(), taskId);
  }
}

function addIndexedKey(index: Map<string, Set<string>>, key: string, taskId: string) {
  let ids = index.get(key);
  if (!ids) {
    ids = new Set<string>();
    index.set(key, ids);
  }
  ids.add(taskId);
}

function deleteIndexedKey(index: Map<string, Set<string>>, key: string, taskId: string) {
  const ids = index.get(key);
  if (!ids) {
    return;
  }
  ids.delete(taskId);
  if (ids.size === 0) {
    index.delete(key);
  }
}

type TaskSessionKeys = Pick<TaskRecord, "requesterSessionKey" | "ownerKey" | "childSessionKey">;

export function addOwnerKeyIndex(taskId: string, task: Pick<TaskRecord, "ownerKey">) {
  const key = normalizeOptionalString(task.ownerKey);
  if (!key) {
    return;
  }
  addIndexedKey(taskIdsByOwnerKey, key, taskId);
}

export function deleteOwnerKeyIndex(taskId: string, task: Pick<TaskRecord, "ownerKey">) {
  const key = normalizeOptionalString(task.ownerKey);
  if (!key) {
    return;
  }
  deleteIndexedKey(taskIdsByOwnerKey, key, taskId);
}

export function addParentFlowIdIndex(taskId: string, task: Pick<TaskRecord, "parentFlowId">) {
  const key = task.parentFlowId?.trim();
  if (!key) {
    return;
  }
  addIndexedKey(taskIdsByParentFlowId, key, taskId);
}

export function deleteParentFlowIdIndex(taskId: string, task: Pick<TaskRecord, "parentFlowId">) {
  const key = task.parentFlowId?.trim();
  if (!key) {
    return;
  }
  deleteIndexedKey(taskIdsByParentFlowId, key, taskId);
}

export function addRelatedSessionKeyIndex(taskId: string, task: TaskSessionKeys) {
  for (const sessionKey of getTaskRelatedSessionIndexKeys(task)) {
    addIndexedKey(taskIdsByRelatedSessionKey, sessionKey, taskId);
  }
}

export function deleteRelatedSessionKeyIndex(taskId: string, task: TaskSessionKeys) {
  for (const sessionKey of getTaskRelatedSessionIndexKeys(task)) {
    deleteIndexedKey(taskIdsByRelatedSessionKey, sessionKey, taskId);
  }
}

export function rebuildRunIdIndex() {
  taskIdsByRunId.clear();
  for (const [taskId, task] of tasks.entries()) {
    addRunIdIndex(taskId, task.runId);
  }
}

export function getTasksByRunId(runId: string): TaskRecord[] {
  const ids = taskIdsByRunId.get(runId.trim());
  if (!ids || ids.size === 0) {
    return [];
  }
  return [...ids]
    .map((taskId) => tasks.get(taskId))
    .filter((task): task is TaskRecord => Boolean(task));
}

function taskRunScopeKey(
  task: Pick<TaskRecord, "runtime" | "scopeKind" | "ownerKey" | "childSessionKey">,
): string {
  return [
    task.runtime,
    task.scopeKind,
    normalizeOptionalString(task.ownerKey) ?? "",
    normalizeOptionalString(task.childSessionKey) ?? "",
  ].join("\u0000");
}

export function getTasksByRunScope(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
}): TaskRecord[] {
  const matches = getTasksByRunId(params.runId).filter(
    (task) => !params.runtime || task.runtime === params.runtime,
  );
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (sessionKey) {
    const childMatches = matches.filter(
      (task) => normalizeOptionalString(task.childSessionKey) === sessionKey,
    );
    if (childMatches.length > 0) {
      return childMatches;
    }
    const ownerMatches = matches.filter(
      (task) =>
        task.scopeKind === "session" && normalizeOptionalString(task.ownerKey) === sessionKey,
    );
    return ownerMatches;
  }
  const scopeKeys = new Set(matches.map((task) => taskRunScopeKey(task)));
  return scopeKeys.size <= 1 ? matches : [];
}

function scheduleTaskFlowSyncRetry(task: TaskRecord, operation: string, attempt = 0): void {
  const taskId = task.taskId.trim();
  if (!taskId || taskFlowSyncRetryTimers.has(taskId)) {
    return;
  }
  const delayMs = TASK_FLOW_SYNC_RETRY_DELAYS_MS[attempt];
  if (delayMs == null) {
    taskRegistryLog.warn("Exhausted parent flow sync retries from task", {
      operation,
      taskId,
      flowId: task.parentFlowId,
    });
    return;
  }
  const retryTimer = setTimeout(() => {
    taskFlowSyncRetryTimers.delete(taskId);
    // A terminal task no longer blocks suspension, but its durable parent-flow
    // projection still mutates state. Keep every delayed attempt visible and
    // prevent it from crossing a prepared host snapshot boundary.
    void runWithGatewayIndependentRootWorkAdmission(async () => {
      const current = tasks.get(taskId);
      if (!current) {
        return;
      }
      ensureTaskRegistryReady();
      const flowId = current.parentFlowId?.trim();
      if (
        !flowId ||
        listTasksFromIndex(tasks, taskIdsByParentFlowId, flowId)[0]?.taskId !== taskId
      ) {
        return;
      }
      const result = syncFlowFromTaskResult(current);
      if (!result.ok) {
        taskRegistryLog.warn("Failed to retry parent flow sync from task", {
          operation,
          taskId,
          flowId: current.parentFlowId,
          reason: result.reason,
        });
        scheduleTaskFlowSyncRetry(current, operation, attempt + 1);
      }
    }, "tasks:mutation").catch((error: unknown) => {
      taskRegistryLog.warn("Failed to admit parent flow sync retry from task", {
        operation,
        taskId,
        flowId: task.parentFlowId,
        error,
      });
    });
  }, delayMs);
  retryTimer.unref?.();
  taskFlowSyncRetryTimers.set(taskId, retryTimer);
}

export function syncFlowFromTaskAfterTaskMutation(task: TaskRecord, operation: string): void {
  const result = syncFlowFromTaskResult(task);
  if (result.ok) {
    return;
  }
  taskRegistryLog.warn("Failed to sync parent flow from task mutation", {
    operation,
    taskId: task.taskId,
    flowId: task.parentFlowId,
    reason: result.reason,
  });
  scheduleTaskFlowSyncRetry(task, operation);
}

export function restoreTaskRegistryOnce() {
  switch (taskRegistryRestoreState.status) {
    case "ready":
      return;
    case "failed":
      throw taskRegistryRestoreState.error;
    case "restoring":
      throw new Error("Task registry restore is already in progress.");
    case "uninitialized":
      break;
  }
  taskRegistryRestoreState = { status: "restoring" };
  try {
    const { snapshot: restored, settledTasks } =
      restoreTaskExecutionSnapshot(getTaskRegistryStore());

    clearTaskRegistryMemory();
    for (const [taskId, task] of restored.tasks) {
      tasks.set(taskId, task);
      addIndexes(task);
    }
    for (const [taskId, state] of restored.deliveryStates) {
      taskDeliveryStates.set(taskId, state);
    }
    taskRegistryRestoreState = { status: "ready" };
    markTaskRegistryProjectionRestored();
    for (const task of settledTasks) {
      const flowId = task.parentFlowId?.trim();
      if (
        flowId &&
        listTasksFromIndex(tasks, taskIdsByParentFlowId, flowId)[0]?.taskId === task.taskId
      ) {
        syncFlowFromTaskAfterTaskMutation(task, "restore");
      }
    }
    if (restored.tasks.size || restored.deliveryStates.size) {
      emitTaskRegistryObserverEvent(() => ({ kind: "restored" }));
    }
  } catch (error) {
    clearTaskRegistryMemory();
    const message = formatErrorMessage(error);
    const restoreError = new Error(`Task registry restore failed: ${message}`, { cause: error });
    taskRegistryRestoreState = { status: "failed", error: restoreError };
    // Compact console logs omit structured metadata, so keep the rejected value visible there too.
    taskRegistryLog.warn("Failed to restore task registry", {
      error: message,
      consoleMessage: `Failed to restore task registry: ${message}`,
    });
    throw restoreError;
  }
}

export function ensureTaskRegistryReady(options?: { refreshProjection?: boolean }): void {
  restoreTaskRegistryOnce();
  listenerStarter();
  if (options?.refreshProjection !== false) {
    refreshTaskRegistryProjection();
  }
}

export function reloadTaskRegistryFromStore(): void {
  clearTaskRegistryMemory();
  taskRegistryRestoreState = { status: "uninitialized" };
  ensureTaskRegistryReady();
}

export function resetTaskRegistryRestoreState(): void {
  taskRegistryRestoreState = { status: "uninitialized" };
}

const projection = taskRegistryProcessState.projection;
const pendingMutations = projection.pending;
const dirtyScopes = projection.dirtyScopes;

registerOpenClawStateDatabaseLifecycleListener((event) => {
  if (event.kind !== "opened") {
    projection.dirty = true;
    bumpTaskRegistryRevision();
  }
});

function taskIdsInScope(scope?: TaskRegistryMutationScope): Iterable<string> {
  if (!scope) {
    return tasks.keys();
  }
  return new Set([
    scope.taskId,
    ...(scope.runId ? (taskIdsByRunId.get(scope.runId) ?? []) : []),
    ...(scope.childSessionKey ? (taskIdsByRelatedSessionKey.get(scope.childSessionKey) ?? []) : []),
  ]);
}

function matchesScope(task: TaskRecord, scope: TaskRegistryMutationScope): boolean {
  return (
    task.taskId === scope.taskId ||
    Boolean(scope.runId && task.runId?.trim() === scope.runId) ||
    Boolean(scope.childSessionKey && task.childSessionKey?.trim() === scope.childSessionKey)
  );
}

function markTaskRegistryProjectionRestored(): void {
  projection.dirty = false;
  dirtyScopes.clear();
  for (const pending of pendingMutations) {
    dirtyScopes.add(pending.scope);
  }
}

function removeIndexes(task: TaskRecord): void {
  deleteRunIdIndex(task.taskId, task.runId);
  deleteOwnerKeyIndex(task.taskId, task);
  deleteParentFlowIdIndex(task.taskId, task);
  deleteRelatedSessionKeyIndex(task.taskId, task);
}

function addIndexes(task: TaskRecord): void {
  addRunIdIndex(task.taskId, task.runId);
  addOwnerKeyIndex(task.taskId, task);
  addParentFlowIdIndex(task.taskId, task);
  addRelatedSessionKeyIndex(task.taskId, task);
}

function installSnapshot(
  snapshot: TaskRegistryStoreSnapshot,
  scope?: TaskRegistryMutationScope,
  invalidateWorkerReads = true,
): void {
  for (const taskId of taskIdsInScope(scope)) {
    const current = tasks.get(taskId);
    if (current && (!scope || matchesScope(current, scope)) && !snapshot.tasks.has(taskId)) {
      removeIndexes(current);
      tasks.delete(taskId);
      taskDeliveryStates.delete(taskId);
    }
  }
  for (const [taskId, record] of snapshot.tasks) {
    if (scope && !matchesScope(record, scope)) {
      continue;
    }
    const current = tasks.get(taskId);
    const next = normalizeTaskTimestamps(record);
    if (!isDeepStrictEqual(current, next)) {
      tasks.set(taskId, next);
      if (!current) {
        addIndexes(next);
      } else {
        if (current.runId !== next.runId) {
          deleteRunIdIndex(taskId, current.runId);
          addRunIdIndex(taskId, next.runId);
        }
        if (current.ownerKey !== next.ownerKey) {
          deleteOwnerKeyIndex(taskId, current);
          addOwnerKeyIndex(taskId, next);
        }
        if (current.parentFlowId !== next.parentFlowId) {
          deleteParentFlowIdIndex(taskId, current);
          addParentFlowIdIndex(taskId, next);
        }
        if (
          current.ownerKey !== next.ownerKey ||
          current.requesterSessionKey !== next.requesterSessionKey ||
          current.childSessionKey !== next.childSessionKey
        ) {
          deleteRelatedSessionKeyIndex(taskId, current);
          addRelatedSessionKeyIndex(taskId, next);
        }
      }
    }
    const delivery = snapshot.deliveryStates.get(taskId);
    if (delivery) {
      taskDeliveryStates.set(taskId, delivery);
    } else {
      taskDeliveryStates.delete(taskId);
    }
  }
  if (!scope) {
    for (const taskId of taskDeliveryStates.keys()) {
      if (!snapshot.deliveryStates.has(taskId)) {
        taskDeliveryStates.delete(taskId);
      }
    }
    for (const [taskId, delivery] of snapshot.deliveryStates) {
      taskDeliveryStates.set(taskId, delivery);
    }
  }
  bumpTaskRegistryRevision(invalidateWorkerReads);
}

function refreshUnderCustody(): void {
  if (!projection.dirty && dirtyScopes.size === 0) {
    return;
  }
  const store = getTaskRegistryStore();
  const snapshots =
    projection.dirty || !store.loadMutationSnapshot
      ? [{ snapshot: store.loadSnapshot(), scope: undefined }]
      : [...dirtyScopes].map((scope) => ({ snapshot: store.loadMutationSnapshot!(scope), scope }));
  const database = openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(
    resolveOpenClawStateSqlitePath(),
  );
  const previous = database?.db.isTransaction
    ? { tasks: new Map(tasks), deliveryStates: new Map(taskDeliveryStates) }
    : undefined;
  const publication = {
    stage() {
      for (const { snapshot, scope } of snapshots) {
        installSnapshot(snapshot, scope);
      }
      projection.dirty = false;
      dirtyScopes.clear();
      for (const pending of pendingMutations) {
        dirtyScopes.add(pending.scope);
      }
    },
    rollback() {
      if (previous) {
        installSnapshot(previous);
        // Restore insertion order too; legacy synchronous duplicate selection uses it.
        tasks.clear();
        for (const [taskId, task] of previous.tasks) {
          removeIndexes(task);
          tasks.set(taskId, task);
        }
        for (const task of tasks.values()) {
          addIndexes(task);
        }
      }
      projection.dirty = true;
      bumpTaskRegistryRevision();
    },
    commit() {
      bumpTaskRegistryRevision();
    },
  };
  if (!database || !stageSqliteTransactionState(database.db, publication)) {
    publication.stage();
  }
}

/** Keep canonical peer selection and all synchronous writes in one coordinator admission. */
export function withTaskRegistryMutation<T>(
  operation: () => T,
  onAdmissionFailure?: (error: unknown) => T,
): T {
  if (projection.mutationDepth > 0) {
    return operation();
  }
  ensureTaskRegistryReady({ refreshProjection: false });
  let entered = false;
  const admitted = () => {
    entered = true;
    projection.mutationDepth += 1;
    try {
      refreshUnderCustody();
      return operation();
    } finally {
      projection.mutationDepth -= 1;
    }
  };
  const store = getTaskRegistryStore();
  try {
    return store.withMutation ? store.withMutation(admitted) : admitted();
  } catch (error) {
    if (entered || !onAdmissionFailure) {
      throw error;
    }
    taskRegistryLog.warn("Failed to admit task registry mutation", { error });
    return onAdmissionFailure(error);
  }
}

function refreshTaskRegistryProjection(): void {
  if (projection.mutationDepth === 0 && (projection.dirty || dirtyScopes.size > 0)) {
    withTaskRegistryMutation(() => {});
  }
}

function recordTaskRegistryPublication(event: TaskRegistryObserverEvent): void {
  for (const pending of pendingMutations) {
    if (event.kind === "restored") {
      for (const task of tasks.values()) {
        if (matchesScope(task, pending.scope)) {
          pending.published.set(task.taskId, cloneTaskRecordForObserver(task));
        }
      }
    } else {
      const task = event.kind === "upserted" ? event.task : event.previous;
      if (matchesScope(task, pending.scope)) {
        pending.published.set(
          task.taskId,
          event.kind === "upserted" ? cloneTaskRecordForObserver(event.task) : undefined,
        );
      }
    }
  }
}

export async function runTaskRegistryWorkerMutation<T>(
  context: { scope: TaskRegistryMutationScope; admission: OpenClawStateDatabaseReadAdmission },
  mutate: () => Promise<T>,
  readCurrent: () => Promise<TaskRegistryStoreSnapshot>,
): Promise<T> {
  const { scope, admission } = context;
  admission.assertCurrent();
  const pending: PendingTaskRegistryMutation = {
    scope,
    published: new Map(
      [...taskIdsInScope(scope)]
        .flatMap((taskId) => {
          const task = tasks.get(taskId);
          return task && matchesScope(task, scope) ? [task] : [];
        })
        .map((task) => [task.taskId, cloneTaskRecordForObserver(task)]),
    ),
  };
  pendingMutations.add(pending);
  dirtyScopes.add(scope);
  bumpTaskRegistryRevision();
  try {
    return await mutate();
  } finally {
    dirtyScopes.add(scope);
    bumpTaskRegistryRevision();
    try {
      while (true) {
        admission.assertCurrent();
        const epoch = projection.epoch;
        const snapshot = await readCurrent();
        admission.assertCurrent();
        if (
          captureOpenClawStateDatabaseReadAdmission(resolveOpenClawStateSqlitePath()).identity
            .key !== admission.identity.key
        ) {
          projection.dirty = true;
          break;
        }
        if (epoch !== projection.epoch) {
          continue;
        }
        // Publishing a read advances UI cursors without invalidating other worker reads.
        installSnapshot(snapshot, scope, false);
        for (const taskId of new Set([...pending.published.keys(), ...snapshot.tasks.keys()])) {
          // Observers can synchronously mutate another task before its turn to publish.
          const next = tasks.get(taskId);
          const previous = pending.published.get(taskId);
          if (!isDeepStrictEqual(previous, next && cloneTaskRecordForObserver(next))) {
            if (next) {
              emitTaskRegistryObserverEvent(() => ({
                kind: "upserted",
                task: cloneTaskRecordForObserver(next),
                ...(previous ? { previous } : {}),
              }));
            } else if (previous) {
              emitTaskRegistryObserverEvent(() => ({ kind: "deleted", taskId, previous }));
            }
          }
        }
        dirtyScopes.delete(scope);
        break;
      }
    } catch (error) {
      taskRegistryLog.warn("Failed to reconcile managed child task after worker operation", {
        flowId: scope.flowId,
        error,
      });
    } finally {
      pendingMutations.delete(pending);
    }
  }
}
