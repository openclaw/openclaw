import {
  collectCronHistoryOverflowTaskIds,
  shouldPruneTerminalTask,
} from "./cron-history-retention.js";
import type { TaskRegistryRead } from "./task-registry-read.js";
import { cloneTaskRecord, compareTasksNewestFirst } from "./task-registry-records.js";
import { tasks } from "./task-registry-state.js";
import { isTerminalTaskStatus, type TaskRecord } from "./task-registry.types.js";

export type TaskRegistryMaintenanceRead = Pick<
  TaskRegistryRead,
  "assertOwnerCurrent" | "assertCurrent" | "isTaskSettled"
>;

export const TASK_MAINTENANCE_BATCH_SIZE = 25;

export type TaskRegistryMaintenanceReader = {
  prepareTaskRegistryRead: () => Promise<TaskRegistryMaintenanceRead | undefined>;
  getTaskRegistryMaintenanceSnapshot: typeof getTaskRegistryMaintenanceSnapshot;
  getTaskRegistryMaintenanceTask: typeof getTaskRegistryMaintenanceTask;
};

// Raw records stay inside this synchronous snapshot. Maintenance carries only
// IDs and retention decisions across awaits, then rereads and clones each task.
export function getTaskRegistryMaintenanceSnapshot(read: TaskRegistryMaintenanceRead): {
  taskIds: readonly string[];
  cronHistoryOverflowTaskIds: ReadonlySet<string>;
} {
  read.assertCurrent();
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
  read: TaskRegistryMaintenanceRead,
  taskId: string,
  now: number,
  cronHistoryOverflowTaskIds: ReadonlySet<string>,
): TaskRecord | undefined | "needs-preparation" {
  if (!read.isTaskSettled(taskId)) {
    return "needs-preparation";
  }
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

export async function visitTaskRegistryMaintenanceTasks(
  source: TaskRegistryMaintenanceReader,
  visit: (
    task: TaskRecord,
    now: number,
    cronHistoryOverflowTaskIds: ReadonlySet<string>,
    assertOwnerCurrent: () => void,
  ) => Promise<void>,
  prepareBatch?: (tasks: readonly TaskRecord[], now: number) => Promise<void>,
): Promise<{ read: TaskRegistryMaintenanceRead; deferred: number }> {
  const prepareRead = async (previous?: TaskRegistryMaintenanceRead) => {
    previous?.assertOwnerCurrent();
    const read = await source.prepareTaskRegistryRead();
    previous?.assertOwnerCurrent();
    if (!read) {
      throw new Error("Task registry changed while preparing maintenance");
    }
    return read;
  };
  let read = await prepareRead();
  const now = Date.now();
  const { taskIds, cronHistoryOverflowTaskIds } = source.getTaskRegistryMaintenanceSnapshot(read);
  let needsPreparation = false;
  let deferred = 0;
  for (const [index, taskId] of taskIds.entries()) {
    if (index > 0 && index % TASK_MAINTENANCE_BATCH_SIZE === 0) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      needsPreparation = true;
    }
    if (needsPreparation) {
      read = await prepareRead(read);
      needsPreparation = false;
    }
    if (prepareBatch && index % TASK_MAINTENANCE_BATCH_SIZE === 0) {
      const candidates = taskIds.slice(index, index + TASK_MAINTENANCE_BATCH_SIZE).flatMap((id) => {
        const task = source.getTaskRegistryMaintenanceTask(
          read,
          id,
          now,
          cronHistoryOverflowTaskIds,
        );
        return task && task !== "needs-preparation" ? [task] : [];
      });
      await prepareBatch(candidates, now);
      read = await prepareRead(read);
    }
    let selected = source.getTaskRegistryMaintenanceTask(
      read,
      taskId,
      now,
      cronHistoryOverflowTaskIds,
    );
    if (selected === "needs-preparation") {
      read = await prepareRead(read);
      selected = source.getTaskRegistryMaintenanceTask(
        read,
        taskId,
        now,
        cronHistoryOverflowTaskIds,
      );
      if (selected === "needs-preparation") {
        deferred += 1;
        continue;
      }
    }
    if (selected) {
      // Consume the cloned candidate before yielding; effects retain their own mutation guards.
      await visit(selected, now, cronHistoryOverflowTaskIds, read.assertOwnerCurrent);
      read.assertOwnerCurrent();
      needsPreparation = true;
    }
  }
  return { read, deferred };
}
