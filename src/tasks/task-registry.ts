import crypto from "node:crypto";
import { onAgentEvent } from "../infra/agent-events.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { isDeliverableMessageChannel } from "../utils/message-channel.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import { loadTaskRegistryFromDisk, saveTaskRegistryToDisk } from "./task-registry.store.js";
import type {
  TaskBindingTargetKind,
  TaskDeliveryStatus,
  TaskRecord,
  TaskRegistrySnapshot,
  TaskRuntime,
  TaskSource,
  TaskStatus,
} from "./task-registry.types.js";

const log = createSubsystemLogger("tasks/registry");

const tasks = new Map<string, TaskRecord>();
const taskIdsByRunId = new Map<string, Set<string>>();
let listenerStarted = false;
let listenerStop: (() => void) | null = null;
var restoreAttempted = false;
let deliveryRuntimePromise: Promise<typeof import("./task-registry-delivery-runtime.js")> | null =
  null;

function cloneTaskRecord(record: TaskRecord): TaskRecord {
  return {
    ...record,
    ...(record.requesterOrigin ? { requesterOrigin: { ...record.requesterOrigin } } : {}),
  };
}

function persistTaskRegistry() {
  saveTaskRegistryToDisk(tasks);
}

function ensureDeliveryStatus(requesterSessionKey: string): TaskDeliveryStatus {
  return requesterSessionKey.trim() ? "pending" : "parent_missing";
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
  const sourcePriority =
    task.source === "sessions_spawn" ? 0 : task.source === "background_cli" ? 1 : 2;
  const runtimePriority = task.runtime === "cli" ? 1 : 0;
  return sourcePriority * 10 + runtimePriority;
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
  source: TaskSource;
  runtime: TaskRuntime;
  requesterSessionKey: string;
  childSessionKey?: string;
  runId?: string;
  bindingTargetKind?: TaskBindingTargetKind;
  label?: string;
  task: string;
}): TaskRecord | undefined {
  const runId = params.runId?.trim();
  if (!runId) {
    return undefined;
  }
  return getTasksByRunId(runId).find(
    (task) =>
      task.source === params.source &&
      task.runtime === params.runtime &&
      normalizeComparableText(task.requesterSessionKey) ===
        normalizeComparableText(params.requesterSessionKey) &&
      normalizeComparableText(task.childSessionKey) ===
        normalizeComparableText(params.childSessionKey) &&
      normalizeComparableText(task.bindingTargetKind) ===
        normalizeComparableText(params.bindingTargetKind) &&
      normalizeComparableText(task.label) === normalizeComparableText(params.label) &&
      normalizeComparableText(task.task) === normalizeComparableText(params.task),
  );
}

