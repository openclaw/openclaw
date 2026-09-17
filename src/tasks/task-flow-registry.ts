// Coordinates managed task-flow creation, updates, ownership, and snapshots.
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
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  assertControllerId,
  areTaskFlowRecordsEqual,
  buildFlowRecord,
  buildManagedTaskFlowPatch,
  buildTaskMirroredFlowCreateFields,
  cloneFlowRecord,
  normalizeRestoredFlowRecord,
  type CreateFlowRecordParams,
  type FlowRecordCreateFields,
  type FlowRecordPatch,
  type PreparedTaskMirroredFlowSync,
  type TaskFlowSyncInput,
} from "./task-flow-registry.records.js";
import {
  deliverTaskFlowRegistryObserverEvent,
  getTaskFlowRegistryObservers,
  getTaskFlowRegistryStore,
  resetTaskFlowRegistryRuntimeForTests,
  tryPersistFlowDelete,
  tryPersistFlowUpsert,
  type FlowRegistryPublication,
} from "./task-flow-registry.store.js";
import type {
  TaskFlowRegistryStoreSnapshot,
  TaskFlowRegistryUpdateResult,
  TaskFlowRegistryUpdatePublication,
} from "./task-flow-registry.store.types.js";
import {
  isTerminalTaskFlow,
  type JsonValue,
  type TaskFlowRecord,
  type TaskFlowStatus,
  type TaskFlowUpdateResult,
  type TaskFlowSyncResult,
} from "./task-flow-registry.types.js";
import {
  reconcileTaskFlowWorkerPublication,
  type PendingTaskFlowPublication,
} from "./task-flow-worker-publication.js";
import { createAsyncRegistryRestore, createSyncRegistryReader } from "./task-registry-restore.js";

export type { TaskFlowUpdateResult } from "./task-flow-registry.types.js";

const log = createSubsystemLogger("tasks/task-flow-registry");
let flows = new Map<string, TaskFlowRecord>();
let projectionEpoch = 0;
let projectionDirty = false;
const dirtyFlowIds = new Set<string>();
const pendingFlowWrites = new Map<string, PendingTaskFlowPublication & { count: number }>();

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

function emitFlowRegistryObserverEvent(createEvent: () => FlowRegistryPublication): void {
  const observers = getTaskFlowRegistryObservers();
  if (!observers?.onEvent && pendingFlowWrites.size === 0) {
    return;
  }
  try {
    const event = createEvent();
    // Track owner-held records before observers can reenter. Delivered values are separate copies.
    if (event.kind === "restored") {
      for (const [flowId, pending] of pendingFlowWrites) {
        pending.lastPublished = event.flows.get(flowId);
      }
    } else {
      const pending = pendingFlowWrites.get(
        event.kind === "upserted" ? event.flow.flowId : event.flowId,
      );
      if (pending) {
        pending.lastPublished = event.kind === "upserted" ? event.flow : undefined;
      }
    }
    deliverTaskFlowRegistryObserverEvent(observers, event);
  } catch {
    // Flow observers are best-effort only. They must not break registry writes.
  }
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
    const restoredFlows = new Map<string, TaskFlowRecord>();
    for (const [flowId, flow] of restored.flows) {
      restoredFlows.set(flowId, normalizeRestoredFlowRecord(flow));
    }
    flows = restoredFlows;
    recordFlowProjectionWrite();
    projectionEpoch += 1;
    taskFlowRegistryRestoreState = { status: "ready", admission: reader.admission };
  } catch (error) {
    if (!installing && (reader.invalidated || !ownsRestore())) {
      if (taskFlowRegistryRestoreState === restoring) {
        taskFlowRegistryRestoreState = state;
      }
      throw error;
    }
    failTaskFlowRegistryRestore(error, reader.admission);
  }
  emitFlowRegistryObserverEvent(() => ({
    kind: "restored",
    flows,
  }));
}

