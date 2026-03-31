import crypto from "node:crypto";
import { getFlowRegistryStore, resetFlowRegistryRuntimeForTests } from "./flow-registry.store.js";
import type { FlowRecord, FlowShape, FlowStatus } from "./flow-registry.types.js";
import type { TaskNotifyPolicy, TaskRecord } from "./task-registry.types.js";

const flows = new Map<string, FlowRecord>();
let restoreAttempted = false;

function cloneFlowRecord(record: FlowRecord): FlowRecord {
  return {
    ...record,
    ...(record.requesterOrigin ? { requesterOrigin: { ...record.requesterOrigin } } : {}),
  };
}

function snapshotFlowRecords(source: ReadonlyMap<string, FlowRecord>): FlowRecord[] {
  return [...source.values()].map((record) => cloneFlowRecord(record));
}

function ensureNotifyPolicy(notifyPolicy?: TaskNotifyPolicy): TaskNotifyPolicy {
  return notifyPolicy ?? "done_only";
}

function ensureFlowShape(shape?: FlowShape): FlowShape {
  return shape ?? "linear";
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

type FlowRecordPatch = Partial<
  Pick<
    FlowRecord,
    | "status"
    | "notifyPolicy"
    | "goal"
    | "currentStep"
    | "blockedTaskId"
    | "blockedSummary"
    | "updatedAt"
    | "endedAt"
  >
> & {
  currentStep?: string | null;
  blockedTaskId?: string | null;
  blockedSummary?: string | null;
  endedAt?: number | null;
};

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
    flows.set(flowId, cloneFlowRecord(flow));
  }
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

export function createFlowRecord(params: {
  shape?: FlowShape;
  ownerSessionKey: string;
  requesterOrigin?: FlowRecord["requesterOrigin"];
  status?: FlowStatus;
  notifyPolicy?: TaskNotifyPolicy;
  goal: string;
  currentStep?: string;
  blockedTaskId?: string;
  blockedSummary?: string;
  createdAt?: number;
  updatedAt?: number;
  endedAt?: number;
}): FlowRecord {
  ensureFlowRegistryReady();
  const now = params.createdAt ?? Date.now();
  const record: FlowRecord = {
    flowId: crypto.randomUUID(),
    shape: ensureFlowShape(params.shape),
    ownerSessionKey: params.ownerSessionKey,
    ...(params.requesterOrigin ? { requesterOrigin: { ...params.requesterOrigin } } : {}),
    status: params.status ?? "queued",
    notifyPolicy: ensureNotifyPolicy(params.notifyPolicy),
    goal: params.goal,
    currentStep: params.currentStep?.trim() || undefined,
    blockedTaskId: params.blockedTaskId?.trim() || undefined,
    blockedSummary: params.blockedSummary?.trim() || undefined,
    createdAt: now,
    updatedAt: params.updatedAt ?? now,
    ...(params.endedAt !== undefined ? { endedAt: params.endedAt } : {}),
  };
  flows.set(record.flowId, record);
  persistFlowUpsert(record);
  return cloneFlowRecord(record);
}

export function createFlowForTask(params: {
  task: Pick<
    TaskRecord,
    | "requesterSessionKey"
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
    shape: "single_task",
    ownerSessionKey: params.task.requesterSessionKey,
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

export function updateFlowRecordById(flowId: string, patch: FlowRecordPatch): FlowRecord | null {
  ensureFlowRegistryReady();
  const current = flows.get(flowId);
  if (!current) {
    return null;
  }
  const next: FlowRecord = {
    ...current,
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.notifyPolicy ? { notifyPolicy: patch.notifyPolicy } : {}),
    ...(patch.goal ? { goal: patch.goal } : {}),
    currentStep:
      patch.currentStep === undefined
        ? current.currentStep
        : patch.currentStep?.trim() || undefined,
    blockedTaskId:
      patch.blockedTaskId === undefined
        ? current.blockedTaskId
        : patch.blockedTaskId?.trim() || undefined,
    blockedSummary:
      patch.blockedSummary === undefined
        ? current.blockedSummary
        : patch.blockedSummary?.trim() || undefined,
    updatedAt: patch.updatedAt ?? Date.now(),
    endedAt: patch.endedAt === undefined ? current.endedAt : (patch.endedAt ?? undefined),
  };
  flows.set(flowId, next);
  persistFlowUpsert(next);
  return cloneFlowRecord(next);
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
  if (flow.shape !== "single_task") {
    return flow;
  }
  const terminalFlowStatus = deriveFlowStatusFromTask(task);
  const isTerminal =
    terminalFlowStatus === "succeeded" ||
    terminalFlowStatus === "blocked" ||
    terminalFlowStatus === "failed" ||
    terminalFlowStatus === "cancelled" ||
    terminalFlowStatus === "lost";
  return updateFlowRecordById(flowId, {
    status: terminalFlowStatus,
    notifyPolicy: task.notifyPolicy,
    goal: resolveFlowGoal(task),
    blockedTaskId: terminalFlowStatus === "blocked" ? task.taskId.trim() || null : null,
    blockedSummary:
      terminalFlowStatus === "blocked" ? (resolveFlowBlockedSummary(task) ?? null) : null,
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

export function listFlowsForOwnerSessionKey(sessionKey: string): FlowRecord[] {
  ensureFlowRegistryReady();
  const normalizedSessionKey = sessionKey.trim();
  if (!normalizedSessionKey) {
    return [];
  }
  return [...flows.values()]
    .filter((flow) => flow.ownerSessionKey.trim() === normalizedSessionKey)
    .map((flow) => cloneFlowRecord(flow))
    .toSorted((left, right) => right.createdAt - left.createdAt);
}

export function findLatestFlowForOwnerSessionKey(sessionKey: string): FlowRecord | undefined {
  const flow = listFlowsForOwnerSessionKey(sessionKey)[0];
  return flow ? cloneFlowRecord(flow) : undefined;
}

export function resolveFlowForLookupToken(token: string): FlowRecord | undefined {
  const lookup = token.trim();
  if (!lookup) {
    return undefined;
  }
  return getFlowById(lookup) ?? findLatestFlowForOwnerSessionKey(lookup);
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
