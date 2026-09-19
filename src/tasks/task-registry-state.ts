import { isDeepStrictEqual } from "node:util";
import { formatErrorMessage } from "../infra/errors.js";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { OpenClawStateDatabaseReadAdmission } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  openClawStateDatabaseCache,
  registerOpenClawStateDatabaseLifecycleListener,
} from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { restoreTaskExecutionSnapshot } from "./task-execution-owner.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import { reconcileTaskFlowWorkerReceipts } from "./task-flow-runtime-internal.js";
import {
  clearTaskFlowSyncRetries,
  receiveTaskRegistryRestoreResult,
  retainTaskRegistryRestoreFlowObligations,
  syncTaskFlowWithLiveRetry,
  syncTaskFlowWithLiveRetryAsync,
} from "./task-registry-flow-sync.js";
import {
  listTasksFromIndex,
  normalizeTaskTimestamps,
  filterTasksByRunScope,
} from "./task-registry-records.js";
import { createAsyncRegistryRestore, createSyncRegistryReader } from "./task-registry-restore.js";
import type { TaskRegistryRestoreResult } from "./task-registry-restore.worker.js";
import {
  createPendingTaskRegistryMutation,
  claimTaskRegistryPublication,
  publishTaskRegistryWorkerMutation,
  reconcileTaskRegistryWorkerSnapshot,
} from "./task-registry-worker-publication.js";
import {
  addRunIdIndex,
  addTaskIndexes,
  removeTaskIndexes,
  deleteRunIdIndex,
  addOwnerKeyIndex,
  deleteOwnerKeyIndex,
  addParentFlowIdIndex,
  deleteParentFlowIdIndex,
  addRelatedSessionKeyIndex,
  deleteRelatedSessionKeyIndex,
  getTaskRegistryProcessState,
  taskIdsInScope,
  matchesScope,
  recordTaskRegistryPublication,
  recordTaskRegistryProjectionWrite,
  selectLiveTaskFlowForSync,
  clearTaskProgressBatches,
} from "./task-registry.process-state.js";
import {
  deliverTaskRegistryObserverEvent,
  getTaskRegistryStore,
  loadTaskRegistryMutationSnapshots,
  type TaskRegistryStore,
} from "./task-registry.store.js";
import type {
  TaskRegistryMutationScope,
  TaskRegistryStoreSnapshot,
  TaskRegistryObserverEvent,
} from "./task-registry.store.types.js";
import type { TaskRecord, TaskRuntime } from "./task-registry.types.js";

export const taskRegistryLog = createSubsystemLogger("tasks/registry");

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
  | { status: "uninitialized"; admission?: OpenClawStateDatabaseReadAdmission }
  | { status: "restoring" | "ready"; admission: OpenClawStateDatabaseReadAdmission }
  | { status: "failed"; error: Error; admission: OpenClawStateDatabaseReadAdmission };
let taskRegistryRestoreState: TaskRegistryRestoreState = { status: "uninitialized" };
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

export function emitTaskRegistryObserverEvent(createEvent: () => TaskRegistryObserverEvent): void {
  deliverTaskRegistryObserverEvent(createEvent, recordTaskRegistryPublication);
}

function clearTaskRegistryEphemeralState(): void {
  // Committed restore obligations outlive replacement of their in-memory projection.
  clearTaskFlowSyncRetries("live");
  clearTaskProgressBatches();
  for (const activity of taskActivityByTaskId.values()) {
    if (activity.flushTimer) {
      clearTimeout(activity.flushTimer);
    }
  }
  taskActivityByTaskId.clear();
  tasksWithPendingDelivery.clear();
}

export function clearTaskRegistryMemory(): void {
  clearTaskRegistryEphemeralState();
  tasks.clear();
  bumpTaskRegistryRevision();
  taskDeliveryStates.clear();
  taskIdsByRunId.clear();
  taskIdsByOwnerKey.clear();
  taskIdsByParentFlowId.clear();
  taskIdsByRelatedSessionKey.clear();
  recordTaskRegistryProjectionWrite("snapshot");
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

export function getTasksByRunScope(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
}): TaskRecord[] {
  return filterTasksByRunScope(getTasksByRunId(params.runId), params);
}

