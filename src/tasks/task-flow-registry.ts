import crypto from "node:crypto";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { isDeliverableMessageChannel } from "../utils/message-channel.js";
import { getTaskFlowGuidance } from "./task-flow-guidance.js";
import {
  getTaskFlowRegistryObservers,
  getTaskFlowRegistryStore,
  resetTaskFlowRegistryRuntimeForTests,
  type TaskFlowRegistryObserverEvent,
} from "./task-flow-registry.store.js";
import type {
  TaskFlowRecord,
  TaskFlowStatus,
  TaskFlowSyncMode,
  JsonValue,
} from "./task-flow-registry.types.js";
import type { TaskNotifyPolicy, TaskRecord } from "./task-registry.types.js";
import { formatTaskStatusTitleText, sanitizeTaskStatusText } from "./task-status.js";

const log = createSubsystemLogger("tasks/task-flow-registry");
const flows = new Map<string, TaskFlowRecord>();
let restoreAttempted = false;
let restoreFailureMessage: string | null = null;
type TaskFlowDeliveryRuntime = Pick<
  typeof import("./task-registry-delivery-runtime.js"),
  "sendMessage"
>;
const TASK_FLOW_DELIVERY_RUNTIME_OVERRIDE_KEY = Symbol.for(
  "openclaw.taskFlow.deliveryRuntimeOverride",
);
type TaskFlowGlobalWithDeliveryOverride = typeof globalThis & {
  [TASK_FLOW_DELIVERY_RUNTIME_OVERRIDE_KEY]?: TaskFlowDeliveryRuntime | null;
};
let deliveryRuntimePromise: Promise<typeof import("./task-registry-delivery-runtime.js")> | null =
  null;
const MANAGED_FLOW_PROGRESS_DEBOUNCE_MS = 1_500;
type PendingManagedFlowNotification = {
  flow: TaskFlowRecord;
  previous?: TaskFlowRecord;
  suppressedUpdates: number;
  timer: ReturnType<typeof setTimeout>;
};
const pendingManagedFlowNotifications = new Map<string, PendingManagedFlowNotification>();

type FlowRecordPatch = Omit<
  Partial<
    Pick<
      TaskFlowRecord,
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

export type TaskFlowUpdateResult =
  | {
      applied: true;
      flow: TaskFlowRecord;
    }
  | {
      applied: false;
      reason: "not_found" | "revision_conflict";
      current?: TaskFlowRecord;
    };

function cloneStructuredValue<T>(value: T | undefined): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  return structuredClone(value);
}

function cloneFlowRecord(record: TaskFlowRecord): TaskFlowRecord {
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

function isTerminalFlowStatus(status: TaskFlowStatus): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost"
  );
}

async function loadTaskFlowDeliveryRuntime(): Promise<TaskFlowDeliveryRuntime> {
  const override = (globalThis as TaskFlowGlobalWithDeliveryOverride)[
    TASK_FLOW_DELIVERY_RUNTIME_OVERRIDE_KEY
  ];
  if (override) {
    return override;
  }
  deliveryRuntimePromise ??= import("./task-registry-delivery-runtime.js");
  return await deliveryRuntimePromise;
}

function canDeliverFlowToRequesterOrigin(flow: TaskFlowRecord): boolean {
  const channel = flow.requesterOrigin?.channel?.trim();
  const to = flow.requesterOrigin?.to?.trim();
  return Boolean(channel && to && isDeliverableMessageChannel(channel));
}

function resolveFlowTitle(flow: TaskFlowRecord): string {
  return formatTaskStatusTitleText(flow.goal, "Background task");
}

function resolveFlowSummary(flow: TaskFlowRecord, opts?: { errorContext?: boolean }): string {
  return sanitizeTaskStatusText(flow.blockedSummary, {
    errorContext: opts?.errorContext ?? false,
  });
}

function appendFlowGuidance(summary: string, flow: TaskFlowRecord): string {
  const guidance = getTaskFlowGuidance(flow);
  if (!guidance || summary.includes(guidance.summary)) {
    return summary;
  }
  if (!summary) {
    return guidance.summary;
  }
  const separator = /[.!?]$/.test(summary) ? " " : ". ";
  return `${summary}${separator}${guidance.summary}`;
}

function isJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isManagedChildTaskFlow(flow: Pick<TaskFlowRecord, "syncMode" | "waitJson" | "stateJson">) {
  if (flow.syncMode !== "managed") {
    return false;
  }
  if (isJsonObject(flow.waitJson) && flow.waitJson.kind === "child_task") {
    return true;
  }
  return isJsonObject(flow.stateJson) && flow.stateJson.completion != null;
}

