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
import {
  clearTaskFlowSyncRetries,
  receiveTaskRegistryRestoreResult,
  retainTaskRegistryRestoreFlowObligations,
  syncTaskFlowWithLiveRetry,
  syncTaskFlowWithLiveRetryAsync,
} from "./task-registry-flow-sync.js";
import {
  hasPendingTaskRegistryEvents,
  startTaskRegistryListener,
  withPendingTaskRegistryEvents,
} from "./task-registry-listener-state.js";
import { createTaskRegistryProjectionPreparation } from "./task-registry-projection-prepare.js";
import {
  isEquivalentTaskRecord,
  listTasksFromIndex,
  normalizeTaskTimestamps,
} from "./task-registry-records.js";
import { createAsyncRegistryRestore, createSyncRegistryReader } from "./task-registry-restore.js";
import type { TaskRegistryRestoreResult } from "./task-registry-restore.worker.js";
import {
  createPendingTaskRegistryMutation,
  claimTaskRegistryPublication,
  publishTaskRegistryWorkerMutation,
  reconcileTaskRegistryWorkerSnapshot,
  type TaskRegistryWorkerMutationContext,
} from "./task-registry-worker-publication.js";
import {
  updateTaskIndexes,
  addTaskIndexes,
  removeTaskIndexes,
  getTaskRegistryProcessState,
  selectTaskRegistryScopes,
  captureTaskRegistryPublicationRollback,
  recordTaskRegistryPublication,
  recordTaskRegistryProjectionWrite,
  selectLiveTaskFlowForSync,
  clearTaskProgressBatches,
  clearTaskRegistryIndexes,
} from "./task-registry.process-state.js";
import {
  deliverTaskRegistryObserverEvent,
  getTaskRegistryStore,
  type TaskRegistryStore,
} from "./task-registry.store.js";
import type {
  TaskRegistryMutationScope,
  TaskRegistryStoreSnapshot,
  TaskRegistryObserverEvent,
} from "./task-registry.store.types.js";
import type { TaskRecord } from "./task-registry.types.js";

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

export function bumpTaskRegistryRevision(invalidateWorkerReads = true, changed = true): void {
  // Cold restore uses the public revision to reject snapshots taken before a write.
  if (changed || taskRegistryRestoreState.status !== "ready") {
    taskRegistryRevisionState.value += 1;
  }
  if (invalidateWorkerReads) {
    taskRegistryProcessState.projection.epoch += 1;
  }
}

export const tasks = taskRegistryProcessState.tasks;
export const taskDeliveryStates = taskRegistryProcessState.taskDeliveryStates;
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
  clearTaskRegistryIndexes();
  recordTaskRegistryProjectionWrite("snapshot");
}

export { getTasksByRunId, getTasksByRunScope } from "./task-registry.process-state.js";

