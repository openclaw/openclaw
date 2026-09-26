import {
  collectCronHistoryOverflowTaskIds,
  shouldPruneTerminalTask,
} from "./cron-history-retention.js";
import { isTaskRegistryTaskSettled, type TaskRegistryRead } from "./task-registry-read.js";
import { cloneTaskRecord, compareTasksNewestFirst } from "./task-registry-records.js";
import {
  captureTaskRetentionSelection,
  type TaskRetentionSelection,
} from "./task-registry-retention.operation.js";
import { tasks } from "./task-registry-state.js";
import { isTerminalTaskStatus, type TaskRecord } from "./task-registry.types.js";

export type TaskRegistryMaintenanceRead = Pick<
  TaskRegistryRead,
  "assertOwnerCurrent" | "assertCurrent"
>;

export const TASK_MAINTENANCE_BATCH_SIZE = 25;

export type TaskRegistryMaintenanceReader = {
  prepareTaskRegistryRead: () => Promise<TaskRegistryMaintenanceRead | undefined>;
  getTaskRegistryMaintenanceSnapshot: typeof getTaskRegistryMaintenanceSnapshot;
  getTaskRegistryMaintenanceTask: typeof getTaskRegistryMaintenanceTask;
};

// Raw records stay inside this synchronous snapshot. Maintenance carries only
// IDs and compact retention selections across awaits, then rereads and clones each task.
export function getTaskRegistryMaintenanceSnapshot(read: TaskRegistryMaintenanceRead): {
  taskIds: readonly string[];
  cronHistoryOverflowSelections: ReadonlyMap<string, TaskRetentionSelection>;
} {
  read.assertCurrent();
  // Stable sorting keeps later insertions first when creation timestamps match.
  const ordered = [...tasks.values()].toReversed().toSorted(compareTasksNewestFirst);
  const overflowIds = collectCronHistoryOverflowTaskIds(ordered);
  const taskIds: string[] = [];
  const cronHistoryOverflowSelections = new Map<string, TaskRetentionSelection>();
  for (const task of ordered) {
    taskIds.push(task.taskId);
    if (overflowIds.has(task.taskId)) {
      cronHistoryOverflowSelections.set(task.taskId, captureTaskRetentionSelection(task, true));
    }
  }
  return {
    taskIds,
    cronHistoryOverflowSelections,
  };
}

export function getTaskRegistryMaintenanceTask(
  taskId: string,
  now: number,
  cronHistoryOverflowSelections: ReadonlyMap<string, TaskRetentionSelection>,
): TaskRecord | undefined | "needs-preparation" {
  if (!isTaskRegistryTaskSettled(taskId)) {
    return "needs-preparation";
  }
  const task = tasks.get(taskId);
  if (
    !task ||
    (isTerminalTaskStatus(task.status) &&
      task.runtime !== "acp" &&
      !(task.runtime === "cron" && task.status === "lost") &&
      typeof task.cleanupAfter === "number" &&
      !shouldPruneTerminalTask(task, now, cronHistoryOverflowSelections))
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
    cronHistoryOverflowSelections: ReadonlyMap<string, TaskRetentionSelection>,
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
  const { taskIds, cronHistoryOverflowSelections } =
    source.getTaskRegistryMaintenanceSnapshot(read);
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
      // Revalidate after resuming; selection stays synchronous until the next await.
      read.assertCurrent();
      needsPreparation = false;
    }
    if (prepareBatch && index % TASK_MAINTENANCE_BATCH_SIZE === 0) {
      const candidates = taskIds.slice(index, index + TASK_MAINTENANCE_BATCH_SIZE).flatMap((id) => {
        const task = source.getTaskRegistryMaintenanceTask(id, now, cronHistoryOverflowSelections);
        return task && task !== "needs-preparation" ? [task] : [];
      });
      await prepareBatch(candidates, now);
      read = await prepareRead(read);
      read.assertCurrent();
    }
    let selected = source.getTaskRegistryMaintenanceTask(
      taskId,
      now,
      cronHistoryOverflowSelections,
    );
    if (selected === "needs-preparation") {
      read = await prepareRead(read);
      read.assertCurrent();
      selected = source.getTaskRegistryMaintenanceTask(taskId, now, cronHistoryOverflowSelections);
      if (selected === "needs-preparation") {
        deferred += 1;
        continue;
      }
    }
    if (selected) {
      // Consume the cloned candidate before yielding; effects retain their own mutation guards.
      await visit(selected, now, cronHistoryOverflowSelections, read.assertOwnerCurrent);
      read.assertOwnerCurrent();
      needsPreparation = true;
    }
  }
  return { read, deferred };
}
