import crypto from "node:crypto";
import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import { killSubagentRunAdmin } from "../agents/subagent-control.js";
import type { OpenClawConfig } from "../config/config.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import { isDeliverableMessageChannel } from "../utils/message-channel.js";
import {
  formatTaskBlockedFollowupMessage,
  formatTaskStateChangeMessage,
  formatTaskTerminalMessage,
  isTerminalTaskStatus,
  shouldAutoDeliverTaskStateChange,
  shouldAutoDeliverTaskTerminalUpdate,
  shouldSuppressDuplicateTerminalDelivery,
} from "./task-executor-policy.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import {
  getTaskFlowById,
  syncFlowFromTask,
  updateFlowRecordByIdExpectedRevision,
} from "./task-flow-runtime-internal.js";
import {
  getTaskRegistryObservers,
  getTaskRegistryStore,
  resetTaskRegistryRuntimeForTests,
  type TaskRegistryObserverEvent,
} from "./task-registry.store.js";
import { summarizeTaskRecords } from "./task-registry.summary.js";
import type {
  TaskDeliveryState,
  TaskDeliveryStatus,
  TaskEventKind,
  TaskEventRecord,
  TaskNotifyPolicy,
  TaskRecord,
  TaskRegistrySummary,
  TaskRegistrySnapshot,
  TaskRuntime,
  TaskScopeKind,
  TaskStatus,
  TaskTerminalOutcome,
} from "./task-registry.types.js";

const log = createSubsystemLogger("tasks/registry");
const DEFAULT_TASK_RETENTION_MS = 7 * 24 * 60 * 60_000;

const tasks = new Map<string, TaskRecord>();
const taskDeliveryStates = new Map<string, TaskDeliveryState>();
const taskIdsByRunId = new Map<string, Set<string>>();
const taskIdsByOwnerKey = new Map<string, Set<string>>();
const taskIdsByParentFlowId = new Map<string, Set<string>>();
const taskIdsByRelatedSessionKey = new Map<string, Set<string>>();
const tasksWithPendingDelivery = new Set<string>();
let listenerStarted = false;
let listenerStop: (() => void) | null = null;
let restoreAttempted = false;
let deliveryRuntimePromise: Promise<typeof import("./task-registry-delivery-runtime.js")> | null =
  null;

type TaskDeliveryOwner = {
  sessionKey?: string;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  flowId?: string;
};

export type ParentFlowLinkErrorCode =
  | "scope_kind_not_session"
  | "parent_flow_not_found"
  | "owner_key_mismatch"
  | "cancel_requested"
  | "terminal";

export class ParentFlowLinkError extends Error {
  constructor(
    public readonly code: ParentFlowLinkErrorCode,
    message: string,
    public readonly details?: {
      flowId?: string;
      status?: TaskFlowRecord["status"];
    },
  ) {
    super(message);
    this.name = "ParentFlowLinkError";
  }
}

export function isParentFlowLinkError(error: unknown): error is ParentFlowLinkError {
  return error instanceof ParentFlowLinkError;
}

function isActiveTaskStatus(status: TaskStatus): boolean {
  return status === "queued" || status === "running";
}

function isTerminalFlowStatus(status: TaskFlowRecord["status"]): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost"
  );
}

function assertTaskOwner(params: { ownerKey: string; scopeKind: TaskScopeKind }) {
  const ownerKey = params.ownerKey.trim();
  if (!ownerKey && params.scopeKind !== "system") {
    throw new Error("Task ownerKey is required.");
  }
}

function normalizeOwnerKey(ownerKey?: string): string | undefined {
  const trimmed = ownerKey?.trim();
  return trimmed ? trimmed : undefined;
}

function assertParentFlowLinkAllowed(params: {
  ownerKey: string;
  scopeKind: TaskScopeKind;
  parentFlowId?: string;
}) {
  const flowId = params.parentFlowId?.trim();
  if (!flowId) {
    return;
  }
  if (params.scopeKind !== "session") {
    throw new ParentFlowLinkError(
      "scope_kind_not_session",
      "Only session-scoped tasks can link to flows.",
      { flowId },
    );
  }
  const flow = getTaskFlowById(flowId);
  if (!flow) {
    throw new ParentFlowLinkError("parent_flow_not_found", `Parent flow not found: ${flowId}`, {
      flowId,
    });
  }
  if (normalizeOwnerKey(flow.ownerKey) !== normalizeOwnerKey(params.ownerKey)) {
    throw new ParentFlowLinkError(
      "owner_key_mismatch",
      "Task ownerKey must match parent flow ownerKey.",
      { flowId },
    );
  }
  if (flow.cancelRequestedAt != null) {
    throw new ParentFlowLinkError(
      "cancel_requested",
      "Parent flow cancellation has already been requested.",
      { flowId, status: flow.status },
    );
  }
  if (isTerminalFlowStatus(flow.status)) {
    throw new ParentFlowLinkError("terminal", `Parent flow is already ${flow.status}.`, {
      flowId,
      status: flow.status,
    });
  }
}

function cloneTaskRecord(record: TaskRecord): TaskRecord {
  return { ...record };
}

function cloneTaskDeliveryState(state: TaskDeliveryState): TaskDeliveryState {
  return {
    ...state,
    ...(state.requesterOrigin ? { requesterOrigin: { ...state.requesterOrigin } } : {}),
  };
}

function snapshotTaskRecords(source: ReadonlyMap<string, TaskRecord>): TaskRecord[] {
  return [...source.values()].map((record) => cloneTaskRecord(record));
}

function emitTaskRegistryObserverEvent(createEvent: () => TaskRegistryObserverEvent): void {
  const observers = getTaskRegistryObservers();
  if (!observers?.onEvent) {
    return;
  }
  try {
    observers.onEvent(createEvent());
  } catch (error) {
    log.warn("Task registry observer failed", {
      event: "task-registry",
      error,
    });
  }
}

function persistTaskRegistry() {
  getTaskRegistryStore().saveSnapshot({
    tasks,
    deliveryStates: taskDeliveryStates,
  });
}

function persistTaskUpsert(task: TaskRecord) {
  const store = getTaskRegistryStore();
  const deliveryState = taskDeliveryStates.get(task.taskId);
  if (store.upsertTaskWithDeliveryState) {
    store.upsertTaskWithDeliveryState({
      task,
      ...(deliveryState ? { deliveryState } : {}),
    });
    return;
  }
  if (store.upsertTask) {
    store.upsertTask(task);
    return;
  }
  store.saveSnapshot({
    tasks,
    deliveryStates: taskDeliveryStates,
  });
}

function persistTaskDelete(taskId: string) {
  const store = getTaskRegistryStore();
  if (store.deleteTaskWithDeliveryState) {
    store.deleteTaskWithDeliveryState(taskId);
    return;
  }
  if (store.deleteTask) {
    store.deleteTask(taskId);
    return;
  }
  store.saveSnapshot({
    tasks,
    deliveryStates: taskDeliveryStates,
  });
}

function persistTaskDeliveryStateUpsert(state: TaskDeliveryState) {
  const store = getTaskRegistryStore();
  if (store.upsertDeliveryState) {
    store.upsertDeliveryState(state);
    return;
  }
  store.saveSnapshot({
    tasks,
    deliveryStates: taskDeliveryStates,
  });
}

function persistTaskDeliveryStateDelete(taskId: string) {
  const store = getTaskRegistryStore();
  if (store.deleteDeliveryState) {
    store.deleteDeliveryState(taskId);
    return;
  }
  store.saveSnapshot({
    tasks,
    deliveryStates: taskDeliveryStates,
  });
}

