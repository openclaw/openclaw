// Shared eligibility and formatting for restart diagnostics that report active tasks.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { TaskRecord, TaskStatus } from "./task-registry.types.js";
import { isRetainedYieldOwner, RETAINED_YIELD_GUIDANCE } from "./task-retained-yield-guidance.js";

export type ActiveTaskRestartBlocker = {
  taskId: string;
  status: Extract<TaskStatus, "running">;
  runtime: TaskRecord["runtime"];
  /** Internal classification; omitted from suspension task metadata. */
  taskKind?: TaskRecord["taskKind"];
  runId?: string;
  label?: string;
  title?: string;
  /** Set when the stored running task last started sessions_yield. The pause is not confirmed. */
  retainedYield?: "sessions_yield";
};

export function isTaskRestartBlocker(task: TaskRecord): task is TaskRecord & {
  status: ActiveTaskRestartBlocker["status"];
} {
  // Queued work can survive restart. An ended running row is an inconsistency,
  // not live work that should block the restart.
  return task.status === "running" && !task.endedAt;
}

export function createActiveTaskRestartBlocker(
  task: TaskRecord & { status: ActiveTaskRestartBlocker["status"] },
): ActiveTaskRestartBlocker {
  return {
    taskId: task.taskId,
    status: task.status,
    runtime: task.runtime,
    ...(task.taskKind ? { taskKind: task.taskKind } : {}),
    ...(task.runId ? { runId: task.runId } : {}),
    ...(task.label ? { label: task.label } : {}),
    ...(task.task ? { title: task.task } : {}),
    ...(isRetainedYieldOwner(task) ? { retainedYield: "sessions_yield" as const } : {}),
  };
}

export function formatActiveTaskRestartBlocker(task: ActiveTaskRestartBlocker): string {
  const formatted = [
    `taskId=${task.taskId}`,
    task.runId ? `runId=${task.runId}` : null,
    `status=${task.status}`,
    `runtime=${task.runtime}`,
    task.label ? `label=${task.label}` : null,
    task.title ? `title=${truncateUtf16Safe(task.title, 80)}` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  if (task.retainedYield !== "sessions_yield") {
    return formatted;
  }
  return `${formatted} lastTool=sessions_yield unverified. ${RETAINED_YIELD_GUIDANCE}`;
}