function installRestoredTaskRegistrySnapshot(snapshot: TaskRegistryStoreSnapshot): void {
  // A cold snapshot replaces durable rows in source order while preserving live owners.
  tasks.clear();
  taskDeliveryStates.clear();
  taskIdsByRunId.clear();
  taskIdsByOwnerKey.clear();
  taskIdsByParentFlowId.clear();
  taskIdsByRelatedSessionKey.clear();
  for (const [id, task] of snapshot.tasks) {
    tasks.set(id, task);
    addTaskIndexes(task);
  }
  for (const [id, delivery] of snapshot.deliveryStates) {
    taskDeliveryStates.set(id, delivery);
  }
  recordTaskRegistryProjectionWrite("snapshot");
}

function isCurrentTaskRegistryDatabase(admission: OpenClawStateDatabaseReadAdmission): boolean {
  const current = openClawStateDatabaseCache.getKnownOpenClawStateDatabaseIdentity(
    resolveOpenClawStateSqlitePath(),
  );
  return current?.key === admission.identity.key;
}

function getTaskRegistryRestoreState(admission: OpenClawStateDatabaseReadAdmission) {
  let requiresRestore =
    taskRegistryRestoreState.admission !== undefined &&
    taskRegistryRestoreState.admission.identity.key !== admission.identity.key;
  if (taskRegistryRestoreState.status === "ready") {
    try {
      taskRegistryRestoreState.admission.assertCurrent();
    } catch {
      // Worker-only close can retire admission without a native projection-dirty event.
      requiresRestore = true;
    }
  }
  if (requiresRestore) {
    // Retain the selected identity through async preparation and synchronous reentry.
    taskRegistryRestoreState = { status: "uninitialized", admission };
    bumpTaskRegistryRevision();
  }
  return taskRegistryRestoreState;
}

export function taskFlowSyncOwner(
  taskId: string,
  flowStore?: ReturnType<typeof getTaskFlowRegistryStore>,
) {
  return {
    prepare: prepareTaskRegistryProjectionAsync,
    assertCurrent(context: OpenClawStateWorkerContext, store: TaskRegistryStore) {
      assertTaskRegistryOwnerCurrent(context, store);
      if (flowStore !== undefined && getTaskFlowRegistryStore() !== flowStore) {
        throw new Error("Task flow registry owner is no longer current.");
      }
    },
    selectCurrent: () => selectLiveTaskFlowForSync(taskId),
  };
}

export function syncFlowFromTaskAfterTaskMutation(task: TaskRecord, operation: string): void {
  syncTaskFlowWithLiveRetry(task, operation, taskFlowSyncOwner(task.taskId));
}

export function syncFlowFromTaskAfterTaskMutationAsync(
  context: OpenClawStateWorkerContext,
  store: TaskRegistryStore,
  task: TaskRecord,
  operation: string,
  flowStore: ReturnType<typeof getTaskFlowRegistryStore>,
): Promise<void> {
  return syncTaskFlowWithLiveRetryAsync(
    context,
    store,
    task,
    operation,
    taskFlowSyncOwner(task.taskId, flowStore),
  );
}

