// Coordinates managed task-flow creation, updates, ownership, and snapshots.
import { formatErrorMessage } from "../infra/errors.js";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { OpenClawStateDatabaseReadAdmission } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  openClawStateDatabaseCache,
  registerOpenClawStateDatabaseLifecycleListener,
} from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { createTaskFlowRegistryReaders } from "./task-flow-registry.read.js";
import {
  assertControllerId,
  buildFlowRecord,
  buildManagedTaskFlowPatch,
  buildTaskMirroredFlowCreateFields,
  cloneFlowRecord,
  normalizeRestoredFlowRecord,
  prepareTaskMirroredFlowSyncFromCurrent,
  type CreateFlowRecordParams,
  type ManagedTaskFlowCreateFields,
  type ManagedTaskFlowMutation,
  type FlowRecordPatch,
  type PreparedTaskMirroredFlowSync,
  type TaskFlowSyncInput,
} from "./task-flow-registry.records.js";
import {
  getTaskFlowRegistryStore,
  prepareTaskFlowRecordPublication,
  resetTaskFlowRegistryRuntimeForTests,
  tryPersistFlowDelete,
  tryPersistFlowUpsert,
} from "./task-flow-registry.store.js";
import type {
  TaskFlowRegistryStoreSnapshot,
  TaskFlowRegistryUpdateResult,
  TaskFlowRegistryUpdatePublication,
} from "./task-flow-registry.store.types.js";
import type {
  JsonValue,
  TaskFlowRecord,
  TaskFlowStatus,
  TaskFlowUpdateResult,
  TaskFlowSyncResult,
} from "./task-flow-registry.types.js";
import {
  reconcileTaskFlowWorkerPublication,
  type PendingTaskFlowPublication,
} from "./task-flow-worker-publication.js";
import { createAsyncRegistryRestore, createSyncRegistryReader } from "./task-registry-restore.js";

export type { TaskFlowUpdateResult } from "./task-flow-registry.types.js";

export type { PreparedTaskMirroredFlowSync } from "./task-flow-registry.records.js";

const log = createSubsystemLogger("tasks/task-flow-registry");
let flows = new Map<string, TaskFlowRecord>();
let projectionEpoch = 0;
let projectionDirty = false;
const dirtyFlowIds = new Set<string>();
const pendingFlowWrites = new Map<
  string,
  PendingTaskFlowPublication & { completions: Set<Promise<void>> }
>();

function recordFlowProjectionWrite(flowId?: string): void {
  for (const [id, pending] of pendingFlowWrites) {
    if (flowId !== undefined && id !== flowId) {
      continue;
    }
    for (const reader of pending.readers) {
      reader.written = true;
    }
  }
}
registerOpenClawStateDatabaseLifecycleListener((event) => {
  if (event.kind !== "opened") {
    projectionEpoch += 1;
    projectionDirty = true;
  }
});
type TaskFlowRegistryRestoreState =
  | { status: "uninitialized" }
  | { status: "restoring" | "ready"; admission: OpenClawStateDatabaseReadAdmission }
  | {
      status: "failed";
      error: Error;
      message: string;
      admission: OpenClawStateDatabaseReadAdmission;
    };
let taskFlowRegistryRestoreState: TaskFlowRegistryRestoreState = { status: "uninitialized" };

/** Event overlays use recorded facts without entering a synchronous projection refresh. */
export function readResidentTaskFlow(flowId: string): Readonly<TaskFlowRecord> | undefined {
  return flows.get(flowId);
}

function failTaskFlowRegistryRestore(
  error: unknown,
  admission: OpenClawStateDatabaseReadAdmission,
): never {
  flows = new Map();
  recordFlowProjectionWrite();
  const message = formatErrorMessage(error);
  const restoreError = new Error(`Task-flow registry restore failed: ${message}`, { cause: error });
  taskFlowRegistryRestoreState = { status: "failed", error: restoreError, message, admission };
  log.warn("Failed to restore task-flow registry", {
    error: message,
    consoleMessage: `Failed to restore task-flow registry: ${message}`,
  });
  throw restoreError;
}