function clearPendingManagedFlowNotification(flowId: string): void {
  const pending = pendingManagedFlowNotifications.get(flowId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingManagedFlowNotifications.delete(flowId);
}

function queueFlowSystemEvent(flow: TaskFlowRecord, text: string): boolean {
  const ownerKey = flow.ownerKey?.trim();
  if (!ownerKey) {
    return false;
  }
  enqueueSystemEvent(text, {
    sessionKey: ownerKey,
    contextKey: `task-flow:${flow.flowId}:rev:${flow.revision}`,
    deliveryContext: flow.requesterOrigin,
  });
  requestHeartbeatNow({
    reason: "background-task-flow",
    sessionKey: ownerKey,
  });
  return true;
}

function formatManagedFlowStatusMessage(params: {
  flow: TaskFlowRecord;
  previous?: TaskFlowRecord;
  suppressedUpdates?: number;
}): string | null {
  const { flow, previous } = params;
  if (flow.syncMode !== "managed" || flow.notifyPolicy === "silent") {
    return null;
  }

  const title = resolveFlowTitle(flow);
  const suppressedUpdates = Math.max(0, params.suppressedUpdates ?? 0);
  const summary = appendFlowGuidance(
    resolveFlowSummary(flow, {
      errorContext: flow.status === "failed" || flow.status === "lost" || flow.status === "blocked",
    }),
    flow,
  );
  const aggregateSuffix =
    suppressedUpdates > 0
      ? `${suppressedUpdates} intermediate update${suppressedUpdates === 1 ? " was" : "s were"} folded in.`
      : "";
  const withAggregateSuffix = (message: string) =>
    aggregateSuffix ? `${message} ${aggregateSuffix}` : message;
  const firstWaitingTransition =
    flow.status === "waiting" &&
    (!previous ||
      (previous.revision === 0 && (previous.status === "queued" || previous.status === "running")));

  if (firstWaitingTransition) {
    return `Background task started: ${title}. Waiting on child task.`;
  }

  if (flow.status === "waiting") {
    if (flow.notifyPolicy !== "state_changes") {
      return null;
    }
    return withAggregateSuffix(
      summary
        ? `Background task update: ${title}. Waiting on child task. ${summary}`
        : `Background task update: ${title}. Waiting on child task.`,
    );
  }

  if (flow.status === "running" || flow.status === "queued") {
    if (flow.notifyPolicy !== "state_changes" || !previous || previous.status === flow.status) {
      return null;
    }
    return withAggregateSuffix(
      summary
        ? `Background task update: ${title}. Work resumed. ${summary}`
        : `Background task update: ${title}. Work resumed.`,
    );
  }

  if (flow.status === "blocked") {
    if (
      previous &&
      previous.status === "blocked" &&
      previous.blockedSummary === flow.blockedSummary
    ) {
      return null;
    }
    return summary
      ? `Background task blocked: ${title}. ${summary}`
      : `Background task blocked: ${title}. Needs user action before retrying.`;
  }

  if (!isTerminalFlowStatus(flow.status)) {
    return null;
  }
  if (previous && previous.status === flow.status && isTerminalFlowStatus(previous.status)) {
    return null;
  }

  if (flow.status === "succeeded") {
    return summary
      ? `Background task done: ${title}. ${summary}`
      : `Background task done: ${title}.`;
  }
  if (flow.status === "cancelled") {
    return summary
      ? `Background task cancelled: ${title}. ${summary}`
      : `Background task cancelled: ${title}.`;
  }
  if (flow.status === "lost") {
    return summary
      ? `Background task lost: ${title}. ${summary}`
      : `Background task lost: ${title}. Backing child task disappeared.`;
  }
  return summary
    ? `Background task failed: ${title}. ${summary}`
    : `Background task failed: ${title}.`;
}

function sendManagedFlowUpdate(
  next: TaskFlowRecord,
  previous?: TaskFlowRecord,
  suppressedUpdates = 0,
): void {
  const content = formatManagedFlowStatusMessage({
    flow: next,
    previous,
    suppressedUpdates,
  });
  if (!content) {
    return;
  }
  void (async () => {
    if (!canDeliverFlowToRequesterOrigin(next)) {
      try {
        queueFlowSystemEvent(next, content);
      } catch (error) {
        log.warn("Failed to queue managed flow session delivery", {
          flowId: next.flowId,
          ownerKey: next.ownerKey,
          error,
        });
      }
      return;
    }

    try {
      const { sendMessage } = await loadTaskFlowDeliveryRuntime();
      const requesterAgentId = parseAgentSessionKey(next.ownerKey)?.agentId;
      const idempotencyKey = `task-flow:${next.flowId}:rev:${next.revision}`;
      await sendMessage({
        channel: next.requesterOrigin?.channel,
        to: next.requesterOrigin?.to ?? "",
        accountId: next.requesterOrigin?.accountId,
        threadId: next.requesterOrigin?.threadId,
        content,
        agentId: requesterAgentId,
        idempotencyKey,
        mirror: {
          sessionKey: next.ownerKey,
          agentId: requesterAgentId,
          idempotencyKey,
        },
      });
    } catch (error) {
      log.warn("Failed to deliver managed flow update", {
        flowId: next.flowId,
        ownerKey: next.ownerKey,
        requesterOrigin: next.requesterOrigin,
        error,
      });
      try {
        queueFlowSystemEvent(next, content);
      } catch (fallbackError) {
        log.warn("Failed to queue managed flow fallback event", {
          flowId: next.flowId,
          ownerKey: next.ownerKey,
          error: fallbackError,
        });
      }
    }
  })();
}

function shouldDebounceManagedFlowUpdate(next: TaskFlowRecord, previous?: TaskFlowRecord): boolean {
  if (next.notifyPolicy !== "state_changes") {
    return false;
  }
  if (!isManagedChildTaskFlow(next) && !(previous && isManagedChildTaskFlow(previous))) {
    return false;
  }
  if (next.status === "waiting") {
    const firstWaitingTransition =
      !previous ||
      (previous.revision === 0 && (previous.status === "queued" || previous.status === "running"));
    return !firstWaitingTransition;
  }
  return next.status === "queued" || next.status === "running";
}

function notifyManagedFlowUpdate(next: TaskFlowRecord, previous?: TaskFlowRecord): void {
  if (!formatManagedFlowStatusMessage({ flow: next, previous })) {
    return;
  }
  if (shouldDebounceManagedFlowUpdate(next, previous)) {
    const pending = pendingManagedFlowNotifications.get(next.flowId);
    if (pending) {
      clearTimeout(pending.timer);
    }
    const suppressedUpdates = pending ? pending.suppressedUpdates + 1 : 0;
    const timer = setTimeout(() => {
      const current = pendingManagedFlowNotifications.get(next.flowId);
      if (!current) {
        return;
      }
      pendingManagedFlowNotifications.delete(next.flowId);
      sendManagedFlowUpdate(current.flow, current.previous, current.suppressedUpdates);
    }, MANAGED_FLOW_PROGRESS_DEBOUNCE_MS);
    pendingManagedFlowNotifications.set(next.flowId, {
      flow: next,
      previous: pending?.previous ?? previous,
      suppressedUpdates,
      timer,
    });
    return;
  }
  clearPendingManagedFlowNotification(next.flowId);
  sendManagedFlowUpdate(next, previous);
}

function normalizeRestoredFlowRecord(record: TaskFlowRecord): TaskFlowRecord {
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

function snapshotFlowRecords(source: ReadonlyMap<string, TaskFlowRecord>): TaskFlowRecord[] {
  return [...source.values()].map((record) => cloneFlowRecord(record));
}

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

export function deriveTaskFlowStatusFromTask(
  task: Pick<TaskRecord, "status" | "terminalOutcome">,
): TaskFlowStatus {
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
  try {
    const restored = getTaskFlowRegistryStore().loadSnapshot();
    flows.clear();
    for (const [flowId, flow] of restored.flows) {
      flows.set(flowId, normalizeRestoredFlowRecord(flow));
    }
    restoreFailureMessage = null;
  } catch (error) {
    flows.clear();
    restoreFailureMessage = error instanceof Error ? error.message : String(error);
    log.warn("Failed to restore task-flow registry", { error });
    return;
  }
  emitFlowRegistryObserverEvent(() => ({
    kind: "restored",
    flows: snapshotFlowRecords(flows),
  }));
}

export function getTaskFlowRegistryRestoreFailure(): string | null {
  ensureFlowRegistryReady();
  return restoreFailureMessage;
}

function persistFlowRegistry() {
  getTaskFlowRegistryStore().saveSnapshot({
    flows: new Map(snapshotFlowRecords(flows).map((flow) => [flow.flowId, flow])),
  });
}

function persistFlowUpsert(flow: TaskFlowRecord) {
  const store = getTaskFlowRegistryStore();
  if (store.upsertFlow) {
    store.upsertFlow(cloneFlowRecord(flow));
    return;
  }
  persistFlowRegistry();
}

function persistFlowDelete(flowId: string) {
  const store = getTaskFlowRegistryStore();
  if (store.deleteFlow) {
    store.deleteFlow(flowId);
    return;
  }
  persistFlowRegistry();
}

function buildFlowRecord(params: {
  syncMode?: TaskFlowSyncMode;
  ownerKey: string;
  requesterOrigin?: TaskFlowRecord["requesterOrigin"];
  controllerId?: string | null;
  revision?: number;
  status?: TaskFlowStatus;
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
}): TaskFlowRecord {
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

function applyFlowPatch(current: TaskFlowRecord, patch: FlowRecordPatch): TaskFlowRecord {
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

function writeFlowRecord(next: TaskFlowRecord, previous?: TaskFlowRecord): TaskFlowRecord {
  flows.set(next.flowId, next);
  persistFlowUpsert(next);
  emitFlowRegistryObserverEvent(() => ({
    kind: "upserted",
    flow: cloneFlowRecord(next),
    ...(previous ? { previous: cloneFlowRecord(previous) } : {}),
  }));
  notifyManagedFlowUpdate(next, previous);
  return cloneFlowRecord(next);
}

export function createFlowRecord(params: {
  syncMode?: TaskFlowSyncMode;
  ownerKey: string;
  requesterOrigin?: TaskFlowRecord["requesterOrigin"];
  controllerId?: string | null;
  revision?: number;
  status?: TaskFlowStatus;
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
}): TaskFlowRecord {
  ensureFlowRegistryReady();
  const record = buildFlowRecord(params);
  return writeFlowRecord(record);
}

export function createManagedTaskFlow(params: {
  ownerKey: string;
  controllerId: string;
  requesterOrigin?: TaskFlowRecord["requesterOrigin"];
  status?: TaskFlowStatus;
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
}): TaskFlowRecord {
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
}): TaskFlowRecord {
  const terminalFlowStatus = deriveTaskFlowStatusFromTask(params.task);
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

function updateFlowRecordByIdUnchecked(
  flowId: string,
  patch: FlowRecordPatch,
): TaskFlowRecord | null {
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
}): TaskFlowUpdateResult {
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
}): TaskFlowUpdateResult {
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
): TaskFlowRecord | null {
  const flowId = task.parentFlowId?.trim();
  if (!flowId) {
    return null;
  }
  const flow = getTaskFlowById(flowId);
  if (!flow) {
    return null;
  }
  if (flow.syncMode !== "task_mirrored") {
    return flow;
  }
  const terminalFlowStatus = deriveTaskFlowStatusFromTask(task);
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

export function getTaskFlowById(flowId: string): TaskFlowRecord | undefined {
  ensureFlowRegistryReady();
  const flow = flows.get(flowId);
  return flow ? cloneFlowRecord(flow) : undefined;
}

export function listTaskFlowsForOwnerKey(ownerKey: string): TaskFlowRecord[] {
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

export function findLatestTaskFlowForOwnerKey(ownerKey: string): TaskFlowRecord | undefined {
  const flow = listTaskFlowsForOwnerKey(ownerKey)[0];
  return flow ? cloneFlowRecord(flow) : undefined;
}

export function resolveTaskFlowForLookupToken(token: string): TaskFlowRecord | undefined {
  const lookup = token.trim();
  if (!lookup) {
    return undefined;
  }
  return getTaskFlowById(lookup) ?? findLatestTaskFlowForOwnerKey(lookup);
}

export function listTaskFlowRecords(): TaskFlowRecord[] {
  ensureFlowRegistryReady();
  return [...flows.values()]
    .map((flow) => cloneFlowRecord(flow))
    .toSorted((left, right) => right.createdAt - left.createdAt);
}

export function deleteTaskFlowRecordById(flowId: string): boolean {
  ensureFlowRegistryReady();
  const current = flows.get(flowId);
  if (!current) {
    return false;
  }
  clearPendingManagedFlowNotification(flowId);
  flows.delete(flowId);
  persistFlowDelete(flowId);
  emitFlowRegistryObserverEvent(() => ({
    kind: "deleted",
    flowId,
    previous: cloneFlowRecord(current),
  }));
  return true;
}

export function resetTaskFlowRegistryForTests(opts?: { persist?: boolean }) {
  for (const flowId of pendingManagedFlowNotifications.keys()) {
    clearPendingManagedFlowNotification(flowId);
  }
  flows.clear();
  restoreAttempted = false;
  restoreFailureMessage = null;
  deliveryRuntimePromise = null;
  (globalThis as TaskFlowGlobalWithDeliveryOverride)[TASK_FLOW_DELIVERY_RUNTIME_OVERRIDE_KEY] =
    null;
  resetTaskFlowRegistryRuntimeForTests();
  if (opts?.persist !== false) {
    persistFlowRegistry();
  }
  getTaskFlowRegistryStore().close?.();
}

export function setTaskFlowDeliveryRuntimeForTests(runtime: TaskFlowDeliveryRuntime | null): void {
  (globalThis as TaskFlowGlobalWithDeliveryOverride)[TASK_FLOW_DELIVERY_RUNTIME_OVERRIDE_KEY] =
    runtime;
  deliveryRuntimePromise = null;
}
