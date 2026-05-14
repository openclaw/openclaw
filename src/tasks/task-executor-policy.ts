import type { TaskEventRecord, TaskRecord, TaskStatus } from "./task-registry.types.js";
import { formatTaskStatusTitleText, sanitizeTaskStatusText } from "./task-status.js";

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
      (task.runtime === "subagent" ? "Subagent task" : task.task.trim() || "Background task"),
  );
}

export function formatTaskTerminalMessage(task: TaskRecord): string {
  const title = resolveTaskDisplayTitle(task);
  const summary = sanitizeTaskStatusText(task.terminalSummary, {
    errorContext: task.status !== "succeeded" || task.terminalOutcome === "blocked",
  });
  if (task.status === "succeeded") {
    if (task.terminalOutcome === "blocked") {
      return summary
        ? `Background work needs follow-up: ${title}. ${summary}`
        : `Background work needs follow-up: ${title}.`;
    }
    return summary
      ? `Background work finished: ${title}. ${summary}`
      : `Background work finished: ${title}. Please send Moeed a concise user-facing summary in your normal voice.`;
  }
  if (task.status === "timed_out") {
    return `Background work timed out: ${title}. Please send Moeed a concise update in your normal voice.`;
  }
  if (task.status === "lost") {
    const error = sanitizeTaskStatusText(task.error, { errorContext: true });
    const fallbackSummary = sanitizeTaskStatusText(task.terminalSummary, { errorContext: true });
    return `Background work was interrupted: ${title}. ${error || fallbackSummary || "Backing session disappeared."}`;
  }
  if (task.status === "cancelled") {
    return `Background work was cancelled: ${title}.`;
  }
  const error = sanitizeTaskStatusText(task.error, { errorContext: true });
  const fallbackSummary = sanitizeTaskStatusText(task.terminalSummary, { errorContext: true });
  return error
    ? `Background work failed: ${title}. ${error}`
    : fallbackSummary
      ? `Background work failed: ${title}. ${fallbackSummary}`
      : `Background work failed: ${title}. Please send Moeed a concise update in your normal voice.`;
}

export function formatTaskBlockedFollowupMessage(task: TaskRecord): string | null {
  if (task.status !== "succeeded" || task.terminalOutcome !== "blocked") {
    return null;
  }
  const title = resolveTaskDisplayTitle(task);
  const summary =
    sanitizeTaskStatusText(task.terminalSummary, { errorContext: true }) ||
    "Task is blocked and needs follow-up.";
  return `Follow-up needed for background work: ${title}. ${summary}`;
}

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

export function shouldAutoDeliverTaskStateChange(task: TaskRecord): boolean {
  return (
    task.notifyPolicy === "state_changes" &&
    task.deliveryStatus === "pending" &&
    !isTerminalTaskStatus(task.status)
  );
}

export function shouldSuppressDuplicateTerminalDelivery(params: {
  task: TaskRecord;
  preferredTaskId?: string;
}): boolean {
  if (params.task.runtime !== "acp" || !params.task.runId?.trim()) {
    return false;
  }
  return Boolean(params.preferredTaskId && params.preferredTaskId !== params.task.taskId);
}
