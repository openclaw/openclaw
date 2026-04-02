import crypto from "node:crypto";
import {
  getFlowRegistryHooks,
  getFlowRegistryStore,
  resetFlowRegistryRuntimeForTests,
  type FlowRegistryHookEvent,
} from "./flow-registry.store.js";
import type { FlowRecord, FlowStatus, FlowSyncMode, JsonValue } from "./flow-registry.types.js";
import type { TaskNotifyPolicy, TaskRecord } from "./task-registry.types.js";

const flows = new Map<string, FlowRecord>();
let restoreAttempted = false;

type FlowRecordPatch = Omit<
  Partial<
    Pick<
      FlowRecord,
      | "status"
      | "notifyPolicy"
      | "goal"
      | "currentStep"
      | "blockedTaskId"
      | "blockedSummary"
      | "controllerId"
      | "stateJson"
      | "waitJson"
      | "cancelRequestedAt"
      | "updatedAt"
      | "endedAt"
    >
  >,
  | "currentStep"
  | "blockedTaskId"
  | "blockedSummary"
  | "controllerId"
  | "stateJson"
  | "waitJson"
  | "cancelRequestedAt"
  | "endedAt"
> & {
  currentStep?: string | null;
  blockedTaskId?: string | null;
  blockedSummary?: string | null;
  controllerId?: string | null;
  stateJson?: JsonValue | null;
  waitJson?: JsonValue | null;
  cancelRequestedAt?: number | null;
  endedAt?: number | null;
};

export type FlowUpdateResult =
  | {
      applied: true;
      flow: FlowRecord;
    }
  | {
      applied: false;
      reason: "not_found" | "revision_conflict";
      current?: FlowRecord;
    };

function cloneStructuredValue<T>(value: T | undefined): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  return structuredClone(value);
}

function cloneFlowRecord(record: FlowRecord): FlowRecord {
  return {
    ...record,
    ...(record.requesterOrigin
      ? { requesterOrigin: cloneStructuredValue(record.requesterOrigin)! }
      : {}),
    ...(record.stateJson !== undefined
      ? { stateJson: cloneStructuredValue(record.stateJson)! }
      : {}),
    ...(record.waitJson !== undefined ? { waitJson: cloneStructuredValue(record.waitJson)! } : {}),
  };
}

function normalizeRestoredFlowRecord(record: FlowRecord): FlowRecord {
  const syncMode = record.syncMode === "task_mirrored" ? "task_mirrored" : "managed";
  const controllerId =
    syncMode === "managed"
      ? (normalizeText(record.controllerId) ?? "core/legacy-restored")
      : undefined;
  return {
    ...record,
    syncMode,
    ownerKey: assertFlowOwnerKey(record.ownerKey),
    ...(record.requesterOrigin
      ? { requesterOrigin: cloneStructuredValue(record.requesterOrigin)! }
      : {}),
    ...(controllerId ? { controllerId } : {}),
    currentStep: normalizeText(record.currentStep),
    blockedTaskId: normalizeText(record.blockedTaskId),
    blockedSummary: normalizeText(record.blockedSummary),
    ...(record.stateJson !== undefined
      ? { stateJson: cloneStructuredValue(record.stateJson)! }
      : {}),
    ...(record.waitJson !== undefined ? { waitJson: cloneStructuredValue(record.waitJson)! } : {}),
    revision: Math.max(0, record.revision),
    cancelRequestedAt: record.cancelRequestedAt ?? undefined,
    endedAt: record.endedAt ?? undefined,
  };
}

function snapshotFlowRecords(source: ReadonlyMap<string, FlowRecord>): FlowRecord[] {
  return [...source.values()].map((record) => cloneFlowRecord(record));
}

function emitFlowRegistryHookEvent(createEvent: () => FlowRegistryHookEvent): void {
  const hooks = getFlowRegistryHooks();
  if (!hooks?.onEvent) {
    return;
  }
  try {
    hooks.onEvent(createEvent());
  } catch {
    // Flow hooks are observational. They must not break registry writes.
  }
}

function ensureNotifyPolicy(notifyPolicy?: TaskNotifyPolicy): TaskNotifyPolicy {
  return notifyPolicy ?? "done_only";
}

