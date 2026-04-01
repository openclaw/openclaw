import { truncateUtf16Safe } from "../utils.js";
import type { TaskRecord } from "./task-registry.types.js";

const ACTIVE_TASK_STATUSES = new Set(["queued", "running"]);
const FAILURE_TASK_STATUSES = new Set(["failed", "timed_out", "lost"]);
export const TASK_STATUS_RECENT_WINDOW_MS = 5 * 60_000;
export const TASK_STATUS_TITLE_MAX_CHARS = 80;
export const TASK_STATUS_DETAIL_MAX_CHARS = 120;

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

function truncateTaskStatusText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${truncateUtf16Safe(trimmed, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function formatTaskStatusTitle(task: TaskRecord): string {
  return truncateTaskStatusText(
    task.label?.trim() || task.task.trim(),
    TASK_STATUS_TITLE_MAX_CHARS,
  );
}

export function formatTaskStatusDetail(task: TaskRecord): string | undefined {
  const raw =
    task.status === "running" || task.status === "queued"
      ? task.progressSummary?.trim()
      : task.error?.trim() || task.terminalSummary?.trim();
  if (!raw) {
    return undefined;
  }
  return truncateTaskStatusText(raw, TASK_STATUS_DETAIL_MAX_CHARS);
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
  const visibleCandidates = tasks.filter((task) => !isExpiredTask(task, now));
  const active = visibleCandidates.filter(isActiveTask);
  const recentTerminal = visibleCandidates.filter((task) => isRecentTerminalTask(task, now));
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