function restoreTaskRegistryOnce() {
  const databasePath = resolveOpenClawStateSqlitePath();
  const admission = captureOpenClawStateDatabaseReadAdmission(databasePath);
  const state = getTaskRegistryRestoreState(admission);
  if (state.status === "ready") {
    return;
  }
  if (state.status === "failed") {
    throw state.error;
  }
  if (state.status === "restoring") {
    throw new Error("Task registry restore is already in progress.");
  }
  const store = getTaskRegistryStore();
  const workerContext = captureOpenClawStateWorkerContext({ path: databasePath });
  const restoring = (taskRegistryRestoreState = { status: "restoring", admission });
  const revision = readTaskRegistryRevision();
  const epoch = taskRegistryProcessState.projection.epoch;
  const ownsRestore = () =>
    taskRegistryRestoreState === restoring &&
    getTaskRegistryStore() === store &&
    resolveOpenClawStateSqlitePath() === databasePath;
  const reader = createSyncRegistryReader({
    admission,
    captureAdmission: () => captureOpenClawStateDatabaseReadAdmission(databasePath),
    isCurrent: () =>
      ownsRestore() &&
      readTaskRegistryRevision() === revision &&
      taskRegistryProcessState.projection.epoch === epoch,
    isCurrentDatabase: isCurrentTaskRegistryDatabase,
    loadSnapshot: () => store.loadSnapshot(),
    changedMessage: "Task registry restore changed before publication.",
  });
  let installing = false;
  let restoreResult: ReturnType<typeof restoreTaskExecutionSnapshot> | undefined;
  try {
    restoreResult = restoreTaskExecutionSnapshot(store, reader.loadSnapshot);
    reader.assertCurrent();
    const { snapshot: restored, settledTasks } = restoreResult;
    installing = true;
    if (state.admission) {
      bumpTaskRegistryRevision();
    } else {
      clearTaskRegistryMemory();
    }
    installRestoredTaskRegistrySnapshot(restored);
    taskRegistryRestoreState = { status: "ready", admission: reader.admission };
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
    if (restored.tasks.size > 0 || restored.deliveryStates.size > 0) {
      emitTaskRegistryObserverEvent(() => ({ kind: "restored" }));
    }
  } catch (error) {
    try {
      if (!installing && (reader.invalidated || !ownsRestore())) {
        if (taskRegistryRestoreState === restoring) {
          taskRegistryRestoreState = state;
        }
        throw error;
      }
      failTaskRegistryRestore(error, reader.admission, Boolean(state.admission));
    } finally {
      if (restoreResult) {
        retainTaskRegistryRestoreFlowObligations(
          { ...workerContext, admission: reader.admission },
          store,
          restoreResult.settledTasks,
        );
      }
    }
  }
}

export function ensureTaskRegistryReady(options?: { refreshProjection?: boolean }): void {
  restoreTaskRegistryOnce();
  listenerStarter();
  if (options?.refreshProjection !== false) {
    refreshTaskRegistryProjection();
  }
}

export const ensureTaskRegistryReadyAsync = createAsyncRegistryRestore<
  TaskRegistryRestoreResult,
  TaskRegistryStore
>({
  isCurrentDatabase: isCurrentTaskRegistryDatabase,
  getState: getTaskRegistryRestoreState,
  getRevision: readTaskRegistryRevision,
  getStore: getTaskRegistryStore,
  onReady: () => listenerStarter(),
  received: (result, context, store) => receiveTaskRegistryRestoreResult(result, context, store),
  async reconcile(result, context, store) {
    if (getTaskRegistryStore() !== store || !isCurrentTaskRegistryDatabase(context.admission)) {
      return;
    }
    try {
      await reconcileTaskFlowWorkerReceipts(
        context,
        result.flowSyncs.flatMap((outcome) => (outcome.flowId ? [outcome.flowId] : [])),
      );
    } catch (error) {
      if (taskRegistryRestoreState.status !== "failed") {
        throw error;
      }
      taskRegistryLog.warn("Failed to reconcile parent flows after task restore failure", {
        error,
      });
    }
  },
  install(result, context) {
    const { admission } = context;
    const restored = result.snapshot;
    installRestoredTaskRegistrySnapshot(restored);
    bumpTaskRegistryRevision();
    taskRegistryRestoreState = { status: "ready", admission };
    markTaskRegistryProjectionRestored();
    const installed = taskRegistryRestoreState;
    const revision = readTaskRegistryRevision();
    const store = getTaskRegistryStore();
    const isCurrent = () =>
      isCurrentTaskRegistryDatabase(admission) &&
      taskRegistryRestoreState === installed &&
      readTaskRegistryRevision() === revision &&
      getTaskRegistryStore() === store;
    return async (reconcile) => {
      try {
        await reconcile();
      } catch (error) {
        try {
          admission.assertCurrent();
        } catch {
          // The restore coordinator retains admission failure behind the operation failure.
          throw error;
        }
        if (isCurrent()) {
          failTaskRegistryRestore(error, admission);
        }
        throw error;
      }
      admission.assertCurrent();
      if (isCurrent() && (restored.tasks.size > 0 || restored.deliveryStates.size > 0)) {
        emitTaskRegistryObserverEvent(() => ({ kind: "restored" }));
      }
    };
  },
  fail: failTaskRegistryRestore,
});

