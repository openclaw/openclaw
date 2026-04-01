import { readAcpSessionEntry } from "../acp/runtime/session-meta.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { listTaskAuditFindings, summarizeTaskAuditFindings } from "./task-registry.audit.js";
import type { TaskAuditSummary } from "./task-registry.audit.js";
import {
  deleteTaskRecordById,
  ensureTaskRegistryReady,
  getTaskById,
  listTaskRecords,
  markTaskLostById,
  maybeDeliverTaskTerminalUpdate,
  resolveTaskForLookupToken,
  setTaskCleanupAfterById,
} from "./task-registry.js";
import { summarizeTaskRecords } from "./task-registry.summary.js";
import type { TaskRecord, TaskRegistrySummary } from "./task-registry.types.js";

const TASK_RECONCILE_GRACE_MS = 5 * 60_000;
const TASK_RETENTION_MS = 7 * 24 * 60 * 60_000;
const TASK_SWEEP_INTERVAL_MS = 60_000;

let sweeper: NodeJS.Timeout | null = null;

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

function hasBackingSession(task: TaskRecord): boolean {
  const childSessionKey = task.childSessionKey?.trim();
  if (!childSessionKey) {
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
  if (task.runtime === "subagent" || task.runtime === "cli") {
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

export function runTaskRegistryMaintenance(): TaskRegistryMaintenanceSummary {
  ensureTaskRegistryReady();
  const now = Date.now();
  let reconciled = 0;
  let cleanupStamped = 0;
  let pruned = 0;
  for (const task of listTaskRecords()) {
    if (shouldMarkLost(task, now)) {
      const next = markTaskLost(task, now);
      if (next.status === "lost") {
        reconciled += 1;
      }
      continue;
    }
    if (shouldPruneTerminalTask(task, now) && deleteTaskRecordById(task.taskId)) {
      pruned += 1;
      continue;
    }
    if (
      shouldStampCleanupAfter(task) &&
      setTaskCleanupAfterById({
        taskId: task.taskId,
        cleanupAfter: resolveCleanupAfter(task),
      })
    ) {
      cleanupStamped += 1;
    }
  }
  return { reconciled, cleanupStamped, pruned };
}

export function sweepTaskRegistry(): TaskRegistryMaintenanceSummary {
  return runTaskRegistryMaintenance();
}

export function startTaskRegistryMaintenance() {
  ensureTaskRegistryReady();
  void sweepTaskRegistry();
  if (sweeper) {
    return;
  }
  sweeper = setInterval(() => {
    void sweepTaskRegistry();
  }, TASK_SWEEP_INTERVAL_MS);
  sweeper.unref?.();
}

export function stopTaskRegistryMaintenanceForTests() {
  if (!sweeper) {
    return;
  }
  clearInterval(sweeper);
  sweeper = null;
}

export function getReconciledTaskById(taskId: string): TaskRecord | undefined {
  const task = getTaskById(taskId);
  return task ? reconcileTaskRecordForOperatorInspection(task) : undefined;
}
