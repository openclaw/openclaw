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
  getTaskRegistryHooks,
  getTaskRegistryStore,
  resetTaskRegistryRuntimeForTests,
  type TaskRegistryHookEvent,
} from "./task-registry.store.js";
import { summarizeTaskRecords } from "./task-registry.summary.js";
import type {
  TaskDeliveryStatus,
  TaskEventKind,
  TaskEventRecord,
  TaskNotifyPolicy,
  TaskRecord,
  TaskRegistrySummary,
  TaskRegistrySnapshot,
  TaskRuntime,
  TaskStatus,
  TaskTerminalOutcome,
} from "./task-registry.types.js";

const log = createSubsystemLogger("tasks/registry");
const DEFAULT_TASK_RETENTION_MS = 7 * 24 * 60 * 60_000;

const tasks = new Map<string, TaskRecord>();
const taskIdsByRunId = new Map<string, Set<string>>();
const tasksWithPendingDelivery = new Set<string>();
let listenerStarted = false;
let listenerStop: (() => void) | null = null;
let restoreAttempted = false;
let deliveryRuntimePromise: Promise<typeof import("./task-registry-delivery-runtime.js")> | null =
  null;

function cloneTaskRecord(record: TaskRecord): TaskRecord {
  return {
    ...record,
    ...(record.requesterOrigin ? { requesterOrigin: { ...record.requesterOrigin } } : {}),
    ...(record.recentEvents
      ? { recentEvents: record.recentEvents.map((event) => ({ ...event })) }
      : {}),
  };
}

function snapshotTaskRecords(source: ReadonlyMap<string, TaskRecord>): TaskRecord[] {
  return [...source.values()].map((record) => cloneTaskRecord(record));
}

function emitTaskRegistryHookEvent(createEvent: () => TaskRegistryHookEvent): void {
  const hooks = getTaskRegistryHooks();
  if (!hooks?.onEvent) {
    return;
  }
  try {
    hooks.onEvent(createEvent());
  } catch (error) {
    log.warn("Task registry hook failed", {
      event: "task-registry",
      error,
    });
  }
}

function persistTaskRegistry() {
  getTaskRegistryStore().saveSnapshot(tasks);
}

function persistTaskUpsert(task: TaskRecord) {
  const store = getTaskRegistryStore();
  if (store.upsertTask) {
    store.upsertTask(task);
    return;
  }
  store.saveSnapshot(tasks);
}

function persistTaskDelete(taskId: string) {
  const store = getTaskRegistryStore();
  if (store.deleteTask) {
    store.deleteTask(taskId);
    return;
  }
  store.saveSnapshot(tasks);
}

function ensureDeliveryStatus(requesterSessionKey: string): TaskDeliveryStatus {
  return requesterSessionKey.trim() ? "pending" : "parent_missing";
}

