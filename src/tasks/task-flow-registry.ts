// Coordinates managed task-flow creation, updates, ownership, and snapshots.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
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
import {
  assertControllerId,
  areTaskFlowRecordsEqual,
  buildFlowRecord,
  buildManagedTaskFlowPatch,
  cloneFlowRecord,
  deriveTaskFlowStatusFromTask,
  isTerminalTaskFlowStatus,
  normalizeRestoredFlowRecord,
  prepareTaskMirroredFlowSyncFromCurrent,
  resolveFlowBlockedSummary,
  resolveTaskMirroredFlowTiming,
  snapshotFlowRecords,
  type CreateFlowRecordParams,
  type FlowRecordCreateFields,
  type FlowRecordPatch,
  type PreparedTaskMirroredFlowSync,
  type TaskFlowSyncInput,
} from "./task-flow-registry.records.js";
import {
  getTaskFlowRegistryObservers,
  getTaskFlowRegistryStore,
  resetTaskFlowRegistryRuntimeForTests,
  type TaskFlowRegistryObserverEvent,
} from "./task-flow-registry.store.js";
import type { TaskFlowRegistryUpdateResult } from "./task-flow-registry.store.types.js";
import {
  isTerminalTaskFlow,
  type JsonValue,
  type TaskFlowRecord,
  type TaskFlowStatus,
} from "./task-flow-registry.types.js";
import type { TaskRecord } from "./task-registry.types.js";

export type { PreparedTaskMirroredFlowSync } from "./task-flow-registry.records.js";

const log = createSubsystemLogger("tasks/task-flow-registry");
let flows = new Map<string, TaskFlowRecord>();
let projectionEpoch = 0;
let projectionDirty = false;
const dirtyFlowIds = new Set<string>();
const pendingFlowWrites = new Map<
  string,
  { count: number; lastPublished: TaskFlowRecord | undefined }
>();
registerOpenClawStateDatabaseLifecycleListener((event) => {
  if (event.kind !== "opened") {
    projectionEpoch += 1;
    projectionDirty = true;
  }
});
type TaskFlowRegistryRestoreState =
  | { status: "uninitialized" }
  | { status: "restoring" }
  | { status: "ready" }
  | { status: "failed"; error: Error; message: string };
let taskFlowRegistryRestoreState: TaskFlowRegistryRestoreState = { status: "uninitialized" };

export type TaskFlowUpdateResult =
  | {
      applied: true;
      flow: TaskFlowRecord;
    }
  | {
      applied: false;
      reason: "not_found" | "revision_conflict" | "persist_failed";
      current?: TaskFlowRecord;
    };

type TaskFlowSyncResult =
  | {
      ok: true;
      flow: TaskFlowRecord | null;
    }
  | {
      ok: false;
      reason: "persist_failed";
      current: TaskFlowRecord;
    };

type FlowRegistryPublication =
  | Exclude<TaskFlowRegistryObserverEvent, { kind: "restored" }>
  | { kind: "restored"; flows: ReadonlyMap<string, TaskFlowRecord> };

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
    if (!observers?.onEvent) {
      return;
    }
    if (event.kind === "restored") {
      observers.onEvent({ kind: "restored", flows: snapshotFlowRecords(event.flows) });
    } else if (event.kind === "upserted") {
      observers.onEvent({
        kind: "upserted",
        flow: cloneFlowRecord(event.flow),
        ...(event.previous ? { previous: cloneFlowRecord(event.previous) } : {}),
      });
    } else {
      observers.onEvent({ ...event, previous: cloneFlowRecord(event.previous) });
    }
  } catch {
    // Flow observers are best-effort only. They must not break registry writes.
  }
}

