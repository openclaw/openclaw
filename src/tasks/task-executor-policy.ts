import type { TaskEventRecord, TaskRecord, TaskStatus } from "./task-registry.types.js";
import { formatTaskStatusTitleText, sanitizeTaskStatusText } from "./task-status.js";

/** Returns true once a task status should no longer emit progress updates. */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "timed_out" ||
    status === "cancelled" ||
    status === "lost"
  );
}

function resolveTaskDisplayTitle(task: TaskRecord): string {
  return formatTaskStatusTitleText(
    task.label?.trim() ||
      (task.runtime === "acp"
        ? "ACP background task"
        : task.runtime === "subagent"
          ? "Subagent task"
          : task.task.trim() || "Background task"),
  );
}

function resolveTaskRunLabel(task: TaskRecord): string {
  return task.runId ? ` (run ${task.runId.slice(0, 8)})` : "";
}

/** Formats the user-visible terminal update for a completed background task. */
export function formatTaskTerminalMessage(
  task: TaskRecord,
  options: { surface?: "direct" | "parent_session" } = {},
): string {
  const title = resolveTaskDisplayTitle(task);
  const runLabel = resolveTaskRunLabel(task);
  const summary = sanitizeTaskStatusText(task.terminalSummary, {
    errorContext: task.status !== "succeeded" || task.terminalOutcome === "blocked",
  });
  if (task.status === "succeeded") {
    if (task.terminalOutcome === "blocked") {
      // "blocked" is stored as a succeeded task plus terminal outcome so the
      // flow can remain retryable while the user still sees follow-up language.
      return summary
        ? `Background task blocked: ${title}${runLabel}. ${summary}`
        : `Background task blocked: ${title}${runLabel}.`;
    }
    if (options.surface === "parent_session") {
      // Parent sessions should review ACP results before declaring the overall
      // user request done, even when the child task itself succeeded.
      const reviewNext = "Next: parent will review/verify before calling it done.";
      return summary
        ? `Background task ready for review: ${title}${runLabel}. ${summary} ${reviewNext}`
        : `Background task ready for review: ${title}${runLabel}. ${reviewNext}`;
    }
    return summary
      ? `Background task done: ${title}${runLabel}. ${summary}`
      : `Background task done: ${title}${runLabel}.`;
  }
  if (task.status === "timed_out") {
    return `Background task timed out: ${title}${runLabel}.`;
  }
  if (task.status === "lost") {
    const error = sanitizeTaskStatusText(task.error, { errorContext: true });
    const fallbackSummary = sanitizeTaskStatusText(task.terminalSummary, { errorContext: true });
    return `Background task lost: ${title}${runLabel}. ${error || fallbackSummary || "Backing session disappeared."}`;
  }
  if (task.status === "cancelled") {
    return `Background task cancelled: ${title}${runLabel}.`;
  }
  const error = sanitizeTaskStatusText(task.error, { errorContext: true });
  const fallbackSummary = sanitizeTaskStatusText(task.terminalSummary, { errorContext: true });
  return error
    ? `Background task failed: ${title}${runLabel}. ${error}`
    : fallbackSummary
      ? `Background task failed: ${title}${runLabel}. ${fallbackSummary}`
      : `Background task failed: ${title}${runLabel}.`;
}

/** True when an ACP child success should be framed as parent-session review. */
export function shouldUseParentReviewTaskTerminalMessage(task: TaskRecord): boolean {
  return (
    task.runtime === "acp" &&
    task.status === "succeeded" &&
    task.terminalOutcome !== "blocked" &&
    Boolean(task.childSessionKey?.trim())
  );
}

/** Formats the follow-up prompt for retryable blocked task completions. */
export function formatTaskBlockedFollowupMessage(task: TaskRecord): string | null {
  if (task.status !== "succeeded" || task.terminalOutcome !== "blocked") {
    return null;
  }
  const title = resolveTaskDisplayTitle(task);
  const runLabel = resolveTaskRunLabel(task);
  const summary =
    sanitizeTaskStatusText(task.terminalSummary, { errorContext: true }) ||
    "Task is blocked and needs follow-up.";
  return `Task needs follow-up: ${title}${runLabel}. ${summary}`;
}

/** Formats non-terminal state-change notifications for task starts and progress. */
export function formatTaskStateChangeMessage(
  task: TaskRecord,
  event: TaskEventRecord,
): string | null {
  const title = resolveTaskDisplayTitle(task);
  if (event.kind === "running") {
    return `Background task started: ${title}.`;
  }
  if (event.kind === "progress") {
    const summary = sanitizeTaskStatusText(event.summary);
    return summary ? `Background task update: ${title}. ${summary}` : null;
  }
  return null;
}

/** Decides whether a terminal update should be delivered automatically. */
export function shouldAutoDeliverTaskTerminalUpdate(task: TaskRecord): boolean {
  if (task.notifyPolicy === "silent") {
    return false;
  }
  if (task.runtime === "subagent" && task.status !== "cancelled") {
    return false;
  }
  if (!isTerminalTaskStatus(task.status)) {
    return false;
  }
  return task.deliveryStatus === "pending";
}

/** Decides whether a running/progress event should be delivered automatically. */
export function shouldAutoDeliverTaskStateChange(task: TaskRecord): boolean {
  return (
    task.notifyPolicy === "state_changes" &&
    task.deliveryStatus === "pending" &&
    !isTerminalTaskStatus(task.status)
  );
}

/** Suppresses duplicate ACP terminal notifications when another task is preferred. */
export function shouldSuppressDuplicateTerminalDelivery(params: {
  task: TaskRecord;
  preferredTaskId?: string;
}): boolean {
  if (params.task.runtime !== "acp" || !params.task.runId?.trim()) {
    return false;
  }
  return Boolean(params.preferredTaskId && params.preferredTaskId !== params.task.taskId);
}