export function ensureTaskFlowRegistryReady(options?: { refreshProjection?: boolean }): void {
  restoreTaskFlowRegistryOnce();
  if (options?.refreshProjection === false || (!projectionDirty && dirtyFlowIds.size === 0)) {
    return;
  }
  const restored = getTaskFlowRegistryStore().loadSnapshot();
  const previous = flows;
  const next = new Map(previous);
  for (const flowId of next.keys()) {
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
    flows = new Map(
      [...snapshot.flows].map(([id, flow]) => [id, normalizeRestoredFlowRecord(flow)]),
    );
    recordFlowProjectionWrite();
    projectionEpoch += 1;
    projectionDirty = false;
    dirtyFlowIds.clear();
    for (const flowId of pendingFlowWrites.keys()) {
      dirtyFlowIds.add(flowId);
    }
    taskFlowRegistryRestoreState = { status: "ready", admission };
    return () => emitFlowRegistryObserverEvent(() => ({ kind: "restored", flows }));
  },
  fail(error, admission) {
    projectionEpoch += 1;
    return failTaskFlowRegistryRestore(error, admission);
  },
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

export async function reconcileTaskFlowWorkerReceipts(
  context: OpenClawStateWorkerContext,
  flowIds: readonly string[],
): Promise<void> {
  if (flowIds.length === 0) {
    return;
  }
  context.admission.assertCurrent();
  if (!isCurrentTaskFlowDatabase(context.admission)) {
    return;
  }
  const store = getTaskFlowRegistryStore();
  await ensureTaskFlowRegistryReadyAsync(context);
  for (const flowId of new Set(flowIds)) {
    context.admission.assertCurrent();
    if (!isCurrentTaskFlowDatabase(context.admission) || getTaskFlowRegistryStore() !== store) {
      return;
    }
    // The receipt is already committed; publication still rereads the canonical row.
    await runTaskFlowRegistryWorkerMutation(
      { flowId, admission: context.admission },
      () => Promise.resolve(),
      () => store.readFlowAsync(context, flowId),
    );
  }
}

/** Worker receipts reconcile durable rows without resetting live task or delivery owners. */
export async function runTaskFlowRegistryWorkerMutation<T>(
  context: { flowId: string; admission: OpenClawStateDatabaseReadAdmission },
  mutate: () => Promise<T>,
  readCurrent: () => Promise<TaskFlowRecord | undefined>,
): Promise<T> {
  const { flowId, admission } = context;
  const store = getTaskFlowRegistryStore();
  admission.assertCurrent();
  const pending = pendingFlowWrites.get(flowId) ?? {
    count: 0,
    lastPublished: flows.get(flowId),
    readers: new Set<{ written: boolean }>(),
  };
  pending.count += 1;
  pendingFlowWrites.set(flowId, pending);
  dirtyFlowIds.add(flowId);
  projectionEpoch += 1;
  try {
    return await mutate();
  } catch (error) {
    log.warn("Failed to persist task-flow worker mutation", { flowId, error });
    throw error;
  } finally {
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
        flowId,
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
        emit: emitFlowRegistryObserverEvent,
      });
    } catch (error) {
      // Persistence has settled. A projection failure must not invite replay of that write.
      log.warn("Failed to reconcile task-flow state after worker operation", { flowId, error });
    } finally {
      pending.count -= 1;
      if (pending.count === 0) {
        pendingFlowWrites.delete(flowId);
        if (reconciled) {
          dirtyFlowIds.delete(flowId);
        }
      }
    }
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

function writeFlowRecord(next: TaskFlowRecord, previous?: TaskFlowRecord): TaskFlowRecord | null {
  if (!tryPersistFlowUpsert(next, previous ? "update" : "create")) {
    return null;
  }
  flows.set(next.flowId, next);
  recordFlowProjectionWrite(next.flowId);
  projectionEpoch += 1;
  emitFlowRegistryObserverEvent(() => ({
    kind: "upserted",
    flow: next,
    ...(previous ? { previous } : {}),
  }));
  return cloneFlowRecord(next);
}

function createFlowRecord(params: CreateFlowRecordParams): TaskFlowRecord | null {
  ensureTaskFlowRegistryReady();
  const record = buildFlowRecord(params);
  return writeFlowRecord(record);
}

export function createManagedTaskFlow(
  params: FlowRecordCreateFields & {
    controllerId: string;
  },
): TaskFlowRecord | null {
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
  previous: TaskFlowRecord | undefined,
  applied: boolean,
): TaskFlowRegistryUpdatePublication {
  const canonical = current ? cloneFlowRecord(current) : undefined;
  const changed =
    applied ||
    !areTaskFlowRecordsEqual(cached ? normalizeRestoredFlowRecord(cached) : undefined, canonical);
  const next = changed ? canonical : cached;
  let committed: TaskFlowRecord | undefined;
  return {
    stage: () => {
      projectionEpoch += 1;
      if (next) {
        flows.set(flowId, next);
      } else {
        flows.delete(flowId);
      }
    },
    rollback: () => {
      projectionEpoch += 1;
      if (cached) {
        flows.set(flowId, cached);
      } else {
        flows.delete(flowId);
      }
    },
    commit: () => {
      recordFlowProjectionWrite(flowId);
      projectionEpoch += 1;
      // Capture the final staged entry before any observer can reenter this owner.
      committed = flows.get(flowId);
    },
    publish: () => {
      if (!changed || flows.get(flowId) !== committed) {
        return;
      }
      if (next) {
        emitFlowRegistryObserverEvent(() => ({
          kind: "upserted",
          flow: next,
          ...(previous ? { previous } : {}),
        }));
      } else if (previous) {
        emitFlowRegistryObserverEvent(() => ({
          kind: "deleted",
          flowId,
          previous,
        }));
      }
    },
  };
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
      return prepareFlowRecordPublication(
        params.flowId,
        cached,
        current,
        observed.applied ? observed.previous : cached,
        observed.applied,
      );
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
  return updateFlowRecordByIdExpectedRevision({
    flowId: params.flowId,
    expectedRevision: params.expectedRevision,
    patch: buildManagedTaskFlowPatch("setWaiting", params),
  });
}

