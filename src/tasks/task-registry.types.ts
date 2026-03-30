import type { DeliveryContext } from "../utils/delivery-context.js";

export type TaskRuntime = "subagent" | "acp" | "cli" | "cron";

export type TaskStatus =
	| "queued"
	| "running"
	| "succeeded"
	| "failed"
	| "timed_out"
	| "cancelled"
	| "lost";

export type TaskDeliveryStatus =
	| "pending"
	| "delivered"
	| "session_queued"
	| "failed"
	| "parent_missing"
	| "not_applicable";

export type TaskNotifyPolicy = "done_only" | "state_changes" | "silent";

export type TaskTerminalOutcome = "succeeded" | "blocked";

export type TaskStatusCounts = Record<TaskStatus, number>;
export type TaskRuntimeCounts = Record<TaskRuntime, number>;

export type TaskRegistrySummary = {
	total: number;
	active: number;
	terminal: number;
	failures: number;
	byStatus: TaskStatusCounts;
	byRuntime: TaskRuntimeCounts;
};

export type TaskEventKind = TaskStatus | "progress";

export type TaskEventRecord = {
	at: number;
	kind: TaskEventKind;
	summary?: string;
};

export type TaskDeliveryState = {
	taskId: string;
	requesterOrigin?: DeliveryContext;
	lastNotifiedEventAt?: number;
};

export type TaskRecord = {
	taskId: string;
	runtime: TaskRuntime;
	sourceId?: string;
	requesterSessionKey: string;
	parentFlowId?: string;
	childSessionKey?: string;
	parentTaskId?: string;
	agentId?: string;
	runId?: string;
	label?: string;
	task: string;
	status: TaskStatus;
	deliveryStatus: TaskDeliveryStatus;
	notifyPolicy: TaskNotifyPolicy;
	createdAt: number;
	startedAt?: number;
	endedAt?: number;
	lastEventAt?: number;
	cleanupAfter?: number;
	error?: string;
	progressSummary?: string;
	terminalSummary?: string;
	terminalOutcome?: TaskTerminalOutcome;
};

export type TaskRegistrySnapshot = {
	tasks: TaskRecord[];
	deliveryStates: TaskDeliveryState[];
};