function ensureDeliveryStatus(params: {
  ownerKey: string;
  scopeKind: TaskScopeKind;
}): TaskDeliveryStatus {
  if (params.scopeKind === "system") {
    return "not_applicable";
  }
  return params.ownerKey.trim() ? "pending" : "parent_missing";
}

function ensureNotifyPolicy(params: {
  notifyPolicy?: TaskNotifyPolicy;
  deliveryStatus?: TaskDeliveryStatus;
  ownerKey: string;
  scopeKind: TaskScopeKind;
}): TaskNotifyPolicy {
  if (params.notifyPolicy) {
    return params.notifyPolicy;
  }
  const deliveryStatus =
    params.deliveryStatus ??
    ensureDeliveryStatus({
      ownerKey: params.ownerKey,
      scopeKind: params.scopeKind,
    });
  return deliveryStatus === "not_applicable" ? "silent" : "done_only";
}

function resolveTaskScopeKind(params: {
  scopeKind?: TaskScopeKind;
  requesterSessionKey: string;
}): TaskScopeKind {
  if (params.scopeKind) {
    return params.scopeKind;
  }
  return params.requesterSessionKey.trim() ? "session" : "system";
}

function resolveTaskRequesterSessionKey(params: {
  requesterSessionKey?: string;
  ownerKey?: string;
  scopeKind?: TaskScopeKind;
}): string {
  const requesterSessionKey = params.requesterSessionKey?.trim();
  if (requesterSessionKey) {
    return requesterSessionKey;
  }
  if (params.scopeKind === "system") {
    return "";
  }
  return params.ownerKey?.trim() ?? "";
}

function resolveTaskOwnerKey(params: { requesterSessionKey: string; ownerKey?: string }): string {
  return params.ownerKey?.trim() || params.requesterSessionKey.trim();
}