export function resumeFlow(params: {
  flowId: string;
  expectedRevision: number;
  status?: Extract<TaskFlowStatus, "queued" | "running">;
  currentStep?: string | null;
  stateJson?: JsonValue | null;
  updatedAt?: number;
}): TaskFlowUpdateResult {
  return updateFlowRecordByIdExpectedRevision({
    flowId: params.flowId,
    expectedRevision: params.expectedRevision,
    patch: buildManagedTaskFlowPatch("resume", params),
  });
}

export function finishFlow(params: {
  flowId: string;
  expectedRevision: number;
  currentStep?: string | null;
  stateJson?: JsonValue | null;
  updatedAt?: number;
  endedAt?: number;
}): TaskFlowUpdateResult {
  return updateFlowRecordByIdExpectedRevision({
    flowId: params.flowId,
    expectedRevision: params.expectedRevision,
    patch: buildManagedTaskFlowPatch("finish", params),
  });
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
  return updateFlowRecordByIdExpectedRevision({
    flowId: params.flowId,
    expectedRevision: params.expectedRevision,
    patch: buildManagedTaskFlowPatch("fail", params),
  });
}

export function requestFlowCancel(params: {
  flowId: string;
  expectedRevision: number;
  cancelRequestedAt?: number;
  updatedAt?: number;
}): TaskFlowUpdateResult {
  return updateFlowRecordByIdExpectedRevision({
    flowId: params.flowId,
    expectedRevision: params.expectedRevision,
    patch: buildManagedTaskFlowPatch("requestCancel", params),
  });
}

export function syncFlowFromTaskResult(task: TaskFlowSyncInput): TaskFlowSyncResult {
  const flowId = task.parentFlowId?.trim();
  if (!flowId) {
    return { ok: true, flow: null };
  }
  const flow = getTaskFlowById(flowId);
  if (!flow) {
    return { ok: true, flow: null };
  }
  if (flow.syncMode !== "task_mirrored") {
    return { ok: true, flow };
  }
  const cached = flows.get(flowId);
  try {
    const result = getTaskFlowRegistryStore().syncMirroredTask(task, (observed) =>
      prepareFlowRecordPublication(
        flowId,
        cached,
        observed.flow ?? undefined,
        observed.changed ? observed.previous : cached,
        observed.changed,
      ),
    );
    return { ok: true, flow: result.flow ? cloneFlowRecord(result.flow) : null };
  } catch (error) {
    log.warn("Failed to persist task-mirrored flow", { flowId, taskId: task.taskId, error });
    return { ok: false, reason: "persist_failed", current: flow };
  }
}

/** Publishes a mirrored flow record already committed by a shared-state transaction. */
export function publishTaskFlowAfterAtomicStore(
  prepared: PreparedTaskMirroredFlowSync,
  deferredObserverEvents: Array<() => void>,
): void {
  const next = cloneFlowRecord(prepared.next);
  flows.set(next.flowId, next);
  recordFlowProjectionWrite(next.flowId);
  projectionEpoch += 1;
  deferredObserverEvents.push(() =>
    emitFlowRegistryObserverEvent(() => ({
      kind: "upserted",
      flow: next,
      previous: prepared.current,
    })),
  );
}

export function getTaskFlowById(flowId: string): TaskFlowRecord | undefined {
  ensureTaskFlowRegistryReady();
  const flow = flows.get(flowId);
  return flow ? cloneFlowRecord(flow) : undefined;
}

export function listTaskFlowsForOwnerKey(ownerKey: string): TaskFlowRecord[] {
  ensureTaskFlowRegistryReady();
  const normalizedOwnerKey = ownerKey.trim();
  if (!normalizedOwnerKey) {
    return [];
  }
  return [...flows.values()]
    .filter((flow) => flow.ownerKey.trim() === normalizedOwnerKey)
    .map((flow) => cloneFlowRecord(flow))
    .toSorted((left, right) => right.createdAt - left.createdAt);
}

export function findLatestTaskFlowForOwnerKey(ownerKey: string): TaskFlowRecord | undefined {
  return listTaskFlowsForOwnerKey(ownerKey)[0];
}

// Owner-key actions must target live work before retained terminal history;
// otherwise `show` and `cancel` silently act on a completed flow.
export function findTaskFlowForOwnerLookup(ownerKey: string): TaskFlowRecord | undefined {
  const ownerFlows = listTaskFlowsForOwnerKey(ownerKey);
  return ownerFlows.find((flow) => !isTerminalTaskFlow(flow)) ?? ownerFlows[0];
}

export function resolveTaskFlowForLookupToken(token: string): TaskFlowRecord | undefined {
  const lookup = token.trim();
  if (!lookup) {
    return undefined;
  }
  return getTaskFlowById(lookup) ?? findTaskFlowForOwnerLookup(lookup);
}

export function listTaskFlowRecords(): TaskFlowRecord[] {
  ensureTaskFlowRegistryReady();
  return [...flows.values()]
    .map((flow) => cloneFlowRecord(flow))
    .toSorted((left, right) => right.createdAt - left.createdAt);
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
  emitFlowRegistryObserverEvent(() => ({
    kind: "deleted",
    flowId,
    previous: current,
  }));
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