function getTaskFlowRegistryRestoreState(admission: OpenClawStateDatabaseReadAdmission) {
  let requiresRestore =
    taskFlowRegistryRestoreState.status !== "uninitialized" &&
    taskFlowRegistryRestoreState.admission.identity.key !== admission.identity.key;
  if (taskFlowRegistryRestoreState.status === "ready") {
    try {
      taskFlowRegistryRestoreState.admission.assertCurrent();
    } catch {
      // Worker-only close can retire admission without a native projection-dirty event.
      requiresRestore = true;
    }
  }
  if (requiresRestore) {
    taskFlowRegistryRestoreState = { status: "uninitialized" };
    projectionEpoch += 1;
  }
  return taskFlowRegistryRestoreState;
}

function installTaskFlowRegistrySnapshot(
  snapshot: TaskFlowRegistryStoreSnapshot,
  admission: OpenClawStateDatabaseReadAdmission,
): void {
  const restoredFlows = new Map(
    [...snapshot.flows].map(([id, flow]) => [id, normalizeRestoredFlowRecord(flow)]),
  );
  flows = restoredFlows;
  recordFlowProjectionWrite();
  projectionEpoch += 1;
  projectionDirty = false;
  dirtyFlowIds.clear();
  for (const flowId of pendingFlowWrites.keys()) {
    dirtyFlowIds.add(flowId);
  }
  taskFlowRegistryRestoreState = { status: "ready", admission };
}

function restoreTaskFlowRegistryOnce(): void {
  const databasePath = resolveOpenClawStateSqlitePath();
  const admission = captureOpenClawStateDatabaseReadAdmission(databasePath);
  const state = getTaskFlowRegistryRestoreState(admission);
  switch (state.status) {
    case "ready":
      return;
    case "failed":
      throw state.error;
    case "restoring":
      throw new Error("Task-flow registry restore is already in progress.");
    case "uninitialized":
      break;
  }
  const store = getTaskFlowRegistryStore();
  const restoring = (taskFlowRegistryRestoreState = { status: "restoring", admission });
  const epoch = projectionEpoch;
  const ownsRestore = () =>
    taskFlowRegistryRestoreState === restoring &&
    getTaskFlowRegistryStore() === store &&
    resolveOpenClawStateSqlitePath() === databasePath;
  const reader = createSyncRegistryReader({
    admission,
    captureAdmission: () => captureOpenClawStateDatabaseReadAdmission(databasePath),
    isCurrent: () => ownsRestore() && projectionEpoch === epoch,
    isCurrentDatabase: isCurrentTaskFlowDatabase,
    loadSnapshot: () => store.loadSnapshot(),
    changedMessage: "Task-flow registry restore changed before publication.",
  });
  let installing = false;
  try {
    const restored = reader.loadSnapshot();
    installing = true;
    installTaskFlowRegistrySnapshot(restored, reader.admission);
  } catch (error) {
    if (!installing && (reader.invalidated || !ownsRestore())) {
      if (taskFlowRegistryRestoreState === restoring) {
        taskFlowRegistryRestoreState = state;
      }
      throw error;
    }
    failTaskFlowRegistryRestore(error, reader.admission);
  }
}

export function ensureTaskFlowRegistryReady(options?: { refreshProjection?: boolean }): void {
  restoreTaskFlowRegistryOnce();
  if (options?.refreshProjection === false || (!projectionDirty && dirtyFlowIds.size === 0)) {
    return;
  }
  const flowIds = projectionDirty ? undefined : [...dirtyFlowIds];
  const restored = getTaskFlowRegistryStore().loadSnapshot(flowIds);
  const previous = flows;
  const next = new Map(previous);
  for (const flowId of flowIds ?? next.keys()) {
    if (!restored.flows.has(flowId)) {
      next.delete(flowId);
    }
  }
  for (const [flowId, flow] of restored.flows) {
    next.set(flowId, normalizeRestoredFlowRecord(flow));
  }
  // Transaction-local maps can roll back to older cache state; only commit supersedes a read.
  const publication = {
    stage: () => {
      flows = next;
      projectionEpoch += 1;
      projectionDirty = false;
      dirtyFlowIds.clear();
      for (const flowId of pendingFlowWrites.keys()) {
        dirtyFlowIds.add(flowId);
      }
    },
    rollback: () => {
      flows = previous;
      projectionEpoch += 1;
      projectionDirty = true;
    },
    commit: () => {
      recordFlowProjectionWrite();
      projectionEpoch += 1;
    },
  };
  const database = openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(
    resolveOpenClawStateSqlitePath(),
  );
  if (!database || !stageSqliteTransactionState(database.db, publication)) {
    publication.stage();
    recordFlowProjectionWrite();
  }
}