function normalizeOwnerKey(ownerKey?: string): string | undefined {
  const trimmed = ownerKey?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeText(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeJsonBlob(value: JsonValue | null | undefined): JsonValue | undefined {
  return value === undefined ? undefined : cloneStructuredValue(value);
}

function assertFlowOwnerKey(ownerKey: string): string {
  const normalized = normalizeOwnerKey(ownerKey);
  if (!normalized) {
    throw new Error("Flow ownerKey is required.");
  }
  return normalized;
}

function assertControllerId(controllerId?: string | null): string {
  const normalized = normalizeText(controllerId);
  if (!normalized) {
    throw new Error("Managed flow controllerId is required.");
  }
  return normalized;
}

function resolveFlowGoal(task: Pick<TaskRecord, "label" | "task">): string {
  return task.label?.trim() || task.task.trim() || "Background task";
}

function resolveFlowBlockedSummary(
  task: Pick<TaskRecord, "status" | "terminalOutcome" | "terminalSummary" | "progressSummary">,
): string | undefined {
  if (task.status !== "succeeded" || task.terminalOutcome !== "blocked") {
    return undefined;
  }
  return task.terminalSummary?.trim() || task.progressSummary?.trim() || undefined;
}

export function deriveFlowStatusFromTask(
  task: Pick<TaskRecord, "status" | "terminalOutcome">,
): FlowStatus {
  if (task.status === "queued") {
    return "queued";
  }
  if (task.status === "running") {
    return "running";
  }
  if (task.status === "succeeded") {
    return task.terminalOutcome === "blocked" ? "blocked" : "succeeded";
  }
  if (task.status === "cancelled") {
    return "cancelled";
  }
  if (task.status === "lost") {
    return "lost";
  }
  return "failed";
}

function ensureFlowRegistryReady() {
  if (restoreAttempted) {
    return;
  }
  restoreAttempted = true;
  const restored = getFlowRegistryStore().loadSnapshot();
  flows.clear();
  for (const [flowId, flow] of restored.flows) {
    flows.set(flowId, normalizeRestoredFlowRecord(flow));
  }
  emitFlowRegistryHookEvent(() => ({
    kind: "restored",
    flows: snapshotFlowRecords(flows),
  }));
}

function persistFlowRegistry() {
  getFlowRegistryStore().saveSnapshot({
    flows: new Map(snapshotFlowRecords(flows).map((flow) => [flow.flowId, flow])),
  });
}

function persistFlowUpsert(flow: FlowRecord) {
  const store = getFlowRegistryStore();
  if (store.upsertFlow) {
    store.upsertFlow(cloneFlowRecord(flow));
    return;
  }
  persistFlowRegistry();
}

function persistFlowDelete(flowId: string) {
  const store = getFlowRegistryStore();
  if (store.deleteFlow) {
    store.deleteFlow(flowId);
    return;
  }
  persistFlowRegistry();
}

function buildFlowRecord(params: {
  syncMode?: FlowSyncMode;
  ownerKey: string;
  requesterOrigin?: FlowRecord["requesterOrigin"];
  controllerId?: string | null;
  revision?: number;
  status?: FlowStatus;
  notifyPolicy?: TaskNotifyPolicy;
  goal: string;
  currentStep?: string | null;
  blockedTaskId?: string | null;
  blockedSummary?: string | null;
  stateJson?: JsonValue | null;
  waitJson?: JsonValue | null;
  cancelRequestedAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
  endedAt?: number | null;
}): FlowRecord {
  const now = params.createdAt ?? Date.now();
  const syncMode = params.syncMode ?? "managed";
  const controllerId = syncMode === "managed" ? assertControllerId(params.controllerId) : undefined;
  return {
    flowId: crypto.randomUUID(),
    syncMode,
    ownerKey: assertFlowOwnerKey(params.ownerKey),
    ...(params.requesterOrigin
      ? { requesterOrigin: cloneStructuredValue(params.requesterOrigin)! }
      : {}),
    ...(controllerId ? { controllerId } : {}),
    revision: Math.max(0, params.revision ?? 0),
    status: params.status ?? "queued",
    notifyPolicy: ensureNotifyPolicy(params.notifyPolicy),
    goal: params.goal,
    currentStep: normalizeText(params.currentStep),
    blockedTaskId: normalizeText(params.blockedTaskId),
    blockedSummary: normalizeText(params.blockedSummary),
    ...(normalizeJsonBlob(params.stateJson) !== undefined
      ? { stateJson: normalizeJsonBlob(params.stateJson)! }
      : {}),
    ...(normalizeJsonBlob(params.waitJson) !== undefined
      ? { waitJson: normalizeJsonBlob(params.waitJson)! }
      : {}),
    ...(params.cancelRequestedAt != null ? { cancelRequestedAt: params.cancelRequestedAt } : {}),
    createdAt: now,
    updatedAt: params.updatedAt ?? now,
    ...(params.endedAt != null ? { endedAt: params.endedAt } : {}),
  };
}

function applyFlowPatch(current: FlowRecord, patch: FlowRecordPatch): FlowRecord {
  const controllerId =
    patch.controllerId === undefined ? current.controllerId : normalizeText(patch.controllerId);
  if (current.syncMode === "managed") {
    assertControllerId(controllerId);
  }
  return {
    ...current,
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.notifyPolicy ? { notifyPolicy: patch.notifyPolicy } : {}),
    ...(patch.goal ? { goal: patch.goal } : {}),
    controllerId,
    currentStep:
      patch.currentStep === undefined ? current.currentStep : normalizeText(patch.currentStep),
    blockedTaskId:
      patch.blockedTaskId === undefined
        ? current.blockedTaskId
        : normalizeText(patch.blockedTaskId),
    blockedSummary:
      patch.blockedSummary === undefined
        ? current.blockedSummary
        : normalizeText(patch.blockedSummary),
    stateJson:
      patch.stateJson === undefined ? current.stateJson : normalizeJsonBlob(patch.stateJson),
    waitJson: patch.waitJson === undefined ? current.waitJson : normalizeJsonBlob(patch.waitJson),
    cancelRequestedAt:
      patch.cancelRequestedAt === undefined
        ? current.cancelRequestedAt
        : (patch.cancelRequestedAt ?? undefined),
    revision: current.revision + 1,
    updatedAt: patch.updatedAt ?? Date.now(),
    endedAt: patch.endedAt === undefined ? current.endedAt : (patch.endedAt ?? undefined),
  };
}

function writeFlowRecord(next: FlowRecord, previous?: FlowRecord): FlowRecord {
  flows.set(next.flowId, next);
  persistFlowUpsert(next);
  emitFlowRegistryHookEvent(() => ({
    kind: "upserted",
    flow: cloneFlowRecord(next),
    ...(previous ? { previous: cloneFlowRecord(previous) } : {}),
  }));
  return cloneFlowRecord(next);
}

export function createFlowRecord(params: {
  syncMode?: FlowSyncMode;
  ownerKey: string;
  requesterOrigin?: FlowRecord["requesterOrigin"];
  controllerId?: string | null;
  revision?: number;
  status?: FlowStatus;
  notifyPolicy?: TaskNotifyPolicy;
  goal: string;
  currentStep?: string | null;
  blockedTaskId?: string | null;
  blockedSummary?: string | null;
  stateJson?: JsonValue | null;
  waitJson?: JsonValue | null;
  cancelRequestedAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
  endedAt?: number | null;
}): FlowRecord {
  ensureFlowRegistryReady();
  const record = buildFlowRecord(params);
  return writeFlowRecord(record);
}

export function createManagedFlow(params: {
  ownerKey: string;
  controllerId: string;
  requesterOrigin?: FlowRecord["requesterOrigin"];
  status?: FlowStatus;
  notifyPolicy?: TaskNotifyPolicy;
  goal: string;
  currentStep?: string | null;
  blockedTaskId?: string | null;
  blockedSummary?: string | null;
  stateJson?: JsonValue | null;
  waitJson?: JsonValue | null;
  cancelRequestedAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
  endedAt?: number | null;
}): FlowRecord {
  return createFlowRecord({
    ...params,
    syncMode: "managed",
    controllerId: assertControllerId(params.controllerId),
  });
}

export function createFlowForTask(params: {
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
  requesterOrigin?: FlowRecord["requesterOrigin"];
}): FlowRecord {
  const terminalFlowStatus = deriveFlowStatusFromTask(params.task);
  const isTerminal =
    terminalFlowStatus === "succeeded" ||
    terminalFlowStatus === "blocked" ||
    terminalFlowStatus === "failed" ||
    terminalFlowStatus === "cancelled" ||
    terminalFlowStatus === "lost";
  const endedAt = isTerminal
    ? (params.task.endedAt ?? params.task.lastEventAt ?? params.task.createdAt)
    : undefined;
  return createFlowRecord({
    syncMode: "task_mirrored",
    ownerKey: params.task.ownerKey,
    requesterOrigin: params.requesterOrigin,
    status: terminalFlowStatus,
    notifyPolicy: params.task.notifyPolicy,
    goal: resolveFlowGoal(params.task),
    blockedTaskId:
      terminalFlowStatus === "blocked" ? params.task.taskId.trim() || undefined : undefined,
    blockedSummary: resolveFlowBlockedSummary(params.task),
    createdAt: params.task.createdAt,
    updatedAt: params.task.lastEventAt ?? params.task.createdAt,
    ...(endedAt !== undefined ? { endedAt } : {}),
  });
}

function updateFlowRecordByIdUnchecked(flowId: string, patch: FlowRecordPatch): FlowRecord | null {
  ensureFlowRegistryReady();
  const current = flows.get(flowId);
  if (!current) {
    return null;
  }
  return writeFlowRecord(applyFlowPatch(current, patch), current);
}

export function updateFlowRecordByIdExpectedRevision(params: {
  flowId: string;
  expectedRevision: number;
  patch: FlowRecordPatch;
}): FlowUpdateResult {
  ensureFlowRegistryReady();
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
  return {
    applied: true,
    flow: writeFlowRecord(applyFlowPatch(current, params.patch), current),
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
}): FlowUpdateResult {
  return updateFlowRecordByIdExpectedRevision({
    flowId: params.flowId,
    expectedRevision: params.expectedRevision,
    patch: {
      status:
        normalizeText(params.blockedTaskId) || normalizeText(params.blockedSummary)
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
  status?: Extract<FlowStatus, "queued" | "running">;
  currentStep?: string | null;
  stateJson?: JsonValue | null;
  updatedAt?: number;
}): FlowUpdateResult {
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
}): FlowUpdateResult {
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
}): FlowUpdateResult {
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
}): FlowUpdateResult {
  return updateFlowRecordByIdExpectedRevision({
    flowId: params.flowId,
    expectedRevision: params.expectedRevision,
    patch: {
      cancelRequestedAt: params.cancelRequestedAt ?? params.updatedAt ?? Date.now(),
      updatedAt: params.updatedAt,
    },
  });
}

