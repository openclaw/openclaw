import type {
	TaskEventRecord,
	TaskRecord,
	TaskStatus,
} from "./task-registry.types.js";

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
	return (
		task.label?.trim() ||
		(task.runtime === "acp"
			? "ACP background task"
			: task.runtime === "subagent"
				? "Subagent task"
				: task.task.trim() || "Background task")
	);
}

function resolveTaskRunLabel(task: TaskRecord): string {
	return task.runId ? ` (run ${task.runId.slice(0, 8)})` : "";
}

export function formatTaskTerminalMessage(task: TaskRecord): string {
	const title = resolveTaskDisplayTitle(task);
	const runLabel = resolveTaskRunLabel(task);
	const summary = task.terminalSummary?.trim();
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
		return `Background task lost: ${title}${runLabel}. ${task.error ?? "Backing session disappeared."}`;
	}
	if (task.status === "cancelled") {
		return `Background task cancelled: ${title}${runLabel}.`;
	}
	const error = task.error?.trim();
	return error
		? `Background task failed: ${title}${runLabel}. ${error}`
		: `Background task failed: ${title}${runLabel}.`;
}

export function formatTaskBlockedFollowupMessage(
	task: TaskRecord,
): string | null {
	if (task.status !== "succeeded" || task.terminalOutcome !== "blocked") {
		return null;
	}
	const title = resolveTaskDisplayTitle(task);
	const runLabel = resolveTaskRunLabel(task);
	const summary =
		task.terminalSummary?.trim() || "Task is blocked and needs follow-up.";
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
		return event.summary
			? `Background task update: ${title}. ${event.summary}`
			: null;
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
	return Boolean(
		params.preferredTaskId && params.preferredTaskId !== params.task.taskId,
	);
}