export const ensureTaskFlowRegistryReadyAsync = createAsyncRegistryRestore<
  TaskFlowRegistryStoreSnapshot,
  ReturnType<typeof getTaskFlowRegistryStore>
>({
  isCurrentDatabase: isCurrentTaskFlowDatabase,
  getState: getTaskFlowRegistryRestoreState,
  getRevision: () => projectionEpoch,
  getStore: getTaskFlowRegistryStore,
  install(snapshot, { admission }) {
    installTaskFlowRegistrySnapshot(snapshot, admission);
    return () => {};
  },
  fail(error, admission) {
    projectionEpoch += 1;
    return failTaskFlowRegistryRestore(error, admission);
  },
});

export const {
  prepareTaskFlowRegistryRead,
  getTaskFlowById,
  getTaskMirroredFlowIds,
  listTaskFlowsForOwnerKey,
  findLatestTaskFlowForOwnerKey,
  findTaskFlowForOwnerLookup,
  resolveTaskFlowForLookupToken,
  listTaskFlowRecords,
} = createTaskFlowRegistryReaders({
  projection: () => ({
    flows,
    epoch: projectionEpoch,
    dirty: projectionDirty,
    ready: taskFlowRegistryRestoreState.status === "ready",
    dirtyFlowIds,
  }),
  pendingWrites: pendingFlowWrites,
  ensureReady: ensureTaskFlowRegistryReady,
  ensureReadyAsync: ensureTaskFlowRegistryReadyAsync,
  isCurrentDatabase: isCurrentTaskFlowDatabase,
  installSnapshot: installTaskFlowRegistrySnapshot,
});

export async function reloadTaskFlowRegistryFromStoreAsync(
  context: OpenClawStateWorkerContext,
): Promise<void> {
  context.admission.assertCurrent();
  if (!isCurrentTaskFlowDatabase(context.admission)) {
    return;
  }
  projectionEpoch += 1;
  taskFlowRegistryRestoreState = { status: "uninitialized" };
  await ensureTaskFlowRegistryReadyAsync(context);
}

function isCurrentTaskFlowDatabase(admission: OpenClawStateDatabaseReadAdmission): boolean {
  const current = openClawStateDatabaseCache.getKnownOpenClawStateDatabaseIdentity(
    resolveOpenClawStateSqlitePath(),
  );
  return current?.key === admission.identity.key;
}

/** Worker receipts reconcile durable rows without resetting live task or delivery owners. */
export function beginTaskFlowRegistryWorkerMutation(
  context: {
    flowId: string;
    admission: OpenClawStateDatabaseReadAdmission;
    onPublicationError?: (error: unknown) => void;
  },
  readCurrent: () => Promise<TaskFlowRecord | undefined>,
): () => Promise<void> {
  const { flowId, admission } = context;
  const store = getTaskFlowRegistryStore();
  admission.assertCurrent();
  const pending = pendingFlowWrites.get(flowId) ?? {
    completions: new Set<Promise<void>>(),
    readers: new Set<{ written: boolean }>(),
  };
  const completion = createDeferredCore();
  pending.completions.add(completion.promise);
  pendingFlowWrites.set(flowId, pending);
  dirtyFlowIds.add(flowId);
  projectionEpoch += 1;
  return async () => {
    dirtyFlowIds.add(flowId);
    projectionEpoch += 1;
    let reconciled = false;
    try {
      const assertOwner = () => {
        admission.assertCurrent();
        if (!isCurrentTaskFlowDatabase(admission) || getTaskFlowRegistryStore() !== store) {
          projectionDirty = true;
          throw new Error("Task-flow registry publication owner is no longer current.");
        }
      };
      reconciled = await reconcileTaskFlowWorkerPublication({
        pending,
        assertCurrent: assertOwner,
        current: () => flows.get(flowId),
        read: readCurrent,
        install(next) {
          if (next) {
            flows.set(flowId, next);
          } else {
            flows.delete(flowId);
          }
          recordFlowProjectionWrite(flowId);
        },
      });
    } catch (error) {
      // Persistence has settled. A projection failure must not invite replay of that write.
      context.onPublicationError?.(error);
      log.warn("Failed to reconcile task-flow state after worker operation", { flowId, error });
    } finally {
      pending.completions.delete(completion.promise);
      if (pending.completions.size === 0) {
        pendingFlowWrites.delete(flowId);
        if (reconciled) {
          dirtyFlowIds.delete(flowId);
        }
      }
      completion.resolve();
    }
  };
}