function restoreTaskRegistryOnce() {
  if (restoreAttempted) {
    return;
  }
  restoreAttempted = true;
  try {
    const restored = loadTaskRegistryFromDisk();
    if (restored.size === 0) {
      return;
    }
    for (const [taskId, task] of restored.entries()) {
      tasks.set(taskId, task);
    }
    rebuildRunIdIndex();
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
  tasks.set(taskId, next);
  if (patch.runId && patch.runId !== current.runId) {
    rebuildRunIdIndex();
  }
  persistTaskRegistry();
  return cloneTaskRecord(next);
}

function formatTaskTerminalEvent(task: TaskRecord): string {
  const title = task.label?.trim() || task.task.trim() || "Background task";
  const runLabel = task.runId ? ` (run ${task.runId.slice(0, 8)})` : "";
  if (task.status === "done") {
    const summary = task.resultPreview?.trim();
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

function shouldAutoDeliverTaskUpdate(task: TaskRecord): boolean {
  if (task.runtime === "subagent") {
    return false;
  }
  if (
    task.status !== "done" &&
    task.status !== "failed" &&
    task.status !== "timed_out" &&
    task.status !== "lost"
  ) {
    return false;
  }
  return task.deliveryStatus === "pending";
}

export async function maybeDeliverTaskTerminalUpdate(taskId: string): Promise<TaskRecord | null> {
  ensureTaskRegistryReady();
  const current = tasks.get(taskId);
  if (!current || !shouldAutoDeliverTaskUpdate(current)) {
    return current ? cloneTaskRecord(current) : null;
  }
  if (!current.requesterSessionKey.trim()) {
    return updateTask(taskId, {
      deliveryStatus: "parent_missing",
      lastEventAt: Date.now(),
    });
  }
  const eventText = formatTaskTerminalEvent(current);
  if (!canDeliverTaskToRequesterOrigin(current)) {
    try {
      queueTaskSystemEvent(current, eventText);
      return updateTask(taskId, {
        deliveryStatus: "delivered",
        lastEventAt: Date.now(),
      });
    } catch (error) {
      log.warn("Failed to queue background task session delivery", {
        taskId,
        requesterSessionKey: current.requesterSessionKey,
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
    const origin = normalizeDeliveryContext(current.requesterOrigin);
    const requesterAgentId = parseAgentSessionKey(current.requesterSessionKey)?.agentId;
    await sendMessage({
      channel: origin?.channel,
      to: origin?.to ?? "",
      accountId: origin?.accountId,
      threadId: origin?.threadId,
      content: eventText,
      agentId: requesterAgentId,
      mirror: {
        sessionKey: current.requesterSessionKey,
        agentId: requesterAgentId,
      },
    });
    return updateTask(taskId, {
      deliveryStatus: "delivered",
      lastEventAt: Date.now(),
    });
  } catch (error) {
    log.warn("Failed to deliver background task update", {
      taskId,
      requesterSessionKey: current.requesterSessionKey,
      requesterOrigin: current.requesterOrigin,
      error,
    });
    try {
      queueTaskSystemEvent(current, eventText);
    } catch (fallbackError) {
      log.warn("Failed to queue background task fallback event", {
        taskId,
        requesterSessionKey: current.requesterSessionKey,
        error: fallbackError,
      });
    }
    return updateTask(taskId, {
      deliveryStatus: "failed",
      lastEventAt: Date.now(),
    });
  }
}

export function updateTaskRecordById(
  taskId: string,
  patch: Partial<TaskRecord>,
): TaskRecord | null {
  ensureTaskRegistryReady();
  return updateTask(taskId, patch);
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
          patch.status = evt.data?.aborted === true ? "timed_out" : "done";
          patch.endedAt = endedAt ?? now;
        } else if (phase === "error") {
          patch.status = "failed";
          patch.endedAt = endedAt ?? now;
          patch.error = typeof evt.data?.error === "string" ? evt.data.error : current.error;
        }
      } else if (evt.stream === "error") {
        patch.error = typeof evt.data?.error === "string" ? evt.data.error : current.error;
      }
      const updated = updateTask(taskId, patch);
      if (updated) {
        void maybeDeliverTaskTerminalUpdate(taskId);
      }
    }
  });
}

export function createTaskRecord(params: {
  source: TaskSource;
  runtime: TaskRuntime;
  requesterSessionKey: string;
  requesterOrigin?: TaskRecord["requesterOrigin"];
  childSessionKey?: string;
  runId?: string;
  bindingTargetKind?: TaskBindingTargetKind;
  label?: string;
  task: string;
  status?: TaskStatus;
  deliveryStatus?: TaskDeliveryStatus;
  startedAt?: number;
  lastEventAt?: number;
  transcriptPath?: string;
  streamLogPath?: string;
  backend?: string;
  agentSessionId?: string;
  backendSessionId?: string;
}): TaskRecord {
  ensureTaskRegistryReady();
  const existing = findExistingTaskForCreate(params);
  if (existing) {
    return existing;
  }
  const now = Date.now();
  const taskId = crypto.randomUUID();
  const record: TaskRecord = {
    taskId,
    source: params.source,
    runtime: params.runtime,
    requesterSessionKey: params.requesterSessionKey,
    requesterOrigin: normalizeDeliveryContext(params.requesterOrigin),
    childSessionKey: params.childSessionKey,
    runId: params.runId?.trim() || undefined,
    bindingTargetKind: params.bindingTargetKind,
    label: params.label?.trim() || undefined,
    task: params.task,
    status: params.status ?? "accepted",
    deliveryStatus: params.deliveryStatus ?? ensureDeliveryStatus(params.requesterSessionKey),
    createdAt: now,
    startedAt: params.startedAt,
    lastEventAt: params.lastEventAt ?? params.startedAt ?? now,
    transcriptPath: params.transcriptPath,
    streamLogPath: params.streamLogPath,
    backend: params.backend,
    agentSessionId: params.agentSessionId,
    backendSessionId: params.backendSessionId,
  };
  tasks.set(taskId, record);
  addRunIdIndex(taskId, record.runId);
  persistTaskRegistry();
  return cloneTaskRecord(record);
}

export function updateTaskStateByRunId(params: {
  runId: string;
  status?: TaskStatus;
  startedAt?: number;
  endedAt?: number;
  lastEventAt?: number;
  error?: string;
  resultPreview?: string | null;
}) {
  ensureTaskRegistryReady();
  const patch: Partial<TaskRecord> = {};
  if (params.status) {
    patch.status = params.status;
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
  if (params.resultPreview !== undefined) {
    patch.resultPreview = params.resultPreview ?? undefined;
  }
  const updated = updateTasksByRunId(params.runId, patch);
  for (const task of updated) {
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

export function listTaskRecords(): TaskRecord[] {
  ensureTaskRegistryReady();
  return [...tasks.values()]
    .map((task) => cloneTaskRecord(task))
    .toSorted((a, b) => b.createdAt - a.createdAt);
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
  persistTaskRegistry();
  return true;
}

export function resetTaskRegistryForTests(opts?: { persist?: boolean }) {
  tasks.clear();
  taskIdsByRunId.clear();
  restoreAttempted = false;
  if (listenerStop) {
    listenerStop();
    listenerStop = null;
  }
  listenerStarted = false;
  if (opts?.persist !== false) {
    persistTaskRegistry();
  }
}
