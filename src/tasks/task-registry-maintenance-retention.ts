import { shouldPruneTerminalTask } from "./cron-history-retention.js";
import type { deleteTaskRecordById, getTaskById } from "./task-registry-query.js";
import type { setTaskCleanupAfterById } from "./task-registry-record-api.js";
import { withTaskRegistryMutation } from "./task-registry-state.js";
import { isTerminalTaskStatus, type TaskRecord } from "./task-registry.types.js";
import { resolveTaskCleanupAfter } from "./task-retention.js";

export function shouldStampCleanupAfter(task: TaskRecord): boolean {
  return isTerminalTaskStatus(task.status) && typeof task.cleanupAfter !== "number";
}

export function applyTaskRegistryMaintenanceRetention(
  taskId: string,
  now: number,
  cronHistoryOverflowTaskIds: ReadonlySet<string>,
  runtime: {
    getTaskById: typeof getTaskById;
    deleteTaskRecordById: typeof deleteTaskRecordById;
    setTaskCleanupAfterById: typeof setTaskCleanupAfterById;
  },
): "pruned" | "stamped" | undefined {
  return withTaskRegistryMutation(
    () => {
      const current = runtime.getTaskById(taskId);
      if (!current) {
        return undefined;
      }
      if (
        shouldPruneTerminalTask(current, now, cronHistoryOverflowTaskIds) &&
        runtime.deleteTaskRecordById(current.taskId)
      ) {
        return "pruned";
      }
      if (
        shouldStampCleanupAfter(current) &&
        runtime.setTaskCleanupAfterById({
          taskId: current.taskId,
          cleanupAfter: resolveTaskCleanupAfter(current),
        })
      ) {
        return "stamped";
      }
      return undefined;
    },
    () => undefined,
  );
}
