import { describe, expect, it } from "vitest";
import {
	formatTaskBlockedFollowupMessage,
	formatTaskStateChangeMessage,
	formatTaskTerminalMessage,
	isTerminalTaskStatus,
	shouldAutoDeliverTaskStateChange,
	shouldAutoDeliverTaskTerminalUpdate,
	shouldSuppressDuplicateTerminalDelivery,
} from "./task-executor-policy.js";
import type { TaskEventRecord, TaskRecord } from "./task-registry.types.js";

function createTask(partial: Partial<TaskRecord>): TaskRecord {
	return {
		taskId: partial.taskId ?? "task-1",
		runtime: partial.runtime ?? "acp",
		requesterSessionKey: partial.requesterSessionKey ?? "agent:main:main",
		task: partial.task ?? "Investigate issue",
		status: partial.status ?? "running",
		deliveryStatus: partial.deliveryStatus ?? "pending",
		notifyPolicy: partial.notifyPolicy ?? "done_only",
		createdAt: partial.createdAt ?? 1,
		...partial,
	};
}

describe("task-executor-policy", () => {
	it("identifies terminal statuses", () => {
		expect(isTerminalTaskStatus("queued")).toBe(false);
		expect(isTerminalTaskStatus("running")).toBe(false);
		expect(isTerminalTaskStatus("succeeded")).toBe(true);
		expect(isTerminalTaskStatus("failed")).toBe(true);
		expect(isTerminalTaskStatus("timed_out")).toBe(true);
		expect(isTerminalTaskStatus("cancelled")).toBe(true);
		expect(isTerminalTaskStatus("lost")).toBe(true);
	});

	it("formats terminal, followup, and progress messages", () => {
		const blockedTask = createTask({
			status: "succeeded",
			terminalOutcome: "blocked",
			terminalSummary: "Needs login.",
			runId: "run-1234567890",
			label: "ACP import",
		});
		const progressEvent: TaskEventRecord = {
			at: 10,
			kind: "progress",
			summary: "No output for 60s.",
		};

		expect(formatTaskTerminalMessage(blockedTask)).toBe(
			"Background task blocked: ACP import (run run-1234). Needs login.",
		);
		expect(formatTaskBlockedFollowupMessage(blockedTask)).toBe(
			"Task needs follow-up: ACP import (run run-1234). Needs login.",
		);
		expect(formatTaskStateChangeMessage(blockedTask, progressEvent)).toBe(
			"Background task update: ACP import. No output for 60s.",
		);
	});

	it("keeps delivery policy decisions explicit", () => {
		expect(
			shouldAutoDeliverTaskTerminalUpdate(
				createTask({
					status: "succeeded",
					deliveryStatus: "pending",
					notifyPolicy: "done_only",
				}),
			),
		).toBe(true);
		expect(
			shouldAutoDeliverTaskTerminalUpdate(
				createTask({
					runtime: "subagent",
					status: "succeeded",
					deliveryStatus: "pending",
				}),
			),
		).toBe(false);
		expect(
			shouldAutoDeliverTaskStateChange(
				createTask({
					status: "running",
					notifyPolicy: "state_changes",
					deliveryStatus: "pending",
				}),
			),
		).toBe(true);
		expect(
			shouldAutoDeliverTaskStateChange(
				createTask({
					status: "failed",
					notifyPolicy: "state_changes",
					deliveryStatus: "pending",
				}),
			),
		).toBe(false);
		expect(
			shouldSuppressDuplicateTerminalDelivery({
				task: createTask({
					runtime: "acp",
					runId: "run-duplicate",
				}),
				preferredTaskId: "task-2",
			}),
		).toBe(true);
		expect(
			shouldSuppressDuplicateTerminalDelivery({
				task: createTask({
					runtime: "acp",
					runId: "run-duplicate",
				}),
				preferredTaskId: "task-1",
			}),
		).toBe(false);
		expect(
			shouldSuppressDuplicateTerminalDelivery({
				task: createTask({
					runtime: "acp",
					runId: "run-duplicate",
				}),
				preferredTaskId: undefined,
			}),
		).toBe(false);
	});
});
