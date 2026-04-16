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

export function formatTaskTerminalMessage(task: TaskRecord): string {
  const title = resolveTaskDisplayTitle(task);
  const runLabel = resolveTaskRunLabel(task);
  const summary = sanitizeTaskStatusText(task.terminalSummary, {
    errorContext: task.status !== "succeeded" || task.terminalOutcome === "blocked",
  });
  if (task.status === "succeeded") {
    if (task.terminalOutcome === "blocked") {
      return summary
        ? `Background task blocked: ${title}${runLabel}. ${summary}`
        : `Background task blocked: ${title}${runLabel}.`;
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

// Phase 3 Discord Surface Overhaul: thread-bound completion formatter.
//
// For thread-bound ACP sessions, the parent stream relay already delivered
// progress / final_reply into the thread, so the verbose
// "Background task done: ACP background task (run xxxxxx)." banner adds
// noise without information. This formatter returns either a compact
// thread-appropriate message OR null to indicate the caller should suppress
// delivery entirely.
//
// Returns null when:
//   - task succeeded with no terminal summary (the relay already said what
//     there was to say)
//   - task is in a non-surface state that the surface-policy short-circuits
//
// Returns a short string when:
//   - task failed/timed-out/cancelled/lost (operator needs to know)
//   - task is blocked (Blocked-Child Protocol invariant: always surface)
//   - task has a non-empty terminalSummary worth preserving
export function formatThreadBoundCompletion(task: TaskRecord): string | null {
  // Blocked and hard-failure paths MUST surface — route through the existing
  // formatter so the operator still sees the signal.
  if (task.status === "failed" || task.status === "timed_out" || task.status === "lost") {
    return formatTaskTerminalMessage(task);
  }
  if (task.status === "cancelled") {
    return formatTaskTerminalMessage(task);
  }
  if (task.status === "succeeded" && task.terminalOutcome === "blocked") {
    return formatTaskTerminalMessage(task);
  }
  if (task.status === "succeeded") {
    const summary = sanitizeTaskStatusText(task.terminalSummary);
    if (summary) {
      // Preserve meaningful summaries without the "Background task done: ..."
      // prefix that reads as boilerplate in a live thread.
      return summary;
    }
    // The relay already delivered the terminal assistant reply; no banner.
    return null;
  }
  // Non-terminal statuses should not reach this path, but be safe: suppress.
  return null;
}

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
    // Phase 3 Discord Surface Overhaul: silent tasks that originate from
    // thread-bound ACP spawns still surface a COMPACT terminal banner for
    // failure/blocked/timeout/lost states so the operator is not left in the
    // dark. For plain "succeeded with no summary" runs the formatter returns
    // null and we stay silent. The delivery formatter at the call site
    // consults formatThreadBoundCompletion for the substituted message text.
    if (task.runtime === "subagent" && task.status !== "cancelled") {
      return false;
    }
    if (!isTerminalTaskStatus(task.status)) {
      return false;
    }
    if (task.deliveryStatus !== "pending") {
      return false;
    }
    return formatThreadBoundCompletion(task) !== null;
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