function normalizeTaskSummary(value: string | null | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function normalizeTaskStatus(value: TaskStatus | null | undefined): TaskStatus {
  return value === "running" ||
    value === "queued" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "timed_out" ||
    value === "cancelled" ||
    value === "lost"
    ? value
    : "queued";
}

function normalizeTaskTerminalOutcome(
  value: TaskTerminalOutcome | null | undefined,
): TaskTerminalOutcome | undefined {
  return value === "succeeded" || value === "blocked" ? value : undefined;
}

function resolveTaskTerminalOutcome(params: {
  status: TaskStatus;
  terminalOutcome?: TaskTerminalOutcome | null;
}): TaskTerminalOutcome | undefined {
  const normalized = normalizeTaskTerminalOutcome(params.terminalOutcome);
  if (normalized) {
    return normalized;
  }
  return params.status === "succeeded" ? "succeeded" : undefined;
}

function appendTaskEvent(event: {
  at: number;
  kind: TaskEventKind;
  summary?: string | null;
}): TaskEventRecord {
  const summary = normalizeTaskSummary(event.summary);
  return {
    at: event.at,
    kind: event.kind,
    ...(summary ? { summary } : {}),
  };
}

function loadTaskRegistryDeliveryRuntime() {
  deliveryRuntimePromise ??= import("./task-registry-delivery-runtime.js");
  return deliveryRuntimePromise;
}

function addRunIdIndex(taskId: string, runId?: string) {
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

function normalizeSessionIndexKey(sessionKey?: string): string | undefined {
  const trimmed = sessionKey?.trim();
  return trimmed ? trimmed : undefined;
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

function getTaskRelatedSessionIndexKeys(task: Pick<TaskRecord, "ownerKey" | "childSessionKey">) {
  return [
    ...new Set(
      [
        normalizeSessionIndexKey(task.ownerKey),
        normalizeSessionIndexKey(task.childSessionKey),
      ].filter(Boolean) as string[],
    ),
  ];
}

function addOwnerKeyIndex(taskId: string, task: Pick<TaskRecord, "ownerKey">) {
  const key = normalizeSessionIndexKey(task.ownerKey);
  if (!key) {
    return;
  }
  addIndexedKey(taskIdsByOwnerKey, key, taskId);
}

function deleteOwnerKeyIndex(taskId: string, task: Pick<TaskRecord, "ownerKey">) {
  const key = normalizeSessionIndexKey(task.ownerKey);
  if (!key) {
    return;
  }
  deleteIndexedKey(taskIdsByOwnerKey, key, taskId);
}

function addParentFlowIdIndex(taskId: string, task: Pick<TaskRecord, "parentFlowId">) {
  const key = task.parentFlowId?.trim();
  if (!key) {
    return;
  }
  addIndexedKey(taskIdsByParentFlowId, key, taskId);
}

function deleteParentFlowIdIndex(taskId: string, task: Pick<TaskRecord, "parentFlowId">) {
  const key = task.parentFlowId?.trim();
  if (!key) {
    return;
  }
  deleteIndexedKey(taskIdsByParentFlowId, key, taskId);
}

function addRelatedSessionKeyIndex(
  taskId: string,
  task: Pick<TaskRecord, "ownerKey" | "childSessionKey">,
) {
  for (const sessionKey of getTaskRelatedSessionIndexKeys(task)) {
    addIndexedKey(taskIdsByRelatedSessionKey, sessionKey, taskId);
  }
}

function deleteRelatedSessionKeyIndex(
  taskId: string,
  task: Pick<TaskRecord, "ownerKey" | "childSessionKey">,
) {
  for (const sessionKey of getTaskRelatedSessionIndexKeys(task)) {
    deleteIndexedKey(taskIdsByRelatedSessionKey, sessionKey, taskId);
  }
}

function rebuildRunIdIndex() {
  taskIdsByRunId.clear();
  for (const [taskId, task] of tasks.entries()) {
    addRunIdIndex(taskId, task.runId);
  }
}

function rebuildOwnerKeyIndex() {
  taskIdsByOwnerKey.clear();
  for (const [taskId, task] of tasks.entries()) {
    addOwnerKeyIndex(taskId, task);
  }
}

function rebuildParentFlowIdIndex() {
  taskIdsByParentFlowId.clear();
  for (const [taskId, task] of tasks.entries()) {
    addParentFlowIdIndex(taskId, task);
  }
}

function rebuildRelatedSessionKeyIndex() {
  taskIdsByRelatedSessionKey.clear();
  for (const [taskId, task] of tasks.entries()) {
    addRelatedSessionKeyIndex(taskId, task);
  }
}

function getTasksByRunId(runId: string): TaskRecord[] {
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
    normalizeComparableText(task.ownerKey),
    normalizeComparableText(task.childSessionKey),
  ].join("\u0000");
}

function getTasksByRunScope(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
}): TaskRecord[] {
  const matches = getTasksByRunId(params.runId).filter(
    (task) => !params.runtime || task.runtime === params.runtime,
  );
  const sessionKey = normalizeSessionIndexKey(params.sessionKey);
  if (sessionKey) {
    const childMatches = matches.filter(
      (task) => normalizeSessionIndexKey(task.childSessionKey) === sessionKey,
    );
    if (childMatches.length > 0) {
      return childMatches;
    }
    const ownerMatches = matches.filter(
      (task) =>
        task.scopeKind === "session" && normalizeSessionIndexKey(task.ownerKey) === sessionKey,
    );
    return ownerMatches;
  }
  const scopeKeys = new Set(matches.map((task) => taskRunScopeKey(task)));
  return scopeKeys.size <= 1 ? matches : [];
}

function getPeerTasksForDelivery(task: TaskRecord): TaskRecord[] {
  if (!task.runId?.trim()) {
    return [];
  }
  return getTasksByRunId(task.runId).filter(
    (candidate) =>
      candidate.runtime === task.runtime &&
      candidate.scopeKind === task.scopeKind &&
      normalizeComparableText(candidate.ownerKey) === normalizeComparableText(task.ownerKey) &&
      normalizeComparableText(candidate.childSessionKey) ===
        normalizeComparableText(task.childSessionKey),
  );
}

function taskLookupPriority(task: TaskRecord): number {
  const runtimePriority = task.runtime === "cli" ? 1 : 0;
  return runtimePriority;
}

function pickPreferredRunIdTask(matches: TaskRecord[]): TaskRecord | undefined {
  return [...matches].toSorted((left, right) => {
    const priorityDiff = taskLookupPriority(left) - taskLookupPriority(right);
    if (priorityDiff !== 0) {
      return priorityDiff;
    }
    return left.createdAt - right.createdAt;
  })[0];
}

function normalizeComparableText(value: string | undefined): string {
  return value?.trim() ?? "";
}

function compareTasksNewestFirst(
  left: Pick<TaskRecord, "createdAt"> & { insertionIndex?: number },
  right: Pick<TaskRecord, "createdAt"> & { insertionIndex?: number },
): number {
  const createdAtDiff = right.createdAt - left.createdAt;
  if (createdAtDiff !== 0) {
    return createdAtDiff;
  }
  return (right.insertionIndex ?? 0) - (left.insertionIndex ?? 0);
}

function findExistingTaskForCreate(params: {
  runtime: TaskRuntime;
  ownerKey: string;
  scopeKind: TaskScopeKind;
  childSessionKey?: string;
  parentFlowId?: string;
  runId?: string;
  label?: string;
  task: string;
}): TaskRecord | undefined {
  const runId = params.runId?.trim();
  const runScopeMatches = runId
    ? getTasksByRunId(runId).filter(
        (task) =>
          task.runtime === params.runtime &&
          task.scopeKind === params.scopeKind &&
          normalizeComparableText(task.ownerKey) === normalizeComparableText(params.ownerKey) &&
          normalizeComparableText(task.childSessionKey) ===
            normalizeComparableText(params.childSessionKey) &&
          normalizeComparableText(task.parentFlowId) ===
            normalizeComparableText(params.parentFlowId),
      )
    : [];
  const exact = runId
    ? runScopeMatches.find(
        (task) =>
          normalizeComparableText(task.label) === normalizeComparableText(params.label) &&
          normalizeComparableText(task.task) === normalizeComparableText(params.task),
      )
    : undefined;
  if (exact) {
    return exact;
  }
  if (!runId || params.runtime !== "acp") {
    return undefined;
  }
  if (runScopeMatches.length === 0) {
    return undefined;
  }
  return pickPreferredRunIdTask(runScopeMatches);
}

function mergeExistingTaskForCreate(
  existing: TaskRecord,
  params: {
    requesterOrigin?: TaskDeliveryState["requesterOrigin"];
    sourceId?: string;
    parentFlowId?: string;
    parentTaskId?: string;
    agentId?: string;
    label?: string;
    task: string;
    preferMetadata?: boolean;
    deliveryStatus?: TaskDeliveryStatus;
    notifyPolicy?: TaskNotifyPolicy;
  },
): TaskRecord {
  const patch: Partial<TaskRecord> = {};
  const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
  const currentDeliveryState = taskDeliveryStates.get(existing.taskId);
  if (requesterOrigin && !currentDeliveryState?.requesterOrigin) {
    upsertTaskDeliveryState({
      taskId: existing.taskId,
      requesterOrigin,
      lastNotifiedEventAt: currentDeliveryState?.lastNotifiedEventAt,
    });
  }
  if (params.sourceId?.trim() && !existing.sourceId?.trim()) {
    patch.sourceId = params.sourceId.trim();
  }
  if (params.parentFlowId?.trim() && !existing.parentFlowId?.trim()) {
    assertParentFlowLinkAllowed({
      ownerKey: existing.ownerKey,
      scopeKind: existing.scopeKind,
      parentFlowId: params.parentFlowId,
    });
    patch.parentFlowId = params.parentFlowId.trim();
  }
  if (params.parentTaskId?.trim() && !existing.parentTaskId?.trim()) {
    patch.parentTaskId = params.parentTaskId.trim();
  }
  if (params.agentId?.trim() && !existing.agentId?.trim()) {
    patch.agentId = params.agentId.trim();
  }
  const nextLabel = params.label?.trim();
  if (params.preferMetadata) {
    if (nextLabel && normalizeComparableText(existing.label) !== nextLabel) {
      patch.label = nextLabel;
    }
    const nextTask = params.task.trim();
    if (nextTask && normalizeComparableText(existing.task) !== nextTask) {
      patch.task = nextTask;
    }
  } else if (nextLabel && !existing.label?.trim()) {
    patch.label = nextLabel;
  }
  if (params.deliveryStatus === "pending" && existing.deliveryStatus !== "delivered") {
    patch.deliveryStatus = "pending";
  }
  const notifyPolicy = ensureNotifyPolicy({
    notifyPolicy: params.notifyPolicy,
    deliveryStatus: params.deliveryStatus,
    ownerKey: existing.ownerKey,
    scopeKind: existing.scopeKind,
  });
  if (notifyPolicy !== existing.notifyPolicy && existing.notifyPolicy === "silent") {
    patch.notifyPolicy = notifyPolicy;
  }
  if (Object.keys(patch).length === 0) {
    return cloneTaskRecord(existing);
  }
  return updateTask(existing.taskId, patch) ?? cloneTaskRecord(existing);
}

function taskTerminalDeliveryIdempotencyKey(task: TaskRecord): string {
  const outcome = task.status === "succeeded" ? (task.terminalOutcome ?? "default") : "default";
  return `task-terminal:${task.taskId}:${task.status}:${outcome}`;
}

function resolveTaskStateChangeIdempotencyKey(params: {
  task: TaskRecord;
  latestEvent: TaskEventRecord;
  owner: TaskDeliveryOwner;
}): string {
  if (params.owner.flowId) {
    return `flow-event:${params.owner.flowId}:${params.task.taskId}:${params.latestEvent.at}:${params.latestEvent.kind}`;
  }
  return `task-event:${params.task.taskId}:${params.latestEvent.at}:${params.latestEvent.kind}`;
}

function resolveTaskTerminalIdempotencyKey(task: TaskRecord): string {
  const owner = resolveTaskDeliveryOwner(task);
  if (owner.flowId) {
    const outcome = task.status === "succeeded" ? (task.terminalOutcome ?? "default") : "default";
    return `flow-terminal:${owner.flowId}:${task.taskId}:${task.status}:${outcome}`;
  }
  return taskTerminalDeliveryIdempotencyKey(task);
}

function getLinkedFlowForDelivery(task: TaskRecord) {
  const flowId = task.parentFlowId?.trim();
  if (!flowId || task.scopeKind !== "session") {
    return undefined;
  }
  const flow = getTaskFlowById(flowId);
  if (!flow) {
    return undefined;
  }
  if (normalizeOwnerKey(flow.ownerKey) !== normalizeOwnerKey(task.ownerKey)) {
    return undefined;
  }
  return flow;
}

function resolveTaskDeliveryOwner(task: TaskRecord): TaskDeliveryOwner {
  const flow = getLinkedFlowForDelivery(task);
  if (flow) {
    return {
      sessionKey: flow.ownerKey.trim(),
      requesterOrigin: normalizeDeliveryContext(
        flow.requesterOrigin ?? taskDeliveryStates.get(task.taskId)?.requesterOrigin,
      ),
      flowId: flow.flowId,
    };
  }
  if (task.scopeKind !== "session") {
    return {};
  }
  return {
    sessionKey: task.ownerKey.trim(),
    requesterOrigin: normalizeDeliveryContext(taskDeliveryStates.get(task.taskId)?.requesterOrigin),
  };
}

function syncManagedFlowCancellationFromTask(task: TaskRecord): void {
  const flowId = task.parentFlowId?.trim();
  if (!flowId) {
    return;
  }
  let flow = getTaskFlowById(flowId);
  if (
    !flow ||
    flow.syncMode !== "managed" ||
    flow.cancelRequestedAt == null ||
    isTerminalFlowStatus(flow.status)
  ) {
    return;
  }
  if (listTasksForFlowId(flowId).some((candidate) => isActiveTaskStatus(candidate.status))) {
    return;
  }
  const endedAt = task.endedAt ?? task.lastEventAt ?? Date.now();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = updateFlowRecordByIdExpectedRevision({
      flowId,
      expectedRevision: flow.revision,
      patch: {
        status: "cancelled",
        blockedTaskId: null,
        blockedSummary: null,
        waitJson: null,
        endedAt,
        updatedAt: endedAt,
      },
    });
    if (result.applied || result.reason === "not_found") {
      return;
    }
    flow = result.current;
    if (
      !flow ||
      flow.syncMode !== "managed" ||
      flow.cancelRequestedAt == null ||
      isTerminalFlowStatus(flow.status)
    ) {
      return;
    }
    if (listTasksForFlowId(flowId).some((candidate) => isActiveTaskStatus(candidate.status))) {
      return;
    }
  }
}