export function syncFlowFromTask(
  task: Pick<
    TaskRecord,
    | "parentFlowId"
    | "status"
    | "terminalOutcome"
    | "notifyPolicy"
    | "label"
    | "task"
    | "lastEventAt"
    | "endedAt"
    | "taskId"
    | "terminalSummary"
    | "progressSummary"
  >,
): FlowRecord | null {
  const flowId = task.parentFlowId?.trim();
  if (!flowId) {
    return null;
  }
  const flow = getFlowById(flowId);
  if (!flow) {
    return null;
  }
  if (flow.syncMode !== "task_mirrored") {
    return flow;
  }
  const terminalFlowStatus = deriveFlowStatusFromTask(task);
  const isTerminal =
    terminalFlowStatus === "succeeded" ||
    terminalFlowStatus === "blocked" ||
    terminalFlowStatus === "failed" ||
    terminalFlowStatus === "cancelled" ||
    terminalFlowStatus === "lost";
  return updateFlowRecordByIdUnchecked(flowId, {
    status: terminalFlowStatus,
    notifyPolicy: task.notifyPolicy,
    goal: resolveFlowGoal(task),
    blockedTaskId: terminalFlowStatus === "blocked" ? task.taskId.trim() || null : null,
    blockedSummary:
      terminalFlowStatus === "blocked" ? (resolveFlowBlockedSummary(task) ?? null) : null,
    waitJson: null,
    updatedAt: task.lastEventAt ?? Date.now(),
    ...(isTerminal
      ? {
          endedAt: task.endedAt ?? task.lastEventAt ?? Date.now(),
        }
      : { endedAt: null }),
  });
}

