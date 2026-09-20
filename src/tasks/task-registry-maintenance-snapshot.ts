import {
  collectCronHistoryOverflowTaskIds,
  shouldPruneTerminalTask,
} from "./cron-history-retention.js";
import { cloneTaskRecord, compareTasksNewestFirst } from "./task-registry-records.js";
import { ensureTaskRegistryReady, tasks } from "./task-registry-state.js";
import { isTerminalTaskStatus, type TaskRecord } from "./task-registry.types.js";

// Raw records stay inside this synchronous snapshot. Maintenance carries only
// IDs and retention decisions across awaits, then rereads and clones each task.
export function getTaskRegistryMaintenanceSnapshot(): {
  taskIds: readonly string[];
  cronHistoryOverflowTaskIds: ReadonlySet<string>;
} {
  ensureTaskRegistryReady();
  const ordered = [...tasks.values()]
    .map((task, insertionIndex) => ({ task, createdAt: task.createdAt, insertionIndex }))
    .toSorted(compareTasksNewestFirst)
    .map(({ task }) => task);
  return {
    taskIds: ordered.map((task) => task.taskId),
    cronHistoryOverflowTaskIds: collectCronHistoryOverflowTaskIds(ordered),
  };
}

export function getTaskRegistryMaintenanceTask(
  taskId: string,
  now: number,
  cronHistoryOverflowTaskIds: ReadonlySet<string>,
): TaskRecord | undefined {
  ensureTaskRegistryReady();
  const task = tasks.get(taskId);
  if (
    !task ||
    (isTerminalTaskStatus(task.status) &&
      task.runtime !== "acp" &&
      !(task.runtime === "cron" && task.status === "lost") &&
      typeof task.cleanupAfter === "number" &&
      !shouldPruneTerminalTask(task, now, cronHistoryOverflowTaskIds))
  ) {
    return undefined;
  }
  return cloneTaskRecord(task);
}