function restoreTaskRegistryOnce() {
  if (restoreAttempted) {
    return;
  }
  restoreAttempted = true;
  try {
    const restored = getTaskRegistryStore().loadSnapshot();
    if (restored.tasks.size === 0 && restored.deliveryStates.size === 0) {
      return;
    }
    for (const [taskId, task] of restored.tasks.entries()) {
      tasks.set(taskId, task);
    }
    for (const [taskId, state] of restored.deliveryStates.entries()) {
      taskDeliveryStates.set(taskId, state);
    }
    rebuildRunIdIndex();
    rebuildOwnerKeyIndex();
    rebuildParentFlowIdIndex();
    rebuildRelatedSessionKeyIndex();
    emitTaskRegistryObserverEvent(() => ({
      kind: "restored",
      tasks: snapshotTaskRecords(tasks),
    }));
  } catch (error) {
    log.warn("Failed to restore task registry", { error });
  }
}

export function ensureTaskRegistryReady() {
  restoreTaskRegistryOnce();
  ensureListener();
}

function updateTask(taskId: string, patch: Partial<TaskRecord>): TaskRecord | null {
  const current = tasks.get(taskId);
  if (!current) {
    return null;
  }
  const next = { ...current, ...patch };
  if (isTerminalTaskStatus(next.status) && typeof next.cleanupAfter !== "number") {
    const terminalAt = next.endedAt ?? next.lastEventAt ?? Date.now();
    next.cleanupAfter = terminalAt + DEFAULT_TASK_RETENTION_MS;
  }
  const sessionIndexChanged =
    normalizeSessionIndexKey(current.ownerKey) !== normalizeSessionIndexKey(next.ownerKey) ||
    normalizeSessionIndexKey(current.childSessionKey) !==
      normalizeSessionIndexKey(next.childSessionKey);
  const parentFlowIndexChanged = current.parentFlowId?.trim() !== next.parentFlowId?.trim();
  tasks.set(taskId, next);
  if (patch.runId && patch.runId !== current.runId) {
    rebuildRunIdIndex();
  }
  if (sessionIndexChanged) {
    deleteOwnerKeyIndex(taskId, current);
    addOwnerKeyIndex(taskId, next);
    deleteRelatedSessionKeyIndex(taskId, current);
    addRelatedSessionKeyIndex(taskId, next);
  }
  if (parentFlowIndexChanged) {
    deleteParentFlowIdIndex(taskId, current);
    addParentFlowIdIndex(taskId, next);
  }
  persistTaskUpsert(next);
  try {
    syncFlowFromTask(next);
  } catch (error) {
    log.warn("Failed to sync parent flow from task update", {
      taskId,
      flowId: next.parentFlowId,
      error,
    });
  }
  try {
    syncManagedFlowCancellationFromTask(next);
  } catch (error) {
    log.warn("Failed to finalize managed flow cancellation from task update", {
      taskId,
      flowId: next.parentFlowId,
      error,
    });
  }
  emitTaskRegistryObserverEvent(() => ({
    kind: "upserted",
    task: cloneTaskRecord(next),
    previous: cloneTaskRecord(current),
  }));
  return cloneTaskRecord(next);
}

function upsertTaskDeliveryState(state: TaskDeliveryState): TaskDeliveryState {
  const current = taskDeliveryStates.get(state.taskId);
  const next: TaskDeliveryState = {
    taskId: state.taskId,
    ...(state.requesterOrigin
      ? { requesterOrigin: normalizeDeliveryContext(state.requesterOrigin) }
      : {}),
    ...(state.lastNotifiedEventAt != null
      ? { lastNotifiedEventAt: state.lastNotifiedEventAt }
      : {}),
  };
  if (!next.requesterOrigin && typeof next.lastNotifiedEventAt !== "number" && !current) {
    return cloneTaskDeliveryState({ taskId: state.taskId });
  }
  taskDeliveryStates.set(state.taskId, next);
  persistTaskDeliveryStateUpsert(next);
  return cloneTaskDeliveryState(next);
}

function getTaskDeliveryState(taskId: string): TaskDeliveryState | undefined {
  const state = taskDeliveryStates.get(taskId);
  return state ? cloneTaskDeliveryState(state) : undefined;
}

function canDeliverTaskToRequesterOrigin(task: TaskRecord): boolean {
  const origin = resolveTaskDeliveryOwner(task).requesterOrigin;
  const channel = origin?.channel?.trim();
  const to = origin?.to?.trim();
  return Boolean(channel && to && isDeliverableMessageChannel(channel));
}

function resolveMissingOwnerDeliveryStatus(task: TaskRecord): TaskDeliveryStatus {
  return task.scopeKind === "system" ? "not_applicable" : "parent_missing";
}

function queueTaskSystemEvent(task: TaskRecord, text: string) {
  const owner = resolveTaskDeliveryOwner(task);
  const ownerKey = owner.sessionKey?.trim();
  if (!ownerKey) {
    return false;
  }
  enqueueSystemEvent(text, {
    sessionKey: ownerKey,
    contextKey: `task:${task.taskId}`,
    deliveryContext: owner.requesterOrigin,
  });
  requestHeartbeatNow({
    reason: "background-task",
    sessionKey: ownerKey,
  });
  return true;
}

function queueBlockedTaskFollowup(task: TaskRecord) {
  const followupText = formatTaskBlockedFollowupMessage(task);
  if (!followupText) {
    return false;
  }
  const owner = resolveTaskDeliveryOwner(task);
  const ownerKey = owner.sessionKey?.trim();
  if (!ownerKey) {
    return false;
  }
  enqueueSystemEvent(followupText, {
    sessionKey: ownerKey,
    contextKey: `task:${task.taskId}:blocked-followup`,
    deliveryContext: owner.requesterOrigin,
  });
  requestHeartbeatNow({
    reason: "background-task-blocked",
    sessionKey: ownerKey,
  });
  return true;
}

