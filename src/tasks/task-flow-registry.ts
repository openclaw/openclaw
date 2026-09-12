// Coordinates managed task-flow creation, updates, ownership, and snapshots.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  applyFlowPatch,
  assertControllerId,
  buildFlowRecord,
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

function emitFlowRegistryObserverEvent(createEvent: () => TaskFlowRegistryObserverEvent): void {
  const observers = getTaskFlowRegistryObservers();
  if (!observers?.onEvent) {
    return;
  }
  try {
    observers.onEvent(createEvent());
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
    flows: snapshotFlowRecords(flows),
  }));
}

export function ensureTaskFlowRegistryReady(): void {
  restoreTaskFlowRegistryOnce();
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
  emitFlowRegistryObserverEvent(() => ({
    kind: "upserted",
    flow: cloneFlowRecord(next),
    ...(previous ? { previous: cloneFlowRecord(previous) } : {}),
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
  const current = flows.get(params.flowId);
  if (!current) {
    return {
      applied: false,
      reason: "not_found",
    };
  }
  if (current.revision !== params.expectedRevision) {
    return {
      applied: false,
      reason: "revision_conflict",
      current: cloneFlowRecord(current),
    };
  }
  const flow = writeFlowRecord(applyFlowPatch(current, params.patch), current);
  if (!flow) {
    return {
      applied: false,
      reason: "persist_failed",
      current: cloneFlowRecord(current),
    };
  }
  return {
    applied: true,
    flow,
  };
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
    patch: {
      status:
        normalizeOptionalString(params.blockedTaskId) ||
        normalizeOptionalString(params.blockedSummary)
          ? "blocked"
          : "waiting",
      currentStep: params.currentStep,
      stateJson: params.stateJson,
      waitJson: params.waitJson,
      blockedTaskId: params.blockedTaskId,
      blockedSummary: params.blockedSummary,
      endedAt: null,
      updatedAt: params.updatedAt,
    },
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
    patch: {
      status: params.status ?? "queued",
      currentStep: params.currentStep,
      stateJson: params.stateJson,
      waitJson: null,
      blockedTaskId: null,
      blockedSummary: null,
      endedAt: null,
      updatedAt: params.updatedAt,
    },
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
  const endedAt = params.endedAt ?? params.updatedAt ?? Date.now();
  return updateFlowRecordByIdExpectedRevision({
    flowId: params.flowId,
    expectedRevision: params.expectedRevision,
    patch: {
      status: "succeeded",
      currentStep: params.currentStep,
      stateJson: params.stateJson,
      waitJson: null,
      blockedTaskId: null,
      blockedSummary: null,
      endedAt,
      updatedAt: params.updatedAt ?? endedAt,
    },
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
  const endedAt = params.endedAt ?? params.updatedAt ?? Date.now();
  return updateFlowRecordByIdExpectedRevision({
    flowId: params.flowId,
    expectedRevision: params.expectedRevision,
    patch: {
      status: "failed",
      currentStep: params.currentStep,
      stateJson: params.stateJson,
      waitJson: null,
      blockedTaskId: params.blockedTaskId,
      blockedSummary: params.blockedSummary,
      endedAt,
      updatedAt: params.updatedAt ?? endedAt,
    },
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
    patch: {
      cancelRequestedAt: params.cancelRequestedAt ?? params.updatedAt ?? Date.now(),
      updatedAt: params.updatedAt,
    },
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
  deferredObserverEvents.push(() =>
    emitFlowRegistryObserverEvent(() => ({
      kind: "upserted",
      flow: cloneFlowRecord(next),
      previous: cloneFlowRecord(prepared.current),
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
  emitFlowRegistryObserverEvent(() => ({
    kind: "deleted",
    flowId,
    previous: cloneFlowRecord(current),
  }));
  return true;
}

function resetTaskFlowRegistryForTests() {
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