function ensureNotifyPolicy(params: {
  notifyPolicy?: TaskNotifyPolicy;
  deliveryStatus?: TaskDeliveryStatus;
  requesterSessionKey: string;
}): TaskNotifyPolicy {
  if (params.notifyPolicy) {
    return params.notifyPolicy;
  }
  const deliveryStatus = params.deliveryStatus ?? ensureDeliveryStatus(params.requesterSessionKey);
  return deliveryStatus === "not_applicable" ? "silent" : "done_only";
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

const TASK_RECENT_EVENT_LIMIT = 12;

function appendTaskEvent(
  current: TaskRecord,
  event: {
    at: number;
    kind: TaskEventKind;
    summary?: string | null;
  },
): TaskEventRecord[] {
  const summary = normalizeTaskSummary(event.summary);
  const nextEvent: TaskEventRecord = {
    at: event.at,
    kind: event.kind,
    ...(summary ? { summary } : {}),
  };
  const previous = current.recentEvents ?? [];
  const merged = [...previous, nextEvent];
  return merged.slice(-TASK_RECENT_EVENT_LIMIT);
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

function rebuildRunIdIndex() {
  taskIdsByRunId.clear();
  for (const [taskId, task] of tasks.entries()) {
    addRunIdIndex(taskId, task.runId);
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

function findExistingTaskForCreate(params: {
  runtime: TaskRuntime;
  requesterSessionKey: string;
  childSessionKey?: string;
  runId?: string;
  label?: string;
  task: string;
}): TaskRecord | undefined {
  const runId = params.runId?.trim();
  const exact = runId
    ? getTasksByRunId(runId).find(
        (task) =>
          task.runtime === params.runtime &&
          normalizeComparableText(task.requesterSessionKey) ===
            normalizeComparableText(params.requesterSessionKey) &&
          normalizeComparableText(task.childSessionKey) ===
            normalizeComparableText(params.childSessionKey) &&
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
  const siblingMatches = getTasksByRunId(runId).filter(
    (task) =>
      task.runtime === params.runtime &&
      normalizeComparableText(task.requesterSessionKey) ===
        normalizeComparableText(params.requesterSessionKey) &&
      normalizeComparableText(task.childSessionKey) ===
        normalizeComparableText(params.childSessionKey),
  );
  if (siblingMatches.length === 0) {
    return undefined;
  }
  return pickPreferredRunIdTask(siblingMatches);
}

function mergeExistingTaskForCreate(
  existing: TaskRecord,
  params: {
    requesterOrigin?: TaskRecord["requesterOrigin"];
    sourceId?: string;
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
  if (requesterOrigin && !existing.requesterOrigin) {
    patch.requesterOrigin = requesterOrigin;
  }
  if (params.sourceId?.trim() && !existing.sourceId?.trim()) {
    patch.sourceId = params.sourceId.trim();
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
    requesterSessionKey: existing.requesterSessionKey,
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

function restoreTaskRegistryOnce() {
  if (restoreAttempted) {
    return;
  }
  restoreAttempted = true;
  try {
    const restored = getTaskRegistryStore().loadSnapshot();
    if (restored.size === 0) {
      return;
    }
    for (const [taskId, task] of restored.entries()) {
      tasks.set(taskId, task);
    }
    rebuildRunIdIndex();
    emitTaskRegistryHookEvent(() => ({
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

function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "timed_out" ||
    status === "cancelled" ||
    status === "lost"
  );
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
  tasks.set(taskId, next);
  if (patch.runId && patch.runId !== current.runId) {
    rebuildRunIdIndex();
  }
  persistTaskUpsert(next);
  emitTaskRegistryHookEvent(() => ({
    kind: "upserted",
    task: cloneTaskRecord(next),
    previous: cloneTaskRecord(current),
  }));
  return cloneTaskRecord(next);
}

function formatTaskTerminalEvent(task: TaskRecord): string {
  // User-facing task notifications stay intentionally terse. Detailed runtime chatter lives
  // in task metadata for inspection, not in the default channel ping.
  const title =
    task.label?.trim() ||
    (task.runtime === "acp"
      ? "ACP background task"
      : task.runtime === "subagent"
        ? "Subagent task"
        : task.task.trim() || "Background task");
  const runLabel = task.runId ? ` (run ${task.runId.slice(0, 8)})` : "";
  const summary = task.terminalSummary?.trim();
  if (task.status === "succeeded") {
    if (task.terminalOutcome === "blocked") {
      return summary
        ? `Background task blocked: ${title}${runLabel}. ${summary}`
        : `Background task blocked: ${title}${runLabel}.`;
    }
    return summary
      ? `Background task done: ${title}${runLabel}. ${summary}`
      : `Background task done: ${title}${runLabel}.`;
  }
  if (task.status === "timed_out") {
    return `Background task timed out: ${title}${runLabel}.`;
  }
  if (task.status === "lost") {
    return `Background task lost: ${title}${runLabel}. ${task.error ?? "Backing session disappeared."}`;
  }
  if (task.status === "cancelled") {
    return `Background task cancelled: ${title}${runLabel}.`;
  }
  const error = task.error?.trim();
  return error
    ? `Background task failed: ${title}${runLabel}. ${error}`
    : `Background task failed: ${title}${runLabel}.`;
}

function canDeliverTaskToRequesterOrigin(task: TaskRecord): boolean {
  const origin = normalizeDeliveryContext(task.requesterOrigin);
  const channel = origin?.channel?.trim();
  const to = origin?.to?.trim();
  return Boolean(channel && to && isDeliverableMessageChannel(channel));
}

function queueTaskSystemEvent(task: TaskRecord, text: string) {
  const requesterSessionKey = task.requesterSessionKey.trim();
  if (!requesterSessionKey) {
    return false;
  }
  enqueueSystemEvent(text, {
    sessionKey: requesterSessionKey,
    contextKey: `task:${task.taskId}`,
    deliveryContext: task.requesterOrigin,
  });
  requestHeartbeatNow({
    reason: "background-task",
    sessionKey: requesterSessionKey,
  });
  return true;
}

function queueBlockedTaskFollowup(task: TaskRecord) {
  if (task.status !== "succeeded" || task.terminalOutcome !== "blocked") {
    return false;
  }
  const requesterSessionKey = task.requesterSessionKey.trim();
  if (!requesterSessionKey) {
    return false;
  }
  const title =
    task.label?.trim() ||
    (task.runtime === "acp"
      ? "ACP background task"
      : task.runtime === "subagent"
        ? "Subagent task"
        : task.task.trim() || "Background task");
  const runLabel = task.runId ? ` (run ${task.runId.slice(0, 8)})` : "";
  const summary = task.terminalSummary?.trim() || "Task is blocked and needs follow-up.";
  enqueueSystemEvent(`Task needs follow-up: ${title}${runLabel}. ${summary}`, {
    sessionKey: requesterSessionKey,
    contextKey: `task:${task.taskId}:blocked-followup`,
    deliveryContext: task.requesterOrigin,
  });
  requestHeartbeatNow({
    reason: "background-task-blocked",
    sessionKey: requesterSessionKey,
  });
  return true;
}

function formatTaskStateChangeEvent(task: TaskRecord, event: TaskEventRecord): string | null {
  const title =
    task.label?.trim() ||
    (task.runtime === "acp"
      ? "ACP background task"
      : task.runtime === "subagent"
        ? "Subagent task"
        : task.task.trim() || "Background task");
  if (event.kind === "running") {
    return `Background task started: ${title}.`;
  }
  if (event.kind === "progress") {
    return event.summary ? `Background task update: ${title}. ${event.summary}` : null;
  }
  return null;
}

function shouldAutoDeliverTaskUpdate(task: TaskRecord): boolean {
  if (task.notifyPolicy === "silent") {
    return false;
  }
  if (task.runtime === "subagent" && task.status !== "cancelled") {
    return false;
  }
  if (
    task.status !== "succeeded" &&
    task.status !== "failed" &&
    task.status !== "timed_out" &&
    task.status !== "lost" &&
    task.status !== "cancelled"
  ) {
    return false;
  }
  return task.deliveryStatus === "pending";
}

function shouldAutoDeliverTaskStateChange(task: TaskRecord): boolean {
  return (
    task.notifyPolicy === "state_changes" &&
    task.deliveryStatus === "pending" &&
    task.status !== "succeeded" &&
    task.status !== "failed" &&
    task.status !== "timed_out" &&
    task.status !== "lost" &&
    task.status !== "cancelled"
  );
}

function shouldSuppressDuplicateTerminalDelivery(task: TaskRecord): boolean {
  if (task.runtime !== "acp" || !task.runId?.trim()) {
    return false;
  }
  const preferred = pickPreferredRunIdTask(getTasksByRunId(task.runId));
  return Boolean(preferred && preferred.taskId !== task.taskId);
}

export async function maybeDeliverTaskTerminalUpdate(taskId: string): Promise<TaskRecord | null> {
  ensureTaskRegistryReady();
  const current = tasks.get(taskId);
  if (!current || !shouldAutoDeliverTaskUpdate(current)) {
    return current ? cloneTaskRecord(current) : null;
  }
  if (tasksWithPendingDelivery.has(taskId)) {
    return cloneTaskRecord(current);
  }
  tasksWithPendingDelivery.add(taskId);
  try {
    const latest = tasks.get(taskId);
    if (!latest || !shouldAutoDeliverTaskUpdate(latest)) {
      return latest ? cloneTaskRecord(latest) : null;
    }
    if (shouldSuppressDuplicateTerminalDelivery(latest)) {
      return updateTask(taskId, {
        deliveryStatus: "not_applicable",
        lastEventAt: Date.now(),
      });
    }
    if (!latest.requesterSessionKey.trim()) {
      return updateTask(taskId, {
        deliveryStatus: "parent_missing",
        lastEventAt: Date.now(),
      });
    }
    const eventText = formatTaskTerminalEvent(latest);
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
          requesterSessionKey: latest.requesterSessionKey,
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
      const origin = normalizeDeliveryContext(latest.requesterOrigin);
      const requesterAgentId = parseAgentSessionKey(latest.requesterSessionKey)?.agentId;
      await sendMessage({
        channel: origin?.channel,
        to: origin?.to ?? "",
        accountId: origin?.accountId,
        threadId: origin?.threadId,
        content: eventText,
        agentId: requesterAgentId,
        idempotencyKey: taskTerminalDeliveryIdempotencyKey(latest),
        mirror: {
          sessionKey: latest.requesterSessionKey,
          agentId: requesterAgentId,
          idempotencyKey: taskTerminalDeliveryIdempotencyKey(latest),
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
        requesterSessionKey: latest.requesterSessionKey,
        requesterOrigin: latest.requesterOrigin,
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
          requesterSessionKey: latest.requesterSessionKey,
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
): Promise<TaskRecord | null> {
  ensureTaskRegistryReady();
  const current = tasks.get(taskId);
  if (!current || !shouldAutoDeliverTaskStateChange(current)) {
    return current ? cloneTaskRecord(current) : null;
  }
  const latestEvent = current.recentEvents?.at(-1);
  if (!latestEvent || (current.lastNotifiedEventAt ?? 0) >= latestEvent.at) {
    return cloneTaskRecord(current);
  }
  const eventText = formatTaskStateChangeEvent(current, latestEvent);
  if (!eventText) {
    return cloneTaskRecord(current);
  }
  try {
    if (!canDeliverTaskToRequesterOrigin(current)) {
      queueTaskSystemEvent(current, eventText);
      return updateTask(taskId, {
        lastNotifiedEventAt: latestEvent.at,
        lastEventAt: Date.now(),
      });
    }
    const { sendMessage } = await loadTaskRegistryDeliveryRuntime();
    const origin = normalizeDeliveryContext(current.requesterOrigin);
    const requesterAgentId = parseAgentSessionKey(current.requesterSessionKey)?.agentId;
    await sendMessage({
      channel: origin?.channel,
      to: origin?.to ?? "",
      accountId: origin?.accountId,
      threadId: origin?.threadId,
      content: eventText,
      agentId: requesterAgentId,
      idempotencyKey: `task-event:${current.taskId}:${latestEvent.at}:${latestEvent.kind}`,
      mirror: {
        sessionKey: current.requesterSessionKey,
        agentId: requesterAgentId,
        idempotencyKey: `task-event:${current.taskId}:${latestEvent.at}:${latestEvent.kind}`,
      },
    });
    return updateTask(taskId, {
      lastNotifiedEventAt: latestEvent.at,
      lastEventAt: Date.now(),
    });
  } catch (error) {
    log.warn("Failed to deliver background task state change", {
      taskId,
      requesterSessionKey: current.requesterSessionKey,
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

function updateTasksByRunId(runId: string, patch: Partial<TaskRecord>): TaskRecord[] {
  const ids = taskIdsByRunId.get(runId.trim());
  if (!ids || ids.size === 0) {
    return [];
  }
  const updated: TaskRecord[] = [];
  for (const taskId of ids) {
    const task = updateTask(taskId, patch);
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
    const ids = taskIdsByRunId.get(evt.runId);
    if (!ids || ids.size === 0) {
      return;
    }
    const now = evt.ts || Date.now();
    for (const taskId of ids) {
      const current = tasks.get(taskId);
      if (!current) {
        continue;
      }
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
      if (patch.status && patch.status !== current.status) {
        patch.recentEvents = appendTaskEvent(current, {
          at: now,
          kind: patch.status,
          summary:
            patch.status === "failed"
              ? (patch.error ?? current.error)
              : patch.status === "succeeded"
                ? current.terminalSummary
                : undefined,
        });
      }
      const updated = updateTask(taskId, patch);
      if (updated) {
        void maybeDeliverTaskStateChangeUpdate(taskId);
        void maybeDeliverTaskTerminalUpdate(taskId);
      }
    }
  });
}

export function createTaskRecord(params: {
  runtime: TaskRuntime;
  sourceId?: string;
  requesterSessionKey: string;
  requesterOrigin?: TaskRecord["requesterOrigin"];
  childSessionKey?: string;
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
  const existing = findExistingTaskForCreate(params);
  if (existing) {
    return mergeExistingTaskForCreate(existing, params);
  }
  const now = Date.now();
  const taskId = crypto.randomUUID();
  const status = normalizeTaskStatus(params.status);
  const deliveryStatus = params.deliveryStatus ?? ensureDeliveryStatus(params.requesterSessionKey);
  const notifyPolicy = ensureNotifyPolicy({
    notifyPolicy: params.notifyPolicy,
    deliveryStatus,
    requesterSessionKey: params.requesterSessionKey,
  });
  const lastEventAt = params.lastEventAt ?? params.startedAt ?? now;
  const record: TaskRecord = {
    taskId,
    runtime: params.runtime,
    sourceId: params.sourceId?.trim() || undefined,
    requesterSessionKey: params.requesterSessionKey,
    requesterOrigin: normalizeDeliveryContext(params.requesterOrigin),
    childSessionKey: params.childSessionKey,
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
    recentEvents: appendTaskEvent(
      {
        taskId,
        runtime: params.runtime,
        requesterSessionKey: params.requesterSessionKey,
        task: params.task,
        status,
        deliveryStatus,
        notifyPolicy,
        createdAt: now,
      } as TaskRecord,
      {
        at: lastEventAt,
        kind: status,
      },
    ),
  };
  if (isTerminalTaskStatus(record.status) && typeof record.cleanupAfter !== "number") {
    record.cleanupAfter =
      (record.endedAt ?? record.lastEventAt ?? record.createdAt) + DEFAULT_TASK_RETENTION_MS;
  }
  tasks.set(taskId, record);
  addRunIdIndex(taskId, record.runId);
  persistTaskUpsert(record);
  emitTaskRegistryHookEvent(() => ({
    kind: "upserted",
    task: cloneTaskRecord(record),
  }));
  if (isTerminalTaskStatus(record.status)) {
    void maybeDeliverTaskTerminalUpdate(taskId);
  }
  return cloneTaskRecord(record);
}

export function updateTaskStateByRunId(params: {
  runId: string;
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
  const ids = taskIdsByRunId.get(params.runId.trim());
  if (!ids || ids.size === 0) {
    return [];
  }
  const updated: TaskRecord[] = [];
  for (const taskId of ids) {
    const current = tasks.get(taskId);
    if (!current) {
      continue;
    }
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
    if (shouldAppendEvent) {
      patch.recentEvents = appendTaskEvent(current, {
        at: eventAt,
        kind:
          params.status && normalizeTaskStatus(params.status) !== current.status
            ? normalizeTaskStatus(params.status)
            : "progress",
        summary: eventSummary,
      });
    }
    const task = updateTask(taskId, patch);
    if (task) {
      updated.push(task);
    }
  }
  for (const task of updated) {
    void maybeDeliverTaskStateChangeUpdate(task.taskId);
    void maybeDeliverTaskTerminalUpdate(task.taskId);
  }
  return updated;
}

export function updateTaskDeliveryByRunId(params: {
  runId: string;
  deliveryStatus: TaskDeliveryStatus;
}) {
  ensureTaskRegistryReady();
  return updateTasksByRunId(params.runId, {
    deliveryStatus: params.deliveryStatus,
  });
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
      recentEvents: appendTaskEvent(task, {
        at: Date.now(),
        kind: "cancelled",
        summary: "Cancelled by operator.",
      }),
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
    .map((task) => cloneTaskRecord(task))
    .toSorted((a, b) => b.createdAt - a.createdAt);
}

export function getTaskRegistrySummary(): TaskRegistrySummary {
  ensureTaskRegistryReady();
  return summarizeTaskRecords(tasks.values());
}

export function getTaskRegistrySnapshot(): TaskRegistrySnapshot {
  return {
    tasks: listTaskRecords(),
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

export function findLatestTaskForSessionKey(sessionKey: string): TaskRecord | undefined {
  const key = sessionKey.trim();
  if (!key) {
    return undefined;
  }
  return listTaskRecords().find(
    (task) => task.childSessionKey === key || task.requesterSessionKey === key,
  );
}

export function resolveTaskForLookupToken(token: string): TaskRecord | undefined {
  const lookup = token.trim();
  if (!lookup) {
    return undefined;
  }
  return getTaskById(lookup) ?? findTaskByRunId(lookup) ?? findLatestTaskForSessionKey(lookup);
}

export function deleteTaskRecordById(taskId: string): boolean {
  ensureTaskRegistryReady();
  const current = tasks.get(taskId);
  if (!current) {
    return false;
  }
  tasks.delete(taskId);
  rebuildRunIdIndex();
  persistTaskDelete(taskId);
  emitTaskRegistryHookEvent(() => ({
    kind: "deleted",
    taskId: current.taskId,
    previous: cloneTaskRecord(current),
  }));
  return true;
}

export function resetTaskRegistryForTests(opts?: { persist?: boolean }) {
  tasks.clear();
  taskIdsByRunId.clear();
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
}