export async function maybeDeliverTaskTerminalUpdate(taskId: string): Promise<TaskRecord | null> {
  ensureTaskRegistryReady();
  const current = tasks.get(taskId);
  if (!current || !shouldAutoDeliverTaskTerminalUpdate(current)) {
    return current ? cloneTaskRecord(current) : null;
  }
  if (tasksWithPendingDelivery.has(taskId)) {
    return cloneTaskRecord(current);
  }
  tasksWithPendingDelivery.add(taskId);
  try {
    const latest = tasks.get(taskId);
    if (!latest || !shouldAutoDeliverTaskTerminalUpdate(latest)) {
      return latest ? cloneTaskRecord(latest) : null;
    }
    const preferred = latest.runId
      ? pickPreferredRunIdTask(getPeerTasksForDelivery(latest))
      : undefined;
    if (
      shouldSuppressDuplicateTerminalDelivery({ task: latest, preferredTaskId: preferred?.taskId })
    ) {
      return updateTask(taskId, {
        deliveryStatus: "not_applicable",
        lastEventAt: Date.now(),
      });
    }
    const owner = resolveTaskDeliveryOwner(latest);
    const ownerSessionKey = owner.sessionKey?.trim();
    if (!ownerSessionKey) {
      return updateTask(taskId, {
        deliveryStatus: resolveMissingOwnerDeliveryStatus(latest),
        lastEventAt: Date.now(),
      });
    }
    const eventText = formatTaskTerminalMessage(latest);
    if (!canDeliverTaskToRequesterOrigin(latest)) {
      try {
        queueTaskSystemEvent(latest, eventText);
        if (latest.terminalOutcome === "blocked") {
          queueBlockedTaskFollowup(latest);
        }
        return updateTask(taskId, {
          deliveryStatus: "session_queued",
          lastEventAt: Date.now(),
        });
      } catch (error) {
        log.warn("Failed to queue background task session delivery", {
          taskId,
          ownerKey: latest.ownerKey,
          error,
        });
        return updateTask(taskId, {
          deliveryStatus: "failed",
          lastEventAt: Date.now(),
        });
      }
    }
    try {
      const { sendMessage } = await loadTaskRegistryDeliveryRuntime();
      const requesterAgentId = parseAgentSessionKey(ownerSessionKey)?.agentId;
      const idempotencyKey = resolveTaskTerminalIdempotencyKey(latest);
      await sendMessage({
        channel: owner.requesterOrigin?.channel,
        to: owner.requesterOrigin?.to ?? "",
        accountId: owner.requesterOrigin?.accountId,
        threadId: owner.requesterOrigin?.threadId,
        content: eventText,
        agentId: requesterAgentId,
        idempotencyKey,
        mirror: {
          sessionKey: ownerSessionKey,
          agentId: requesterAgentId,
          idempotencyKey,
        },
      });
      if (latest.terminalOutcome === "blocked") {
        queueBlockedTaskFollowup(latest);
      }
      return updateTask(taskId, {
        deliveryStatus: "delivered",
        lastEventAt: Date.now(),
      });
    } catch (error) {
      log.warn("Failed to deliver background task update", {
        taskId,
        ownerKey: ownerSessionKey,
        requesterOrigin: owner.requesterOrigin,
        error,
      });
      try {
        queueTaskSystemEvent(latest, eventText);
        if (latest.terminalOutcome === "blocked") {
          queueBlockedTaskFollowup(latest);
        }
      } catch (fallbackError) {
        log.warn("Failed to queue background task fallback event", {
          taskId,
          ownerKey: latest.ownerKey,
          error: fallbackError,
        });
      }
      return updateTask(taskId, {
        deliveryStatus: "failed",
        lastEventAt: Date.now(),
      });
    }
  } finally {
    tasksWithPendingDelivery.delete(taskId);
  }
}

export async function maybeDeliverTaskStateChangeUpdate(
  taskId: string,
  latestEvent?: TaskEventRecord,
): Promise<TaskRecord | null> {
  ensureTaskRegistryReady();
  const current = tasks.get(taskId);
  if (!current || !shouldAutoDeliverTaskStateChange(current)) {
    return current ? cloneTaskRecord(current) : null;
  }
  const deliveryState = getTaskDeliveryState(taskId);
  if (!latestEvent || (deliveryState?.lastNotifiedEventAt ?? 0) >= latestEvent.at) {
    return cloneTaskRecord(current);
  }
  const eventText = formatTaskStateChangeMessage(current, latestEvent);
  if (!eventText) {
    return cloneTaskRecord(current);
  }
  try {
    const owner = resolveTaskDeliveryOwner(current);
    const ownerSessionKey = owner.sessionKey?.trim();
    if (!ownerSessionKey) {
      return updateTask(taskId, {
        deliveryStatus: resolveMissingOwnerDeliveryStatus(current),
        lastEventAt: Date.now(),
      });
    }
    if (!canDeliverTaskToRequesterOrigin(current)) {
      queueTaskSystemEvent(current, eventText);
      upsertTaskDeliveryState({
        taskId,
        requesterOrigin: deliveryState?.requesterOrigin,
        lastNotifiedEventAt: latestEvent.at,
      });
      return updateTask(taskId, {
        lastEventAt: Date.now(),
      });
    }
    const { sendMessage } = await loadTaskRegistryDeliveryRuntime();
    const requesterAgentId = parseAgentSessionKey(ownerSessionKey)?.agentId;
    const idempotencyKey = resolveTaskStateChangeIdempotencyKey({
      task: current,
      latestEvent,
      owner,
    });
    await sendMessage({
      channel: owner.requesterOrigin?.channel,
      to: owner.requesterOrigin?.to ?? "",
      accountId: owner.requesterOrigin?.accountId,
      threadId: owner.requesterOrigin?.threadId,
      content: eventText,
      agentId: requesterAgentId,
      idempotencyKey,
      mirror: {
        sessionKey: ownerSessionKey,
        agentId: requesterAgentId,
        idempotencyKey,
      },
    });
    upsertTaskDeliveryState({
      taskId,
      requesterOrigin: deliveryState?.requesterOrigin,
      lastNotifiedEventAt: latestEvent.at,
    });
    return updateTask(taskId, {
      lastEventAt: Date.now(),
    });
  } catch (error) {
    log.warn("Failed to deliver background task state change", {
      taskId,
      ownerKey: current.ownerKey,
      error,
    });
    return cloneTaskRecord(current);
  }
}

export function setTaskProgressById(params: {
  taskId: string;
  progressSummary?: string | null;
  lastEventAt?: number;
}): TaskRecord | null {
  ensureTaskRegistryReady();
  const patch: Partial<TaskRecord> = {};
  if (params.progressSummary !== undefined) {
    patch.progressSummary = normalizeTaskSummary(params.progressSummary);
  }
  if (params.lastEventAt != null) {
    patch.lastEventAt = params.lastEventAt;
  }
  return updateTask(params.taskId, patch);
}

export function setTaskTimingById(params: {
  taskId: string;
  startedAt?: number;
  endedAt?: number;
  lastEventAt?: number;
}): TaskRecord | null {
  ensureTaskRegistryReady();
  const patch: Partial<TaskRecord> = {};
  if (params.startedAt != null) {
    patch.startedAt = params.startedAt;
  }
  if (params.endedAt != null) {
    patch.endedAt = params.endedAt;
  }
  if (params.lastEventAt != null) {
    patch.lastEventAt = params.lastEventAt;
  }
  return updateTask(params.taskId, patch);
}

export function setTaskCleanupAfterById(params: {
  taskId: string;
  cleanupAfter: number;
}): TaskRecord | null {
  ensureTaskRegistryReady();
  return updateTask(params.taskId, {
    cleanupAfter: params.cleanupAfter,
  });
}

