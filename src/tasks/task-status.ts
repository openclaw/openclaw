import { reconcileTaskRecordForOperatorInspection } from "./task-registry.maintenance.js";
import type { TaskRecord } from "./task-registry.types.js";

const ACTIVE_TASK_STATUSES = new Set(["queued", "running"]);
const FAILURE_TASK_STATUSES = new Set(["failed", "timed_out", "lost"]);
export const TASK_STATUS_RECENT_WINDOW_MS = 5 * 60_000;

function isActiveTask(task: TaskRecord): boolean {
  return ACTIVE_TASK_STATUSES.has(task.status);
}

function isFailureTask(task: TaskRecord): boolean {
  return FAILURE_TASK_STATUSES.has(task.status);
}

function resolveTaskReferenceAt(task: TaskRecord): number {
  if (isActiveTask(task)) {
    return task.lastEventAt ?? task.startedAt ?? task.createdAt;
  }
  return task.endedAt ?? task.lastEventAt ?? task.startedAt ?? task.createdAt;
}

function isExpiredTask(task: TaskRecord, now: number): boolean {
  return typeof task.cleanupAfter === "number" && task.cleanupAfter <= now;
}

function isRecentTerminalTask(task: TaskRecord, now: number): boolean {
  if (isActiveTask(task)) {
    return false;
  }
  return now - resolveTaskReferenceAt(task) <= TASK_STATUS_RECENT_WINDOW_MS;
}

export type TaskStatusSnapshot = {
  latest?: TaskRecord;
  focus?: TaskRecord;
  visible: TaskRecord[];
  active: TaskRecord[];
  recentTerminal: TaskRecord[];
  activeCount: number;
  totalCount: number;
  recentFailureCount: number;
};

export function buildTaskStatusSnapshot(
  tasks: TaskRecord[],
  opts?: { now?: number },
): TaskStatusSnapshot {
  const now = opts?.now ?? Date.now();
  const reconciled = tasks
    .map((task) => reconcileTaskRecordForOperatorInspection(task))
    .filter((task) => !isExpiredTask(task, now));
  const active = reconciled.filter(isActiveTask);
  const recentTerminal = reconciled.filter((task) => isRecentTerminalTask(task, now));
  const visible = active.length > 0 ? [...active, ...recentTerminal] : recentTerminal;
  const focus =
    active[0] ?? recentTerminal.find((task) => isFailureTask(task)) ?? recentTerminal[0];
  return {
    latest: active[0] ?? recentTerminal[0],
    focus,
    visible,
    active,
    recentTerminal,
    activeCount: active.length,
    totalCount: visible.length,
    recentFailureCount: recentTerminal.filter(isFailureTask).length,
  };
}
