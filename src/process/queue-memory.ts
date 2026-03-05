/**
 * In-memory queue backend — provides the same interface as queue-db.ts,
 * but data is stored only in process memory (default mode).
 *
 * When persistent mode is not configured, command-queue uses this adapter,
 * avoiding the dependency on the better-sqlite3 native module.
 */
import type { TaskRecord, TaskStatus } from "./queue-db.js";

let nextId = 1;
const tasks = new Map<number, TaskRecord>();

export function insertTask(lane: string, taskType: string, payload: unknown): number {
  const id = nextId++;
  const now = Date.now();
  tasks.set(id, {
    id,
    lane,
    task_type: taskType,
    payload: JSON.stringify(payload),
    status: "PENDING",
    error_msg: null,
    result: null,
    retry_count: 0,
    created_at: now,
    updated_at: now,
  });
  return id;
}

export function claimNextPendingTask(lane: string): TaskRecord | null {
  for (const task of tasks.values()) {
    if (task.lane === lane && task.status === "PENDING") {
      task.status = "RUNNING";
      task.updated_at = Date.now();
      return { ...task };
    }
  }
  return null;
}

export function resolveTask(id: number, result?: unknown) {
  const task = tasks.get(id);
  if (task) {
    task.status = "COMPLETED";
    task.updated_at = Date.now();
    task.result = result !== undefined ? JSON.stringify(result) : null;
  }
}

export function rejectTask(id: number, errorMsg: string) {
  const task = tasks.get(id);
  if (task) {
    task.status = "FAILED";
    task.error_msg = errorMsg;
    task.updated_at = Date.now();
  }
}

export function countQueueByStatus(lane?: string, status?: TaskStatus): number {
  let count = 0;
  for (const task of tasks.values()) {
    if (lane && task.lane !== lane) {
      continue;
    }
    if (status) {
      if (task.status !== status) {
        continue;
      }
    } else {
      if (task.status !== "PENDING" && task.status !== "RUNNING") {
        continue;
      }
    }
    count++;
  }
  return count;
}

export function countTotalQueue(): number {
  let count = 0;
  for (const task of tasks.values()) {
    if (task.status === "PENDING" || task.status === "RUNNING") {
      count++;
    }
  }
  return count;
}

export function clearLaneTasks(lane: string): number {
  let removed = 0;
  for (const [id, task] of tasks.entries()) {
    if (task.lane === lane && task.status === "PENDING") {
      tasks.delete(id);
      removed++;
    }
  }
  return removed;
}

/**
 * Get the list of PENDING task IDs for a given lane (called before clearLaneTasks to reject in-memory Promises).
 */
export function getPendingTaskIdsForLane(lane: string): number[] {
  const ids: number[] = [];
  for (const task of tasks.values()) {
    if (task.lane === lane && task.status === "PENDING") {
      ids.push(task.id);
    }
  }
  return ids;
}

export function hasActiveTasks(): boolean {
  for (const task of tasks.values()) {
    if (task.status === "RUNNING") {
      return true;
    }
  }
  return false;
}

export function recoverRunningTasks(): string[] {
  const affectedLanes = new Set<string>();
  for (const task of tasks.values()) {
    if (task.status === "RUNNING") {
      affectedLanes.add(task.lane);
      task.status = "PENDING";
      task.updated_at = Date.now();
    }
  }
  return Array.from(affectedLanes);
}

export function getTaskResult(
  id: number,
): { status: TaskStatus; result: unknown; error_msg: string | null } | null {
  const task = tasks.get(id);
  if (!task) {
    return null;
  }
  return {
    status: task.status,
    result: task.result ? JSON.parse(task.result) : null,
    error_msg: task.error_msg,
  };
}

export function getPendingLanes(): string[] {
  const lanes = new Set<string>();
  for (const task of tasks.values()) {
    if (task.status === "PENDING") {
      lanes.add(task.lane);
    }
  }
  return Array.from(lanes);
}

export function markStaleTasks(_reason?: string): number {
  return 0;
}

export function getRecoverableTasks(): TaskRecord[] {
  return [];
}

/**
 * Reset all in-memory state (used for test isolation only).
 */
export function reset(): void {
  tasks.clear();
  nextId = 1;
}