export function markTaskTerminalById(params: {
  taskId: string;
  status: Extract<TaskStatus, "succeeded" | "failed" | "timed_out" | "cancelled">;
  endedAt: number;
  lastEventAt?: number;
  error?: string;
  terminalSummary?: string | null;
  terminalOutcome?: TaskTerminalOutcome | null;
}): TaskRecord | null {
  ensureTaskRegistryReady();
  return updateTask(params.taskId, {
    status: params.status,
    endedAt: params.endedAt,
    lastEventAt: params.lastEventAt ?? params.endedAt,
    ...(params.error !== undefined ? { error: params.error } : {}),
    ...(params.terminalSummary !== undefined
      ? { terminalSummary: normalizeTaskSummary(params.terminalSummary) }
      : {}),
    ...(params.terminalOutcome !== undefined
      ? {
          terminalOutcome: resolveTaskTerminalOutcome({
            status: params.status,
            terminalOutcome: params.terminalOutcome,
          }),
        }
      : {}),
  });
}

export function markTaskLostById(params: {
  taskId: string;
  endedAt: number;
  lastEventAt?: number;
  error?: string;
  cleanupAfter?: number;
}): TaskRecord | null {
  ensureTaskRegistryReady();
  return updateTask(params.taskId, {
    status: "lost",
    endedAt: params.endedAt,
    lastEventAt: params.lastEventAt ?? params.endedAt,
    ...(params.error !== undefined ? { error: params.error } : {}),
    ...(params.cleanupAfter !== undefined ? { cleanupAfter: params.cleanupAfter } : {}),
  });
}

function updateTasksByRunId(params: {
  runId: string;
  patch: Partial<TaskRecord>;
  runtime?: TaskRuntime;
  sessionKey?: string;
}): TaskRecord[] {
  const matches = getTasksByRunScope(params);
  if (matches.length === 0) {
    return [];
  }
  const updated: TaskRecord[] = [];
  for (const match of matches) {
    const task = updateTask(match.taskId, params.patch);
    if (task) {
      updated.push(task);
    }
  }
  return updated;
}

function ensureListener() {
  if (listenerStarted) {
    return;
  }
  listenerStarted = true;
  listenerStop = onAgentEvent((evt) => {
    restoreTaskRegistryOnce();
    const scopedTasks = getTasksByRunScope({
      runId: evt.runId,
      sessionKey: evt.sessionKey,
    });
    if (scopedTasks.length === 0) {
      return;
    }
    const now = evt.ts || Date.now();
    for (const current of scopedTasks) {
      const patch: Partial<TaskRecord> = {
        lastEventAt: now,
      };
      if (evt.stream === "lifecycle") {
        const phase = typeof evt.data?.phase === "string" ? evt.data.phase : undefined;
        const startedAt =
          typeof evt.data?.startedAt === "number" ? evt.data.startedAt : current.startedAt;
        const endedAt = typeof evt.data?.endedAt === "number" ? evt.data.endedAt : undefined;
        if (startedAt) {
          patch.startedAt = startedAt;
        }
        if (phase === "start") {
          patch.status = "running";
        } else if (phase === "end") {
          patch.status = evt.data?.aborted === true ? "timed_out" : "succeeded";
          patch.endedAt = endedAt ?? now;
        } else if (phase === "error") {
          patch.status = "failed";
          patch.endedAt = endedAt ?? now;
          patch.error = typeof evt.data?.error === "string" ? evt.data.error : current.error;
        }
      } else if (evt.stream === "error") {
        patch.error = typeof evt.data?.error === "string" ? evt.data.error : current.error;
      }
      const stateChangeEvent =
        patch.status && patch.status !== current.status
          ? appendTaskEvent({
              at: now,
              kind: patch.status,
              summary:
                patch.status === "failed"
                  ? (patch.error ?? current.error)
                  : patch.status === "succeeded"
                    ? current.terminalSummary
                    : undefined,
            })
          : undefined;
      const updated = updateTask(current.taskId, patch);
      if (updated) {
        void maybeDeliverTaskStateChangeUpdate(current.taskId, stateChangeEvent);
        void maybeDeliverTaskTerminalUpdate(current.taskId);
      }
    }
  });
}

export function createTaskRecord(params: {
  runtime: TaskRuntime;
  sourceId?: string;
  requesterSessionKey?: string;
  ownerKey?: string;
  scopeKind?: TaskScopeKind;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  childSessionKey?: string;
  parentFlowId?: string;
  parentTaskId?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  task: string;
  preferMetadata?: boolean;
  status?: TaskStatus;
  deliveryStatus?: TaskDeliveryStatus;
  notifyPolicy?: TaskNotifyPolicy;
  startedAt?: number;
  lastEventAt?: number;
  cleanupAfter?: number;
  progressSummary?: string | null;
  terminalSummary?: string | null;
  terminalOutcome?: TaskTerminalOutcome | null;
}): TaskRecord {
  ensureTaskRegistryReady();
  const requesterSessionKey = resolveTaskRequesterSessionKey(params);
  const scopeKind = resolveTaskScopeKind({
    scopeKind: params.scopeKind,
    requesterSessionKey,
  });
  const ownerKey = resolveTaskOwnerKey({
    requesterSessionKey,
    ownerKey: params.ownerKey,
  });
  assertTaskOwner({
    ownerKey,
    scopeKind,
  });
  assertParentFlowLinkAllowed({
    ownerKey,
    scopeKind,
    parentFlowId: params.parentFlowId,
  });
  const existing = findExistingTaskForCreate({
    runtime: params.runtime,
    ownerKey,
    scopeKind,
    childSessionKey: params.childSessionKey,
    parentFlowId: params.parentFlowId,
    runId: params.runId,
    label: params.label,
    task: params.task,
  });
  if (existing) {
    return mergeExistingTaskForCreate(existing, params);
  }
  const now = Date.now();
  const taskId = crypto.randomUUID();
  const status = normalizeTaskStatus(params.status);
  const deliveryStatus =
    params.deliveryStatus ??
    ensureDeliveryStatus({
      ownerKey,
      scopeKind,
    });
  const notifyPolicy = ensureNotifyPolicy({
    notifyPolicy: params.notifyPolicy,
    deliveryStatus,
    ownerKey,
    scopeKind,
  });
  const lastEventAt = params.lastEventAt ?? params.startedAt ?? now;
  const record: TaskRecord = {
    taskId,
    runtime: params.runtime,
    sourceId: params.sourceId?.trim() || undefined,
    requesterSessionKey,
    ownerKey,
    scopeKind,
    childSessionKey: params.childSessionKey,
    parentFlowId: params.parentFlowId?.trim() || undefined,
    parentTaskId: params.parentTaskId?.trim() || undefined,
    agentId: params.agentId?.trim() || undefined,
    runId: params.runId?.trim() || undefined,
    label: params.label?.trim() || undefined,
    task: params.task,
    status,
    deliveryStatus,
    notifyPolicy,
    createdAt: now,
    startedAt: params.startedAt,
    lastEventAt,
    cleanupAfter: params.cleanupAfter,
    progressSummary: normalizeTaskSummary(params.progressSummary),
    terminalSummary: normalizeTaskSummary(params.terminalSummary),
    terminalOutcome: resolveTaskTerminalOutcome({
      status,
      terminalOutcome: params.terminalOutcome,
    }),
  };
  if (isTerminalTaskStatus(record.status) && typeof record.cleanupAfter !== "number") {
    record.cleanupAfter =
      (record.endedAt ?? record.lastEventAt ?? record.createdAt) + DEFAULT_TASK_RETENTION_MS;
  }
  tasks.set(taskId, record);
  upsertTaskDeliveryState({
    taskId,
    requesterOrigin: normalizeDeliveryContext(params.requesterOrigin),
  });
  addRunIdIndex(taskId, record.runId);
  addOwnerKeyIndex(taskId, record);
  addParentFlowIdIndex(taskId, record);
  addRelatedSessionKeyIndex(taskId, record);
  persistTaskUpsert(record);
  try {
    syncFlowFromTask(record);
  } catch (error) {
    log.warn("Failed to sync parent flow from task create", {
      taskId: record.taskId,
      flowId: record.parentFlowId,
      error,
    });
  }
  emitTaskRegistryObserverEvent(() => ({
    kind: "upserted",
    task: cloneTaskRecord(record),
  }));
  if (isTerminalTaskStatus(record.status)) {
    void maybeDeliverTaskTerminalUpdate(taskId);
  }
  return cloneTaskRecord(record);
}

function updateTaskStateByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  status?: TaskStatus;
  startedAt?: number;
  endedAt?: number;
  lastEventAt?: number;
  error?: string;
  progressSummary?: string | null;
  terminalSummary?: string | null;
  terminalOutcome?: TaskTerminalOutcome | null;
  eventSummary?: string | null;
}) {
  ensureTaskRegistryReady();
  const matches = getTasksByRunScope(params);
  if (matches.length === 0) {
    return [];
  }
  const updated: TaskRecord[] = [];
  for (const current of matches) {
    const patch: Partial<TaskRecord> = {};
    const nextStatus = params.status ? normalizeTaskStatus(params.status) : current.status;
    const eventAt = params.lastEventAt ?? params.endedAt ?? Date.now();
    if (params.status) {
      patch.status = normalizeTaskStatus(params.status);
    }
    if (params.startedAt != null) {
      patch.startedAt = params.startedAt;
    }
    if (params.endedAt != null) {
      patch.endedAt = params.endedAt;
    }
    if (params.lastEventAt != null) {
      patch.lastEventAt = params.lastEventAt;
    }
    if (params.error !== undefined) {
      patch.error = params.error;
    }
    if (params.progressSummary !== undefined) {
      patch.progressSummary = normalizeTaskSummary(params.progressSummary);
    }
    if (params.terminalSummary !== undefined) {
      patch.terminalSummary = normalizeTaskSummary(params.terminalSummary);
    }
    if (params.terminalOutcome !== undefined) {
      patch.terminalOutcome = resolveTaskTerminalOutcome({
        status: nextStatus,
        terminalOutcome: params.terminalOutcome,
      });
    }
    const eventSummary =
      normalizeTaskSummary(params.eventSummary) ??
      (nextStatus === "failed"
        ? normalizeTaskSummary(params.error ?? current.error)
        : nextStatus === "succeeded"
          ? normalizeTaskSummary(params.terminalSummary ?? current.terminalSummary)
          : undefined);
    const shouldAppendEvent =
      (params.status && params.status !== current.status) ||
      Boolean(normalizeTaskSummary(params.eventSummary));
    const nextEvent = shouldAppendEvent
      ? appendTaskEvent({
          at: eventAt,
          kind:
            params.status && normalizeTaskStatus(params.status) !== current.status
              ? normalizeTaskStatus(params.status)
              : "progress",
          summary: eventSummary,
        })
      : undefined;
    const task = updateTask(current.taskId, patch);
    if (task) {
      updated.push(task);
      void maybeDeliverTaskStateChangeUpdate(task.taskId, nextEvent);
      void maybeDeliverTaskTerminalUpdate(task.taskId);
    }
  }
  return updated;
}

function updateTaskDeliveryByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  deliveryStatus: TaskDeliveryStatus;
}) {
  ensureTaskRegistryReady();
  return updateTasksByRunId({
    runId: params.runId,
    runtime: params.runtime,
    sessionKey: params.sessionKey,
    patch: {
      deliveryStatus: params.deliveryStatus,
    },
  });
}

export function markTaskRunningByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  startedAt?: number;
  lastEventAt?: number;
  progressSummary?: string | null;
  eventSummary?: string | null;
}) {
  return updateTaskStateByRunId({
    runId: params.runId,
    runtime: params.runtime,
    sessionKey: params.sessionKey,
    status: "running",
    startedAt: params.startedAt,
    lastEventAt: params.lastEventAt,
    progressSummary: params.progressSummary,
    eventSummary: params.eventSummary,
  });
}

export function recordTaskProgressByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  lastEventAt?: number;
  progressSummary?: string | null;
  eventSummary?: string | null;
}) {
  return updateTaskStateByRunId({
    runId: params.runId,
    runtime: params.runtime,
    sessionKey: params.sessionKey,
    lastEventAt: params.lastEventAt,
    progressSummary: params.progressSummary,
    eventSummary: params.eventSummary,
  });
}

export function markTaskTerminalByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  status: Extract<TaskStatus, "succeeded" | "failed" | "timed_out" | "cancelled">;
  startedAt?: number;
  endedAt: number;
  lastEventAt?: number;
  error?: string;
  progressSummary?: string | null;
  terminalSummary?: string | null;
  terminalOutcome?: TaskTerminalOutcome | null;
}) {
  return updateTaskStateByRunId({
    runId: params.runId,
    runtime: params.runtime,
    sessionKey: params.sessionKey,
    status: params.status,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
    lastEventAt: params.lastEventAt,
    error: params.error,
    progressSummary: params.progressSummary,
    terminalSummary: params.terminalSummary,
    terminalOutcome: params.terminalOutcome,
  });
}

export function setTaskRunDeliveryStatusByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  deliveryStatus: TaskDeliveryStatus;
}) {
  return updateTaskDeliveryByRunId(params);
}

export function updateTaskNotifyPolicyById(params: {
  taskId: string;
  notifyPolicy: TaskNotifyPolicy;
}): TaskRecord | null {
  ensureTaskRegistryReady();
  return updateTask(params.taskId, {
    notifyPolicy: params.notifyPolicy,
    lastEventAt: Date.now(),
  });
}

export function linkTaskToFlowById(params: { taskId: string; flowId: string }): TaskRecord | null {
  ensureTaskRegistryReady();
  const flowId = params.flowId.trim();
  if (!flowId) {
    return null;
  }
  const current = tasks.get(params.taskId);
  if (!current) {
    return null;
  }
  if (current.parentFlowId?.trim()) {
    return cloneTaskRecord(current);
  }
  assertParentFlowLinkAllowed({
    ownerKey: current.ownerKey,
    scopeKind: current.scopeKind,
    parentFlowId: flowId,
  });
  return updateTask(params.taskId, {
    parentFlowId: flowId,
  });
}