function restoreTaskFlowRegistryOnce(): void {
  switch (taskFlowRegistryRestoreState.status) {
    case "ready":
      return;
    case "failed":
      throw taskFlowRegistryRestoreState.error;
    case "restoring":
      throw new Error("Task-flow registry restore is already in progress.");
    case "uninitialized":
      break;
  }
  taskFlowRegistryRestoreState = { status: "restoring" };
  try {
    const restored = getTaskFlowRegistryStore().loadSnapshot();
    const restoredFlows = new Map<string, TaskFlowRecord>();
    for (const [flowId, flow] of restored.flows) {
      restoredFlows.set(flowId, normalizeRestoredFlowRecord(flow));
    }
    flows = restoredFlows;
    projectionEpoch += 1;
    taskFlowRegistryRestoreState = { status: "ready" };
  } catch (error) {
    flows = new Map();
    const message = formatErrorMessage(error);
    const restoreError = new Error(`Task-flow registry restore failed: ${message}`, {
      cause: error,
    });
    taskFlowRegistryRestoreState = {
      status: "failed",
      error: restoreError,
      message,
    };
    log.warn("Failed to restore task-flow registry", {
      error: message,
      consoleMessage: `Failed to restore task-flow registry: ${message}`,
    });
    throw restoreError;
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
      projectionEpoch += 1;
    },
  };
  const database = openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(
    resolveOpenClawStateSqlitePath(),
  );
  if (!database || !stageSqliteTransactionState(database.db, publication)) {
    publication.stage();
  }
}

function isCurrentTaskFlowDatabase(admission: OpenClawStateDatabaseReadAdmission): boolean {
  const current = captureOpenClawStateDatabaseReadAdmission(resolveOpenClawStateSqlitePath());
  return current.identity.key === admission.identity.key;
}