export function assertTaskRegistryOwnerCurrent(
  context: OpenClawStateWorkerContext,
  store: TaskRegistryStore,
): void {
  context.admission.assertCurrent();
  if (getTaskRegistryStore() !== store || !isCurrentTaskRegistryDatabase(context.admission)) {
    throw new Error("Task registry read owner is no longer current.");
  }
}

async function prepareTaskRegistryProjectionAsync(
  context: OpenClawStateWorkerContext,
  store: TaskRegistryStore,
  maxAttempts = Number.POSITIVE_INFINITY,
): Promise<boolean> {
  assertTaskRegistryOwnerCurrent(context, store);
  await ensureTaskRegistryReadyAsync(context);
  assertTaskRegistryOwnerCurrent(context, store);
  let attempts = 0;
  while (projection.mutationDepth === 0 && (projection.dirty || dirtyScopes.size > 0)) {
    if (attempts++ >= maxAttempts) {
      return false;
    }
    const epoch = projection.epoch;
    const scopes = projection.dirty ? [undefined] : [...dirtyScopes];
    const snapshots = await loadTaskRegistryMutationSnapshots(context, store, scopes);
    assertTaskRegistryOwnerCurrent(context, store);
    if (epoch !== projection.epoch) {
      continue;
    }
    for (const { snapshot, scope } of snapshots) {
      installSnapshot(snapshot, scope);
    }
    // In-flight mutations retain their publication obligations after this read.
    markTaskRegistryProjectionRestored();
    return true;
  }
  return true;
}

function failTaskRegistryRestore(
  error: unknown,
  admission: OpenClawStateDatabaseReadAdmission,
  preserveLiveOwners = true,
): never {
  if (preserveLiveOwners) {
    installRestoredTaskRegistrySnapshot({ tasks: new Map(), deliveryStates: new Map() });
    bumpTaskRegistryRevision();
  } else {
    clearTaskRegistryMemory();
  }
  const message = formatErrorMessage(error);
  const restoreError = new Error(`Task registry restore failed: ${message}`, { cause: error });
  taskRegistryRestoreState = { status: "failed", error: restoreError, admission };
  // Compact console logs omit structured metadata, so keep the rejected value visible there too.
  taskRegistryLog.warn("Failed to restore task registry", {
    error: message,
    consoleMessage: `Failed to restore task registry: ${message}`,
  });
  throw restoreError;
}

