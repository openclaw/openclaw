import { t } from "../../../i18n/index.ts";
import { registerBackgroundTasksEnglish } from "../../../i18n/locales/en-background-tasks.ts";
import { isActiveTask, taskStatusLabel, withLookupFields } from "../../../lib/tasks/data.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";

registerBackgroundTasksEnglish();

export { newestTaskSnapshot } from "../../../lib/tasks/data.ts";

// Status tone drives the meta line's colored word and the running pulse dot;
// pill chips read too heavy at rail width, so tone is typographic only.
// Shared with the status row's hover preview.
export const STATUS_TONES = {
  queued: "warn",
  running: "warn",
  completed: "ok",
  failed: "danger",
  cancelled: "danger",
  timed_out: "danger",
} as const satisfies Record<TaskSummary["status"], string>;

export function backgroundTaskStatusLabel(task: TaskSummary): string {
  if (isActiveTask(task)) {
    if (task.execution?.state === "waiting") {
      const labels = {
        children: "chat.backgroundTasks.waitingChildren",
        external: "chat.backgroundTasks.waitingExternal",
        agent_messages: "chat.backgroundTasks.waitingMessages",
        approval: "chat.backgroundTasks.waitingApproval",
        user_input: "chat.backgroundTasks.waitingUser",
      } as const;
      return task.execution.wait
        ? t(labels[task.execution.wait.kind])
        : t("chat.backgroundTasks.waiting");
    }
    if (task.execution?.state === "unknown") {
      return t("chat.backgroundTasks.activityUnknown");
    }
    if (task.execution?.state === "finished") {
      return t("chat.backgroundTasks.executionFinished");
    }
    return taskStatusLabel(task.execution?.state === "queued" ? "queued" : task.status);
  }
  return task.status === "completed" &&
    (task.deliveryStatus === "pending" || task.deliveryStatus === "session_queued")
    ? t("chat.backgroundTasks.resultReady")
    : taskStatusLabel(task.status);
}

export function backgroundTaskIsExecuting(task: TaskSummary): boolean {
  return (
    task.status === "running" &&
    (task.execution === undefined || task.execution.state === "running")
  );
}

/**
 * Folds one `tasks.get` lookup into the cached detail map.
 *
 * A lookup taken while the task was still active cannot carry terminal-only
 * fields (such as the bounded exec output tail), so completion drops the cached
 * entry and lets the inspector refetch the finished record.
 */
export function mergeCachedTaskDetail(
  taskDetails: ReadonlyMap<string, TaskSummary>,
  task: TaskSummary,
  detail: TaskSummary,
): Map<string, TaskSummary> {
  if (isActiveTask(detail) && !isActiveTask(task)) {
    const dropped = new Map(taskDetails);
    dropped.delete(task.id);
    return dropped;
  }
  return new Map(taskDetails).set(
    task.id,
    withLookupFields(task, { prompt: detail.prompt, result: detail.result }),
  );
}

/**
 * Drops cached lookups that a list snapshot has since finished.
 *
 * Completion events normally invalidate the running entry, but a refresh can be
 * the first thing that reports the finished row (for example when its event was
 * missed or the rail stayed closed). The cached running lookup cannot carry
 * terminal-only fields such as the bounded output tail, and `taskDetails.has`
 * then blocks the refetch, so reconcile snapshots exactly like events do.
 */
export function reconcileCachedTaskDetails(
  taskDetails: Map<string, TaskSummary>,
  tasks: readonly TaskSummary[],
): Map<string, TaskSummary> {
  let next: Map<string, TaskSummary> | null = null;
  for (const task of tasks) {
    const detail = taskDetails.get(task.id);
    if (!detail || !isActiveTask(detail) || isActiveTask(task)) {
      continue;
    }
    next ??= new Map(taskDetails);
    next.delete(task.id);
  }
  return next ?? taskDetails;
}

export function backgroundTaskDeliveryLabel(task: TaskSummary): string | undefined {
  if (isActiveTask(task) || task.runtime !== "subagent" || !task.deliveryStatus) {
    return undefined;
  }
  const labels = {
    pending: "chat.backgroundTasks.deliveryPending",
    session_queued: "chat.backgroundTasks.deliveryQueued",
    delivered: "chat.backgroundTasks.deliveryDelivered",
    failed: "chat.backgroundTasks.deliveryFailed",
    dismissed: "chat.backgroundTasks.deliveryDismissed",
    parent_missing: "chat.backgroundTasks.deliveryParentMissing",
    not_applicable: "chat.backgroundTasks.deliveryNotApplicable",
  } as const;
  return t(labels[task.deliveryStatus]);
}
