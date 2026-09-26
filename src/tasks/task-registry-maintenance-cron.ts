import { isCronJobActive } from "../cron/active-jobs.js";
import {
  canRecoverCronTask,
  captureCronTaskMaintenanceSelection,
  matchesCronTaskMaintenanceSelection,
} from "./task-cron-maintenance-policy.js";
import { captureTaskMutationContext } from "./task-executor-mutation-effects.async.js";
import { settleTaskRecordTransitionAsync } from "./task-executor-transition.async.js";
import { ensureTaskFlowRegistryReadyAsync } from "./task-flow-runtime-internal.js";
import { flushTaskActivity } from "./task-registry-activity.js";
import { cloneTaskRecord } from "./task-registry-records.js";
import { ensureTaskRegistryReadyAsync, tasks } from "./task-registry-state.js";
import type { TaskRecord } from "./task-registry.types.js";

export async function reconcileCronTaskForMaintenance(
  selected: TaskRecord,
  now: number,
  options: {
    markLost: boolean;
    runtimeAuthoritative: () => boolean;
    assertOwnerCurrent: () => void;
  },
): Promise<{ task?: TaskRecord; outcome?: "recovered" | "lost" }> {
  if (!canRecoverCronTask(selected)) {
    return { task: selected };
  }
  const jobId = selected.sourceId?.trim();
  if (options.runtimeAuthoritative() && jobId && isCronJobActive(jobId)) {
    return { task: selected };
  }
  const creation = captureTaskMutationContext();
  const selection = captureCronTaskMaintenanceSelection(selected);
  const refusal = new Error("Cron task maintenance no longer owns its selected decision");
  const assertCurrent = () => {
    options.assertOwnerCurrent();
    creation.assertStores();
    const current = tasks.get(selected.taskId);
    if (
      !current ||
      !matchesCronTaskMaintenanceSelection(current, selection) ||
      !canRecoverCronTask(current) ||
      (options.runtimeAuthoritative() && jobId && isCronJobActive(jobId)) ||
      (options.markLost && !options.runtimeAuthoritative())
    ) {
      throw refusal;
    }
  };
  try {
    await ensureTaskRegistryReadyAsync(creation.context);
    assertCurrent();
    if (selected.parentFlowId) {
      await ensureTaskFlowRegistryReadyAsync(creation.context);
      assertCurrent();
    }
    flushTaskActivity(selected.taskId);
    assertCurrent();
    const result = await settleTaskRecordTransitionAsync(
      creation,
      {
        type: "tasks.maintainCron",
        input: { taskId: selected.taskId, selected: selection, now, markLost: options.markLost },
      },
      assertCurrent,
    );
    const task = result.receipt?.task;
    const current = tasks.get(selected.taskId);
    return {
      task: current && cloneTaskRecord(current),
      ...(task && task.status !== selected.status
        ? { outcome: task.status === "lost" ? ("lost" as const) : ("recovered" as const) }
        : {}),
    };
  } catch (error) {
    if (error !== refusal) {
      throw error;
    }
    options.assertOwnerCurrent();
    creation.assertStores();
    const current = tasks.get(selected.taskId);
    return { task: current && cloneTaskRecord(current) };
  }
}