export async function cancelTaskById(params: {
  cfg: OpenClawConfig;
  taskId: string;
}): Promise<{ found: boolean; cancelled: boolean; reason?: string; task?: TaskRecord }> {
  ensureTaskRegistryReady();
  const task = tasks.get(params.taskId.trim());
  if (!task) {
    return { found: false, cancelled: false, reason: "Task not found." };
  }
  if (
    task.status === "succeeded" ||
    task.status === "failed" ||
    task.status === "timed_out" ||
    task.status === "lost" ||
    task.status === "cancelled"
  ) {
    return {
      found: true,
      cancelled: false,
      reason: "Task is already terminal.",
      task: cloneTaskRecord(task),
    };
  }
  const childSessionKey = task.childSessionKey?.trim();
  if (!childSessionKey) {
    return {
      found: true,
      cancelled: false,
      reason: "Task has no cancellable child session.",
      task: cloneTaskRecord(task),
    };
  }
  try {
    if (task.runtime === "acp") {
      await getAcpSessionManager().cancelSession({
        cfg: params.cfg,
        sessionKey: childSessionKey,
        reason: "task-cancel",
      });
    } else if (task.runtime === "subagent") {
      const result = await killSubagentRunAdmin({
        cfg: params.cfg,
        sessionKey: childSessionKey,
      });
      if (!result.found || !result.killed) {
        return {
          found: true,
          cancelled: false,
          reason: result.found ? "Subagent was not running." : "Subagent task not found.",
          task: cloneTaskRecord(task),
        };
      }
    } else {
      return {
        found: true,
        cancelled: false,
        reason: "Task runtime does not support cancellation yet.",
        task: cloneTaskRecord(task),
      };
    }
    const updated = updateTask(task.taskId, {
      status: "cancelled",
      endedAt: Date.now(),
      lastEventAt: Date.now(),
      error: "Cancelled by operator.",
    });
    if (updated) {
      void maybeDeliverTaskTerminalUpdate(updated.taskId);
    }
    return {
      found: true,
      cancelled: true,
      task: updated ?? cloneTaskRecord(task),
    };
  } catch (error) {
    return {
      found: true,
      cancelled: false,
      reason: error instanceof Error ? error.message : String(error),
      task: cloneTaskRecord(task),
    };
  }
}

export function listTaskRecords(): TaskRecord[] {
  ensureTaskRegistryReady();
  return [...tasks.values()]
    .map((task, insertionIndex) => ({ ...cloneTaskRecord(task), insertionIndex }))
    .toSorted(compareTasksNewestFirst)
    .map(({ insertionIndex: _, ...task }) => task);
}

export function getTaskRegistrySummary(): TaskRegistrySummary {
  ensureTaskRegistryReady();
  return summarizeTaskRecords(tasks.values());
}

export function getTaskRegistrySnapshot(): TaskRegistrySnapshot {
  return {
    tasks: listTaskRecords(),
    deliveryStates: [...taskDeliveryStates.values()].map((state) => cloneTaskDeliveryState(state)),
  };
}

export function getTaskById(taskId: string): TaskRecord | undefined {
  ensureTaskRegistryReady();
  const task = tasks.get(taskId.trim());
  return task ? cloneTaskRecord(task) : undefined;
}

export function findTaskByRunId(runId: string): TaskRecord | undefined {
  ensureTaskRegistryReady();
  const task = pickPreferredRunIdTask(getTasksByRunId(runId));
  return task ? cloneTaskRecord(task) : undefined;
}

function listTasksFromIndex(index: Map<string, Set<string>>, key: string): TaskRecord[] {
  const ids = index.get(key);
  if (!ids || ids.size === 0) {
    return [];
  }
  return [...ids]
    .map((taskId, insertionIndex) => {
      const task = tasks.get(taskId);
      return task ? { ...cloneTaskRecord(task), insertionIndex } : null;
    })
    .filter(
      (
        task,
      ): task is TaskRecord & {
        insertionIndex: number;
      } => Boolean(task),
    )
    .toSorted(compareTasksNewestFirst)
    .map(({ insertionIndex: _, ...task }) => task);
}

export function findLatestTaskForSessionKey(sessionKey: string): TaskRecord | undefined {
  const task = listTasksForSessionKey(sessionKey)[0];
  return task ? cloneTaskRecord(task) : undefined;
}

export function listTasksForSessionKey(sessionKey: string): TaskRecord[] {
  ensureTaskRegistryReady();
  const key = normalizeSessionIndexKey(sessionKey);
  if (!key) {
    return [];
  }
  return listTasksFromIndex(taskIdsByRelatedSessionKey, key);
}

export function listTasksForAgentId(agentId: string): TaskRecord[] {
  ensureTaskRegistryReady();
  const lookup = agentId.trim();
  if (!lookup) {
    return [];
  }
  return snapshotTaskRecords(tasks)
    .filter((task) => task.agentId?.trim() === lookup)
    .toSorted(compareTasksNewestFirst);
}

export function findLatestTaskForOwnerKey(ownerKey: string): TaskRecord | undefined {
  const task = listTasksForOwnerKey(ownerKey)[0];
  return task ? cloneTaskRecord(task) : undefined;
}

export function findLatestTaskForFlowId(flowId: string): TaskRecord | undefined {
  const task = listTasksForFlowId(flowId)[0];
  return task ? cloneTaskRecord(task) : undefined;
}

export function listTasksForOwnerKey(ownerKey: string): TaskRecord[] {
  ensureTaskRegistryReady();
  const key = normalizeSessionIndexKey(ownerKey);
  if (!key) {
    return [];
  }
  return listTasksFromIndex(taskIdsByOwnerKey, key);
}

export function listTasksForFlowId(flowId: string): TaskRecord[] {
  ensureTaskRegistryReady();
  const key = flowId.trim();
  if (!key) {
    return [];
  }
  return listTasksFromIndex(taskIdsByParentFlowId, key);
}

export function findLatestTaskForRelatedSessionKey(sessionKey: string): TaskRecord | undefined {
  const task = listTasksForRelatedSessionKey(sessionKey)[0];
  return task ? cloneTaskRecord(task) : undefined;
}

export function listTasksForRelatedSessionKey(sessionKey: string): TaskRecord[] {
  ensureTaskRegistryReady();
  const key = normalizeSessionIndexKey(sessionKey);
  if (!key) {
    return [];
  }
  return listTasksFromIndex(taskIdsByRelatedSessionKey, key);
}

export function resolveTaskForLookupToken(token: string): TaskRecord | undefined {
  const lookup = token.trim();
  if (!lookup) {
    return undefined;
  }
  return (
    getTaskById(lookup) ?? findTaskByRunId(lookup) ?? findLatestTaskForRelatedSessionKey(lookup)
  );
}

export function deleteTaskRecordById(taskId: string): boolean {
  ensureTaskRegistryReady();
  const current = tasks.get(taskId);
  if (!current) {
    return false;
  }
  deleteOwnerKeyIndex(taskId, current);
  deleteParentFlowIdIndex(taskId, current);
  deleteRelatedSessionKeyIndex(taskId, current);
  tasks.delete(taskId);
  taskDeliveryStates.delete(taskId);
  rebuildRunIdIndex();
  persistTaskDelete(taskId);
  persistTaskDeliveryStateDelete(taskId);
  emitTaskRegistryObserverEvent(() => ({
    kind: "deleted",
    taskId: current.taskId,
    previous: cloneTaskRecord(current),
  }));
  return true;
}

export function resetTaskRegistryForTests(opts?: { persist?: boolean }) {
  tasks.clear();
  taskDeliveryStates.clear();
  taskIdsByRunId.clear();
  taskIdsByOwnerKey.clear();
  taskIdsByParentFlowId.clear();
  taskIdsByRelatedSessionKey.clear();
  tasksWithPendingDelivery.clear();
  restoreAttempted = false;
  resetTaskRegistryRuntimeForTests();
  if (listenerStop) {
    listenerStop();
    listenerStop = null;
  }
  listenerStarted = false;
  if (opts?.persist !== false) {
    persistTaskRegistry();
  }
  // Always close the sqlite handle so Windows temp-dir cleanup can remove the
  // state directory even when a test intentionally skips persisting the reset.
  getTaskRegistryStore().close?.();
}

export function resetTaskRegistryDeliveryRuntimeForTests() {
  deliveryRuntimePromise = null;
}