function installRestoredTaskRegistrySnapshot(
  snapshot: TaskRegistryStoreSnapshot,
  committed = true,
): void {
  // Replace rows in snapshot order without disturbing live execution owners.
  tasks.clear();
  taskDeliveryStates.clear();
  clearTaskRegistryIndexes();
  for (const [id, task] of snapshot.tasks) {
    tasks.set(id, task);
    addTaskIndexes(task);
  }
  for (const [id, delivery] of snapshot.deliveryStates) {
    taskDeliveryStates.set(id, delivery);
  }
  if (committed) {
    recordTaskRegistryProjectionWrite("snapshot");
  }
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
): Promise<boolean> {
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
    const installed = taskRegistryRestoreState;
    const database = openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(databasePath);
    if (database?.db.isTransaction) {
      stageSqliteTransactionState(database.db, {
        stage() {},
        commit() {},
        rollback() {
          if (taskRegistryRestoreState === installed) {
            // An enclosing rollback can undo orphan settlement and snapshot inputs.
            taskRegistryRestoreState = { status: "uninitialized", admission: reader.admission };
            projection.dirty = true;
            bumpTaskRegistryRevision();
          }
        },
      });
    }
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
  startTaskRegistryListener();
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
  onReady: () => startTaskRegistryListener(),
  received: (result, context, store) => receiveTaskRegistryRestoreResult(result, context, store),
  async reconcile(_result, context, store, reconcileFlows) {
    if (getTaskRegistryStore() !== store || !isCurrentTaskRegistryDatabase(context.admission)) {
      return;
    }
    try {
      await reconcileFlows();
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

export const prepareTaskRegistryProjectionAsync = createTaskRegistryProjectionPreparation({
  ensureReady: ensureTaskRegistryReadyAsync,
  assertCurrent: assertTaskRegistryOwnerCurrent,
  installSnapshot,
  markRestored: markTaskRegistryProjectionRestored,
});

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
const { pending: pendingMutations, dirtyScopes } = projection;

registerOpenClawStateDatabaseLifecycleListener((event) => {
  if (event.kind === "opened") {
    return;
  }
  const admission = taskRegistryRestoreState.admission;
  // Physical aliases share an owner; its path also covers failed or replaced opens.
  if (
    admission &&
    (event.path === admission.databasePath || event.identity?.key === admission.identity.key)
  ) {
    invalidateTaskRegistryProjection();
  }
});

export function invalidateTaskRegistryProjection(): void {
  projection.dirty = true;
  bumpTaskRegistryRevision();
}

function markTaskRegistryProjectionRestored(): void {
  projection.dirty = false;
  dirtyScopes.clear();
  for (const pending of pendingMutations) {
    dirtyScopes.add(pending.scope);
  }
}

function installSnapshot(
  snapshot: TaskRegistryStoreSnapshot,
  scope?: TaskRegistryMutationScope | readonly TaskRegistryMutationScope[],
  invalidateWorkerReads = true,
  recordWrites: ReadonlyMap<string, TaskRecord> | "refresh" | false = "refresh",
): void {
  const scopes = scope && ("taskId" in scope ? [scope] : scope);
  const { matches, taskIds } = selectTaskRegistryScopes(scopes);
  let changed = false;
  for (const taskId of taskIds) {
    const current = tasks.get(taskId);
    if (current && matches(current) && !snapshot.tasks.has(taskId)) {
      if (recordWrites) {
        recordTaskRegistryProjectionWrite(recordWrites, taskId, true);
      }
      removeTaskIndexes(current);
      changed = tasks.delete(taskId) || changed;
      taskDeliveryStates.delete(taskId);
    }
  }
  for (const [taskId, record] of snapshot.tasks) {
    if (!matches(record)) {
      continue;
    }
    const current = tasks.get(taskId);
    const next = normalizeTaskTimestamps(record);
    if (!current || !isEquivalentTaskRecord(current, next)) {
      changed = true;
      tasks.set(taskId, next);
      if (recordWrites) {
        recordTaskRegistryProjectionWrite(recordWrites, taskId);
      }
      if (!current) {
        addTaskIndexes(next);
      } else {
        updateTaskIndexes(current, next);
      }
    } else if (recordWrites && recordWrites !== "refresh" && recordWrites.has(taskId)) {
      recordTaskRegistryProjectionWrite(recordWrites, taskId);
    }
    const delivery = snapshot.deliveryStates.get(taskId);
    const deliveryChanged = !isDeepStrictEqual(taskDeliveryStates.get(taskId), delivery);
    changed ||= deliveryChanged;
    if (recordWrites && deliveryChanged) {
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
        changed = taskDeliveryStates.delete(taskId) || changed;
      }
    }
    for (const [taskId, delivery] of snapshot.deliveryStates) {
      changed ||= !isDeepStrictEqual(taskDeliveryStates.get(taskId), delivery);
      taskDeliveryStates.set(taskId, delivery);
    }
  }
  if (recordWrites && !scope) {
    recordTaskRegistryProjectionWrite(recordWrites);
  }
  bumpTaskRegistryRevision(invalidateWorkerReads, changed);
}

function refreshUnderCustody(): void {
  const refresh = projection.dirty || dirtyScopes.size > 0;
  const database = openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(
    resolveOpenClawStateSqlitePath(),
  );
  if (!refresh && !database?.db.isTransaction) {
    return;
  }
  const store = getTaskRegistryStore();
  const scopes =
    projection.dirty || !store.loadMutationSnapshot
      ? undefined
      : [
          ...new Map(
            [...dirtyScopes].map((scope) => [
              JSON.stringify([scope.taskId, scope.runId, scope.childSessionKey]),
              scope,
            ]),
          ).values(),
        ];
  const snapshot = refresh && (scopes ? store.loadMutationSnapshot!(scopes) : store.loadSnapshot());
  // Keep transaction-local writes reversible even when no projection refresh is needed.
  const previous = database?.db.isTransaction
    ? {
        tasks: new Map(tasks),
        deliveryStates: new Map(taskDeliveryStates),
        restorePublication: captureTaskRegistryPublicationRollback(),
      }
    : undefined;
  // Only commit supersedes held reads; rollback may restore a cache older than their snapshot.
  const publication = {
    stage() {
      if (snapshot) {
        installSnapshot(snapshot, scopes, true, false);
        markTaskRegistryProjectionRestored();
      }
    },
    rollback() {
      if (previous) {
        installRestoredTaskRegistrySnapshot(previous, false);
        previous.restorePublication();
      }
      projection.dirty = true;
      bumpTaskRegistryRevision();
    },
    commit() {
      if (refresh) {
        recordTaskRegistryProjectionWrite("refresh");
        bumpTaskRegistryRevision();
      }
    },
  };
  if (!database || !stageSqliteTransactionState(database.db, publication)) {
    publication.stage();
    if (refresh) {
      recordTaskRegistryProjectionWrite("refresh");
    }
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
      return withPendingTaskRegistryEvents(refreshUnderCustody, operation);
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
  if (
    projection.mutationDepth === 0 &&
    (projection.dirty || dirtyScopes.size > 0 || hasPendingTaskRegistryEvents())
  ) {
    withTaskRegistryMutation(() => {});
  }
}

export async function runTaskRegistryWorkerMutation<T>(
  context: TaskRegistryWorkerMutationContext,
  mutate: (beginRecovery: () => void) => Promise<T>,
  readCurrent: () => Promise<TaskRegistryStoreSnapshot>,
): Promise<T> {
  const { scope, admission, readEventTarget } = context;
  const store = getTaskRegistryStore();
  admission.assertCurrent();
  const { pending, recovery, settle } = createPendingTaskRegistryMutation(
    context,
    store,
    readEventTarget
      ? () => {
          admission.assertCurrent();
          if (getTaskRegistryStore() !== store || !isCurrentTaskRegistryDatabase(admission)) {
            return undefined;
          }
          return readEventTarget();
        }
      : undefined,
  );
  pendingMutations.add(pending);
  const assertOwner = () => {
    admission.assertCurrent();
    if (!isCurrentTaskRegistryDatabase(admission) || getTaskRegistryStore() !== store) {
      projection.dirty = true;
      throw new Error("Task registry publication owner is no longer current.");
    }
    recovery?.assertCurrent();
  };
  try {
    if (context.prepare) {
      await context.prepare();
      assertOwner();
    }
    dirtyScopes.add(scope);
    bumpTaskRegistryRevision(true, pending.readIdentity !== "preserved");
    return await mutate(() => recovery?.begin());
  } finally {
    dirtyScopes.add(scope);
    bumpTaskRegistryRevision(true, pending.readIdentity !== "preserved");
    try {
      claimTaskRegistryPublication(pending, context.publicationRecords());
      const { conflicted } = await reconcileTaskRegistryWorkerSnapshot({
        pending,
        assertCurrent: assertOwner,
        read: readCurrent,
        install: (current, records) => installSnapshot(current, scope, false, records),
        recoverPublication: recovery?.recover,
        taskRowsWritten: context.taskRowsWritten?.(),
      });
      assertOwner();
      await context.beforeObservers?.(assertOwner);
      assertOwner();
      publishTaskRegistryWorkerMutation({
        pending,
        forced: context.forcePublish?.(),
        emit: emitTaskRegistryObserverEvent,
        onPublished: context.onPublished,
      });
      if (!conflicted) {
        dirtyScopes.delete(scope);
      }
    } catch (error) {
      // Failed readback cannot establish unchanged page order, even for a superseded publisher.
      bumpTaskRegistryRevision(false);
      // A newer committed row owns publication now. Keep the dirty scope for
      // canonical readback without rejecting readers of the settled mutation.
      if (!recovery?.isSuperseded(error)) {
        context.onPublicationError?.(error);
        taskRegistryLog.warn("Failed to reconcile managed child task after worker operation", {
          flowId: scope.flowId,
          error,
        });
      }
    } finally {
      pendingMutations.delete(pending);
      // Readers join settlement, then revalidate canonical state even when the write failed.
      settle?.();
    }
  }
}