export async function runTaskFlowRegistryWorkerMutation<T>(
  context: Parameters<typeof beginTaskFlowRegistryWorkerMutation>[0],
  mutate: () => Promise<T>,
  readCurrent: () => Promise<TaskFlowRecord | undefined>,
): Promise<T> {
  const settle = beginTaskFlowRegistryWorkerMutation(context, readCurrent);
  try {
    return await mutate();
  } catch (error) {
    log.warn("Failed to persist task-flow worker mutation", { flowId: context.flowId, error });
    throw error;
  } finally {
    await settle();
  }
}

export function getTaskFlowRegistryRestoreFailure(): string | null {
  try {
    ensureTaskFlowRegistryReady();
    return null;
  } catch {
    return taskFlowRegistryRestoreState.status === "failed"
      ? taskFlowRegistryRestoreState.message
      : "Task-flow registry restore did not complete.";
  }
}

function writeFlowRecord(next: TaskFlowRecord): TaskFlowRecord | null {
  if (!tryPersistFlowUpsert(next, "create")) {
    return null;
  }
  flows.set(next.flowId, next);
  recordFlowProjectionWrite(next.flowId);
  projectionEpoch += 1;
  return cloneFlowRecord(next);
}

function createFlowRecord(params: CreateFlowRecordParams): TaskFlowRecord | null {
  ensureTaskFlowRegistryReady();
  const record = buildFlowRecord(params);
  return writeFlowRecord(record);
}

export function createManagedTaskFlow(params: ManagedTaskFlowCreateFields): TaskFlowRecord | null {
  return createFlowRecord({
    ...params,
    syncMode: "managed",
    controllerId: assertControllerId(params.controllerId),
  });
}

export function createTaskFlowForTask(
  params: Parameters<typeof buildTaskMirroredFlowCreateFields>[0],
): TaskFlowRecord | null {
  return createFlowRecord(buildTaskMirroredFlowCreateFields(params));
}

function prepareFlowRecordPublication(
  flowId: string,
  cached: TaskFlowRecord | undefined,
  current: TaskFlowRecord | undefined,
  applied: boolean,
): TaskFlowRegistryUpdatePublication {
  return prepareTaskFlowRecordPublication({
    cached,
    current,
    applied,
    write(next) {
      if (next) {
        flows.set(flowId, next);
      } else {
        flows.delete(flowId);
      }
    },
    advance: () => {
      projectionEpoch += 1;
    },
    onCommitted: () => recordFlowProjectionWrite(flowId),
  });
}

export function updateFlowRecordByIdExpectedRevision(params: {
  flowId: string;
  expectedRevision: number;
  patch: FlowRecordPatch;
}): TaskFlowUpdateResult {
  ensureTaskFlowRegistryReady();
  const cached = flows.get(params.flowId);
  let result: TaskFlowRegistryUpdateResult;
  try {
    result = getTaskFlowRegistryStore().updateFlow(params, (observed) => {
      const current = observed.applied
        ? observed.flow
        : observed.reason === "revision_conflict"
          ? observed.current
          : undefined;
      return prepareFlowRecordPublication(params.flowId, cached, current, observed.applied);
    });
  } catch (error) {
    log.warn("Failed to persist task-flow registry update", { flowId: params.flowId, error });
    return {
      applied: false,
      reason: "persist_failed",
      ...(cached ? { current: cloneFlowRecord(cached) } : {}),
    };
  }
  if (result.applied) {
    return { applied: true, flow: cloneFlowRecord(result.flow) };
  }
  if (result.reason === "invalid_patch") {
    throw result.error;
  }
  return result.reason === "revision_conflict"
    ? { ...result, current: cloneFlowRecord(result.current) }
    : result;
}

function mutateManagedFlow(
  mutation: ManagedTaskFlowMutation,
  params: FlowRecordPatch & { flowId: string; expectedRevision: number },
): TaskFlowUpdateResult {
  return updateFlowRecordByIdExpectedRevision({
    flowId: params.flowId,
    expectedRevision: params.expectedRevision,
    patch: buildManagedTaskFlowPatch(mutation, params),
  });
}

export function setFlowWaiting(params: {
  flowId: string;
  expectedRevision: number;
  currentStep?: string | null;
  stateJson?: JsonValue | null;
  waitJson?: JsonValue | null;
  blockedTaskId?: string | null;
  blockedSummary?: string | null;
  updatedAt?: number;
}): TaskFlowUpdateResult {
  return mutateManagedFlow("setWaiting", params);
}

