import { readAcpSessionEntry } from "../acp/runtime/session-meta.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { deriveSessionChatType } from "../sessions/session-key-utils.js";
import {
  deleteTaskRecordById,
  ensureTaskRegistryReady,
  getTaskById,
  listTaskRecords,
  markTaskLostById,
  maybeDeliverTaskTerminalUpdate,
  resolveTaskForLookupToken,
  setTaskCleanupAfterById,
} from "./runtime-internal.js";
import { listTaskAuditFindings, summarizeTaskAuditFindings } from "./task-registry.audit.js";
import type { TaskAuditSummary } from "./task-registry.audit.js";
import { summarizeTaskRecords } from "./task-registry.summary.js";
import type { TaskRecord, TaskRegistrySummary } from "./task-registry.types.js";

const TASK_RECONCILE_GRACE_MS = 5 * 60_000;
const TASK_RETENTION_MS = 7 * 24 * 60 * 60_000;
const TASK_SWEEP_INTERVAL_MS = 60_000;

/**
 * Number of tasks to process before yielding to the event loop.
 * Keeps the main thread responsive during large sweeps.
 */
const SWEEP_YIELD_BATCH_SIZE = 25;

let sweeper: NodeJS.Timeout | null = null;
let deferredSweep: NodeJS.Timeout | null = null;
let sweepInProgress = false;

export type TaskRegistryMaintenanceSummary = {
  reconciled: number;
  cleanupStamped: number;
  pruned: number;
};

function findSessionEntryByKey(store: Record<string, unknown>, sessionKey: string): unknown {
  const direct = store[sessionKey];
  if (direct) {
    return direct;
  }
  const normalized = sessionKey.toLowerCase();
  for (const [key, entry] of Object.entries(store)) {
    if (key.toLowerCase() === normalized) {
      return entry;
    }
  }
  return undefined;
}

function isActiveTask(task: TaskRecord): boolean {
  return task.status === "queued" || task.status === "running";
}

function isTerminalTask(task: TaskRecord): boolean {
  return !isActiveTask(task);
}

function hasLostGraceExpired(task: TaskRecord, now: number): boolean {
  const referenceAt = task.lastEventAt ?? task.startedAt ?? task.createdAt;
  return now - referenceAt >= TASK_RECONCILE_GRACE_MS;
}

/**
 * Returns false if the task's runtime is cron, since cron tasks do not maintain
 * a persistent child session — once the cron job finishes, no backing session
 * exists and the task should be considered stale.
 *
 * For cli tasks, a matching session-store entry is only treated as live if the
 * session key is an agent-scoped key (not a long-lived channel/group/direct
 * session like a Slack or Telegram channel session whose entry persists
 * indefinitely regardless of whether any task work is still running).
 *
 * For subagent and acp tasks, the backing session entry is the canonical signal.
 */
function hasBackingSession(task: TaskRecord): boolean {
  // cron tasks never have a persistent backing session — the cron job fires,
  // does its work, and exits. Any childSessionKey is a transient run key, not
  // a long-lived session that indicates the task is still active.
  if (task.runtime === "cron") {
    return false;
  }

  const childSessionKey = task.childSessionKey?.trim();
  if (!childSessionKey) {
    // For runtimes other than cron, a missing key means we cannot verify
    // liveness; be conservative and assume the task may still be running.
    return true;
  }

  if (task.runtime === "acp") {
    const acpEntry = readAcpSessionEntry({
      sessionKey: childSessionKey,
    });
    if (!acpEntry || acpEntry.storeReadFailed) {
      return true;
    }
    return Boolean(acpEntry.entry);
  }

  if (task.runtime === "subagent") {
    const agentId = parseAgentSessionKey(childSessionKey)?.agentId;
    const storePath = resolveStorePath(undefined, { agentId });
    const store = loadSessionStore(storePath);
    return Boolean(findSessionEntryByKey(store, childSessionKey));
  }

  if (task.runtime === "cli") {
    // For CLI tasks, the childSessionKey may point to a long-lived channel
    // session (e.g. agent:main:slack:channel:xyz) whose entry persists in the
    // session store indefinitely — even after the actual task work has ended.
    // A channel/group/direct session existing in the store does NOT mean the
    // task is still alive, so we must exclude those from the "backed" check.
    const chatType = deriveSessionChatType(childSessionKey);
    if (chatType === "channel" || chatType === "group" || chatType === "direct") {
      return false;
    }
    const agentId = parseAgentSessionKey(childSessionKey)?.agentId;
    const storePath = resolveStorePath(undefined, { agentId });
    const store = loadSessionStore(storePath);
    return Boolean(findSessionEntryByKey(store, childSessionKey));
  }

  return true;
}

function shouldMarkLost(task: TaskRecord, now: number): boolean {
  if (!isActiveTask(task)) {
    return false;
  }
  if (!hasLostGraceExpired(task, now)) {
    return false;
  }
  return !hasBackingSession(task);
}

function shouldPruneTerminalTask(task: TaskRecord, now: number): boolean {
  if (!isTerminalTask(task)) {
    return false;
  }
  if (typeof task.cleanupAfter === "number") {
    return now >= task.cleanupAfter;
  }
  const terminalAt = task.endedAt ?? task.lastEventAt ?? task.createdAt;
  return now - terminalAt >= TASK_RETENTION_MS;
}

function shouldStampCleanupAfter(task: TaskRecord): boolean {
  return isTerminalTask(task) && typeof task.cleanupAfter !== "number";
}