export function getFlowById(flowId: string): FlowRecord | undefined {
  ensureFlowRegistryReady();
  const flow = flows.get(flowId);
  return flow ? cloneFlowRecord(flow) : undefined;
}

export function listFlowsForOwnerKey(ownerKey: string): FlowRecord[] {
  ensureFlowRegistryReady();
  const normalizedOwnerKey = ownerKey.trim();
  if (!normalizedOwnerKey) {
    return [];
  }
  return [...flows.values()]
    .filter((flow) => flow.ownerKey.trim() === normalizedOwnerKey)
    .map((flow) => cloneFlowRecord(flow))
    .toSorted((left, right) => right.createdAt - left.createdAt);
}

export function findLatestFlowForOwnerKey(ownerKey: string): FlowRecord | undefined {
  const flow = listFlowsForOwnerKey(ownerKey)[0];
  return flow ? cloneFlowRecord(flow) : undefined;
}

export function resolveFlowForLookupToken(token: string): FlowRecord | undefined {
  const lookup = token.trim();
  if (!lookup) {
    return undefined;
  }
  return getFlowById(lookup) ?? findLatestFlowForOwnerKey(lookup);
}

export function listFlowRecords(): FlowRecord[] {
  ensureFlowRegistryReady();
  return [...flows.values()]
    .map((flow) => cloneFlowRecord(flow))
    .toSorted((left, right) => right.createdAt - left.createdAt);
}

export function deleteFlowRecordById(flowId: string): boolean {
  ensureFlowRegistryReady();
  const current = flows.get(flowId);
  if (!current) {
    return false;
  }
  flows.delete(flowId);
  persistFlowDelete(flowId);
  emitFlowRegistryHookEvent(() => ({
    kind: "deleted",
    flowId,
    previous: cloneFlowRecord(current),
  }));
  return true;
}

export function resetFlowRegistryForTests(opts?: { persist?: boolean }) {
  flows.clear();
  restoreAttempted = false;
  resetFlowRegistryRuntimeForTests();
  if (opts?.persist !== false) {
    persistFlowRegistry();
    getFlowRegistryStore().close?.();
  }
}