/** Worker receipts reconcile durable rows without resetting live task or delivery owners. */
export async function runTaskFlowRegistryWorkerMutation<T>(
  context: { flowId: string; admission: OpenClawStateDatabaseReadAdmission },
  mutate: () => Promise<T>,
  readCurrent: () => Promise<TaskFlowRecord | undefined>,
): Promise<T> {
  const { flowId, admission } = context;
  admission.assertCurrent();
  const pending = pendingFlowWrites.get(flowId) ?? {
    count: 0,
    lastPublished: flows.get(flowId),
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
      while (true) {
        admission.assertCurrent();
        if (!isCurrentTaskFlowDatabase(admission)) {
          projectionDirty = true;
          break;
        }
        const epoch = projectionEpoch;
        const current = await readCurrent();
        admission.assertCurrent();
        if (!isCurrentTaskFlowDatabase(admission)) {
          projectionDirty = true;
          break;
        }
        if (epoch !== projectionEpoch) {
          continue;
        }
        const cached = flows.get(flowId);
        const next = current ? normalizeRestoredFlowRecord(current) : undefined;
        reconciled = true;
        if (!areTaskFlowRecordsEqual(cached, next)) {
          if (next) {
            flows.set(flowId, next);
          } else {
            flows.delete(flowId);
          }
        }
        const previous = pending.lastPublished;
        if (areTaskFlowRecordsEqual(previous, next)) {
          break;
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
        break;
      }
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

export function reloadTaskFlowRegistryFromStore(): void {
  projectionEpoch += 1;
  flows = new Map();
  taskFlowRegistryRestoreState = { status: "uninitialized" };
  ensureTaskFlowRegistryReady();
}

function tryPersistFlowUpsert(flow: TaskFlowRecord, operation: string): boolean {
  try {
    getTaskFlowRegistryStore().upsertFlow(cloneFlowRecord(flow));
    return true;
  } catch (error) {
    log.warn("Failed to persist task-flow registry upsert", {
      operation,
      flowId: flow.flowId,
      error,
    });
    return false;
  }
}

function tryPersistFlowDelete(flowId: string): boolean {
  try {
    getTaskFlowRegistryStore().deleteFlow(flowId);
    return true;
  } catch (error) {
    log.warn("Failed to persist task-flow registry delete", {
      flowId,
      error,
    });
    return false;
  }
}

function writeFlowRecord(next: TaskFlowRecord, previous?: TaskFlowRecord): TaskFlowRecord | null {
  if (!tryPersistFlowUpsert(next, previous ? "update" : "create")) {
    return null;
  }
  flows.set(next.flowId, next);
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

export function createTaskFlowForTask(params: {
  task: Pick<
    TaskRecord,
    | "ownerKey"
    | "taskId"
    | "notifyPolicy"
    | "status"
    | "terminalOutcome"
    | "label"
    | "task"
    | "createdAt"
    | "lastEventAt"
    | "endedAt"
    | "terminalSummary"
    | "progressSummary"
  >;
  requesterOrigin?: TaskFlowRecord["requesterOrigin"];
}): TaskFlowRecord | null {
  const terminalFlowStatus = deriveTaskFlowStatusFromTask(params.task);
  const timing = resolveTaskMirroredFlowTiming(
    params.task,
    isTerminalTaskFlowStatus(terminalFlowStatus),
  );
  return createFlowRecord({
    syncMode: "task_mirrored",
    ownerKey: params.task.ownerKey,
    requesterOrigin: params.requesterOrigin,
    status: terminalFlowStatus,
    notifyPolicy: params.task.notifyPolicy,
    goal:
      normalizeOptionalString(params.task.label) ?? (params.task.task.trim() || "Background task"),
    blockedTaskId:
      terminalFlowStatus === "blocked" ? normalizeOptionalString(params.task.taskId) : undefined,
    blockedSummary: resolveFlowBlockedSummary(params.task),
    createdAt: params.task.createdAt,
    updatedAt: timing.updatedAt,
    ...(timing.endedAt !== undefined ? { endedAt: timing.endedAt } : {}),
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
      const canonical = current ? cloneFlowRecord(current) : undefined;
      const previous = observed.applied ? observed.previous : cached;
      const changed =
        observed.applied ||
        !areTaskFlowRecordsEqual(
          cached ? normalizeRestoredFlowRecord(cached) : undefined,
          canonical,
        );
      const next = changed ? canonical : cached;
      let committed: TaskFlowRecord | undefined;
      return {
        stage: () => {
          projectionEpoch += 1;
          if (next) {
            flows.set(params.flowId, next);
          } else {
            flows.delete(params.flowId);
          }
        },
        rollback: () => {
          projectionEpoch += 1;
          if (cached) {
            flows.set(params.flowId, cached);
          } else {
            flows.delete(params.flowId);
          }
        },
        commit: () => {
          projectionEpoch += 1;
          // Capture the final staged entry before any observer can reenter this owner.
          committed = flows.get(params.flowId);
        },
        publish: () => {
          if (!changed || flows.get(params.flowId) !== committed) {
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
              flowId: params.flowId,
              previous,
            }));
          }
        },
      };
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
  const prepared = prepareTaskMirroredFlowSyncFromCurrent(task, flow);
  // Older mirrored rows stored SQL NULL for the same cleared wait state as JSON null.
  if (
    areTaskFlowRecordsEqual(
      { ...prepared.current, waitJson: prepared.current.waitJson ?? null },
      { ...prepared.next, revision: prepared.current.revision },
    )
  ) {
    return { ok: true, flow };
  }
  const updated = writeFlowRecord(prepared.next, prepared.current);
  if (!updated) {
    return {
      ok: false,
      reason: "persist_failed",
      current: flow,
    };
  }
  return { ok: true, flow: updated };
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
export function publishTaskFlowAfterAtomicStore(
  prepared: PreparedTaskMirroredFlowSync,
  deferredObserverEvents: Array<() => void>,
): void {
  const next = cloneFlowRecord(prepared.next);
  flows.set(next.flowId, next);
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

export function getTaskMirroredFlowIds(flowIds: Iterable<string>): ReadonlySet<string> {
  ensureTaskFlowRegistryReady();
  const mirrored = new Set<string>();
  for (const flowId of flowIds) {
    if (flows.get(flowId)?.syncMode === "task_mirrored") {
      mirrored.add(flowId);
    }
  }
  return mirrored;
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