export function resumeFlow(params: {
  flowId: string;
  expectedRevision: number;
  status?: Extract<TaskFlowStatus, "queued" | "running">;
  currentStep?: string | null;
  stateJson?: JsonValue | null;
  updatedAt?: number;
}): TaskFlowUpdateResult {
  return mutateManagedFlow("resume", params);
}

export function finishFlow(params: {
  flowId: string;
  expectedRevision: number;
  currentStep?: string | null;
  stateJson?: JsonValue | null;
  updatedAt?: number;
  endedAt?: number;
}): TaskFlowUpdateResult {
  return mutateManagedFlow("finish", params);
}

export function failFlow(params: {
  flowId: string;
  expectedRevision: number;
  currentStep?: string | null;
  stateJson?: JsonValue | null;
  blockedTaskId?: string | null;
  blockedSummary?: string | null;
  updatedAt?: number;
  endedAt?: number;
}): TaskFlowUpdateResult {
  return mutateManagedFlow("fail", params);
}

export function requestFlowCancel(params: {
  flowId: string;
  expectedRevision: number;
  cancelRequestedAt?: number;
  updatedAt?: number;
}): TaskFlowUpdateResult {
  return mutateManagedFlow("requestCancel", params);
}

export function syncFlowFromTaskResult(task: TaskFlowSyncInput): TaskFlowSyncResult {
  const flowId = task.parentFlowId?.trim();
  if (!flowId) {
    return { ok: true, flow: null };
  }
  ensureTaskFlowRegistryReady({ refreshProjection: false });
  const cached = flows.get(flowId);
  if (
    !projectionDirty &&
    !dirtyFlowIds.has(flowId) &&
    (!cached || cached.syncMode !== "task_mirrored")
  ) {
    return { ok: true, flow: cached ? cloneFlowRecord(cached) : null };
  }
  try {
    const result = getTaskFlowRegistryStore().syncMirroredTask(task, (observed) =>
      prepareFlowRecordPublication(flowId, cached, observed.flow ?? undefined, observed.changed),
    );
    return { ok: true, flow: result.flow ? cloneFlowRecord(result.flow) : null };
  } catch (error) {
    const current = getTaskFlowById(flowId);
    if (!current || current.syncMode !== "task_mirrored") {
      return { ok: true, flow: current ?? null };
    }
    log.warn("Failed to persist task-mirrored flow", { flowId, taskId: task.taskId, error });
    return { ok: false, reason: "persist_failed", current };
  }
}

export function prepareTaskMirroredFlowSync(
  task: Parameters<typeof syncFlowFromTaskResult>[0],
): PreparedTaskMirroredFlowSync | undefined {
  const flowId = task.parentFlowId?.trim();
  if (!flowId) {
    return undefined;
  }
  const flow = getTaskFlowById(flowId);
  return flow?.syncMode === "task_mirrored"
    ? prepareTaskMirroredFlowSyncFromCurrent(task, flow)
    : undefined;
}

/** Publishes a mirrored flow record already committed by a shared-state transaction. */
export function publishTaskFlowAfterAtomicStore(prepared: PreparedTaskMirroredFlowSync): void {
  const next = cloneFlowRecord(prepared.next);
  flows.set(next.flowId, next);
  recordFlowProjectionWrite(next.flowId);
  projectionEpoch += 1;
}

export function deleteTaskFlowRecordById(flowId: string): boolean {
  ensureTaskFlowRegistryReady();
  const current = flows.get(flowId);
  if (!current) {
    return false;
  }
  if (!tryPersistFlowDelete(flowId)) {
    return false;
  }
  flows.delete(flowId);
  recordFlowProjectionWrite(flowId);
  projectionEpoch += 1;
  return true;
}

function resetTaskFlowRegistryForTests() {
  projectionEpoch += 1;
  projectionDirty = false;
  dirtyFlowIds.clear();
  flows = new Map();
  recordFlowProjectionWrite();
  taskFlowRegistryRestoreState = { status: "uninitialized" };
  resetTaskFlowRegistryRuntimeForTests();
  getTaskFlowRegistryStore().close?.();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.taskFlowRegistryTestApi")] = {
    createFlowRecord,
    resetTaskFlowRegistryForTests,
  };
}