export async function reloadTaskRegistryFromStoreAsync(
  context: OpenClawStateWorkerContext,
): Promise<void> {
  context.admission.assertCurrent();
  if (!isCurrentTaskRegistryDatabase(context.admission)) {
    return;
  }
  // Keep the published rows current until the replacement snapshot is installed.
  clearTaskRegistryEphemeralState();
  bumpTaskRegistryRevision();
  taskRegistryRestoreState = { status: "uninitialized", admission: context.admission };
  await ensureTaskRegistryReadyAsync(context);
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

function markTaskRegistryProjectionRestored(): void {
  projection.dirty = false;
  dirtyScopes.clear();
  for (const pending of pendingMutations) {
    dirtyScopes.add(pending.scope);
  }
}

function installSnapshot(
  snapshot: TaskRegistryStoreSnapshot,
  scope?: TaskRegistryMutationScope,
  invalidateWorkerReads = true,
  recordWrites = true,
): void {
  for (const taskId of taskIdsInScope(scope)) {
    const current = tasks.get(taskId);
    if (current && (!scope || matchesScope(current, scope)) && !snapshot.tasks.has(taskId)) {
      if (recordWrites) {
        recordTaskRegistryProjectionWrite("snapshot", taskId, true);
      }
      removeTaskIndexes(current);
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
      if (recordWrites) {
        recordTaskRegistryProjectionWrite("snapshot", taskId);
      }
      if (!current) {
        addTaskIndexes(next);
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
    if (recordWrites && !isDeepStrictEqual(taskDeliveryStates.get(taskId), delivery)) {
      recordTaskRegistryProjectionWrite("delivery", taskId);
    }
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
  if (recordWrites && !scope) {
    recordTaskRegistryProjectionWrite("snapshot");
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
  // Only commit supersedes held reads; rollback may restore a cache older than their snapshot.
  const publication = {
    stage() {
      for (const { snapshot, scope } of snapshots) {
        installSnapshot(snapshot, scope, true, false);
      }
      projection.dirty = false;
      dirtyScopes.clear();
      for (const pending of pendingMutations) {
        dirtyScopes.add(pending.scope);
      }
    },
    rollback() {
      if (previous) {
        installSnapshot(previous, undefined, true, false);
        // Restore insertion order too; legacy synchronous duplicate selection uses it.
        tasks.clear();
        for (const [taskId, task] of previous.tasks) {
          removeTaskIndexes(task);
          tasks.set(taskId, task);
        }
        for (const task of tasks.values()) {
          addTaskIndexes(task);
        }
      }
      projection.dirty = true;
      bumpTaskRegistryRevision();
    },
    commit() {
      recordTaskRegistryProjectionWrite("snapshot");
      bumpTaskRegistryRevision();
    },
  };
  if (!database || !stageSqliteTransactionState(database.db, publication)) {
    publication.stage();
    recordTaskRegistryProjectionWrite("snapshot");
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

export async function runTaskRegistryWorkerMutation<T>(
  context: {
    scope: TaskRegistryMutationScope;
    admission: OpenClawStateDatabaseReadAdmission;
    publicationRecords: () => ReadonlyMap<string, TaskRecord>;
    beforeObservers?: () => Promise<void>;
    forcePublish?: () => TaskRecord | undefined;
  },
  mutate: () => Promise<T>,
  readCurrent: () => Promise<TaskRegistryStoreSnapshot>,
): Promise<T> {
  const { scope, admission } = context;
  const store = getTaskRegistryStore();
  admission.assertCurrent();
  const pending = createPendingTaskRegistryMutation(scope);
  pendingMutations.add(pending);
  dirtyScopes.add(scope);
  bumpTaskRegistryRevision();
  try {
    return await mutate();
  } finally {
    dirtyScopes.add(scope);
    bumpTaskRegistryRevision();
    try {
      claimTaskRegistryPublication(pending, context.publicationRecords());
      const assertOwner = () => {
        admission.assertCurrent();
        if (!isCurrentTaskRegistryDatabase(admission) || getTaskRegistryStore() !== store) {
          projection.dirty = true;
          throw new Error("Task registry publication owner is no longer current.");
        }
      };
      const { conflicted } = await reconcileTaskRegistryWorkerSnapshot({
        pending,
        assertCurrent: assertOwner,
        read: readCurrent,
        install: (current) => installSnapshot(current, scope, false),
      });
      assertOwner();
      await context.beforeObservers?.();
      assertOwner();
      publishTaskRegistryWorkerMutation({
        pending,
        forced: context.forcePublish?.(),
        emit: emitTaskRegistryObserverEvent,
      });
      if (!conflicted) {
        dirtyScopes.delete(scope);
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