function resolveCleanupAfter(task: TaskRecord): number {
  const terminalAt = task.endedAt ?? task.lastEventAt ?? task.createdAt;
  return terminalAt + TASK_RETENTION_MS;
}

function markTaskLost(task: TaskRecord, now: number): TaskRecord {
  const cleanupAfter = task.cleanupAfter ?? projectTaskLost(task, now).cleanupAfter;
  const updated =
    markTaskLostById({
      taskId: task.taskId,
      endedAt: task.endedAt ?? now,
      lastEventAt: now,
      error: task.error ?? "backing session missing",
      cleanupAfter,
    }) ?? task;
  void maybeDeliverTaskTerminalUpdate(updated.taskId);
  return updated;
}

function projectTaskLost(task: TaskRecord, now: number): TaskRecord {
  const projected: TaskRecord = {
    ...task,
    status: "lost",
    endedAt: task.endedAt ?? now,
    lastEventAt: now,
    error: task.error ?? "backing session missing",
  };
  return {
    ...projected,
    ...(typeof projected.cleanupAfter === "number"
      ? {}
      : { cleanupAfter: resolveCleanupAfter(projected) }),
  };
}

export function reconcileTaskRecordForOperatorInspection(task: TaskRecord): TaskRecord {
  const now = Date.now();
  if (!shouldMarkLost(task, now)) {
    return task;
  }
  return projectTaskLost(task, now);
}

export function reconcileInspectableTasks(): TaskRecord[] {
  ensureTaskRegistryReady();
  return listTaskRecords().map((task) => reconcileTaskRecordForOperatorInspection(task));
}

export function getInspectableTaskRegistrySummary(): TaskRegistrySummary {
  return summarizeTaskRecords(reconcileInspectableTasks());
}

export function getInspectableTaskAuditSummary(): TaskAuditSummary {
  const tasks = reconcileInspectableTasks();
  return summarizeTaskAuditFindings(listTaskAuditFindings({ tasks }));
}

export function reconcileTaskLookupToken(token: string): TaskRecord | undefined {
  ensureTaskRegistryReady();
  const task = resolveTaskForLookupToken(token);
  return task ? reconcileTaskRecordForOperatorInspection(task) : undefined;
}

export function previewTaskRegistryMaintenance(): TaskRegistryMaintenanceSummary {
  ensureTaskRegistryReady();
  const now = Date.now();
  let reconciled = 0;
  let cleanupStamped = 0;
  let pruned = 0;
  for (const task of listTaskRecords()) {
    if (shouldMarkLost(task, now)) {
      reconciled += 1;
      continue;
    }
    if (shouldPruneTerminalTask(task, now)) {
      pruned += 1;
      continue;
    }
    if (shouldStampCleanupAfter(task)) {
      cleanupStamped += 1;
    }
  }
  return { reconciled, cleanupStamped, pruned };
}

/**
 * Yield control back to the event loop so that pending I/O callbacks,
 * timers, and incoming requests can be processed between batches of
 * synchronous task-registry maintenance work.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function startScheduledSweep() {
  if (sweepInProgress) {
    return;
  }
  sweepInProgress = true;
  void sweepTaskRegistry().finally(() => {
    sweepInProgress = false;
  });
}

export async function runTaskRegistryMaintenance(): Promise<TaskRegistryMaintenanceSummary> {
  ensureTaskRegistryReady();
  const now = Date.now();
  let reconciled = 0;
  let cleanupStamped = 0;
  let pruned = 0;
  const tasks = listTaskRecords();
  let processed = 0;
  for (const task of tasks) {
    const current = getTaskById(task.taskId);
    if (!current) {
      continue;
    }
    if (shouldMarkLost(current, now)) {
      const next = markTaskLost(current, now);
      if (next.status === "lost") {
        reconciled += 1;
      }
      processed += 1;
      if (processed % SWEEP_YIELD_BATCH_SIZE === 0) {
        await yieldToEventLoop();
      }
      continue;
    }
    if (shouldPruneTerminalTask(current, now) && deleteTaskRecordById(current.taskId)) {
      pruned += 1;
      processed += 1;
      if (processed % SWEEP_YIELD_BATCH_SIZE === 0) {
        await yieldToEventLoop();
      }
      continue;
    }
    if (
      shouldStampCleanupAfter(current) &&
      setTaskCleanupAfterById({
        taskId: current.taskId,
        cleanupAfter: resolveCleanupAfter(current),
      })
    ) {
      cleanupStamped += 1;
    }
    processed += 1;
    if (processed % SWEEP_YIELD_BATCH_SIZE === 0) {
      await yieldToEventLoop();
    }
  }
  return { reconciled, cleanupStamped, pruned };
}

export async function sweepTaskRegistry(): Promise<TaskRegistryMaintenanceSummary> {
  return runTaskRegistryMaintenance();
}

export function startTaskRegistryMaintenance() {
  ensureTaskRegistryReady();
  deferredSweep = setTimeout(() => {
    deferredSweep = null;
    startScheduledSweep();
  }, 5_000);
  deferredSweep.unref?.();
  if (sweeper) {
    return;
  }
  sweeper = setInterval(startScheduledSweep, TASK_SWEEP_INTERVAL_MS);
  sweeper.unref?.();
}

export function stopTaskRegistryMaintenanceForTests() {
  if (deferredSweep) {
    clearTimeout(deferredSweep);
    deferredSweep = null;
  }
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
  sweepInProgress = false;
}

export function getReconciledTaskById(taskId: string): TaskRecord | undefined {
  const task = getTaskById(taskId);
  return task ? reconcileTaskRecordForOperatorInspection(task) : undefined;
}
