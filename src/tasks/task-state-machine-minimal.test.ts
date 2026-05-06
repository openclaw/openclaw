import { describe, expect, it } from "vitest";
import { deriveTaskFlowStatusFromTask } from "./task-flow-registry.js";
import { summarizeTaskRecords } from "./task-registry.summary.js";
import type { TaskRecord } from "./task-registry.types.js";
import { buildTaskStatusSnapshot, formatTaskStatusDetail } from "./task-status.js";

const NOW = 1_000_000_000_000;

function makeTask(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    taskId: overrides.taskId ?? "task-1",
    runId: overrides.runId ?? "run-1",
    task: overrides.task ?? "default task",
    runtime: overrides.runtime ?? "subagent",
    status: overrides.status ?? "running",
    requesterSessionKey: overrides.requesterSessionKey ?? "agent:main:main",
    ownerKey: overrides.ownerKey ?? "agent:main:main",
    scopeKind: overrides.scopeKind ?? "session",
    createdAt: overrides.createdAt ?? NOW - 1_000,
    deliveryStatus: overrides.deliveryStatus ?? "pending",
    notifyPolicy: overrides.notifyPolicy ?? "done_only",
    ...overrides,
  };
}

describe("task state machine minimal active states", () => {
  it("counts awaiting_approval and waiting_external as active states", () => {
    const summary = summarizeTaskRecords([
      makeTask({ taskId: "a", status: "queued" }),
      makeTask({ taskId: "b", status: "awaiting_approval" }),
      makeTask({ taskId: "c", status: "waiting_external" }),
      makeTask({ taskId: "d", status: "running" }),
      makeTask({ taskId: "e", status: "failed" }),
    ]);

    expect(summary.active).toBe(4);
    expect(summary.terminal).toBe(1);
    expect(summary.byStatus.awaiting_approval).toBe(1);
    expect(summary.byStatus.waiting_external).toBe(1);
  });

  it("shows awaiting_approval in active task snapshots and formats progress detail", () => {
    const task = makeTask({
      status: "awaiting_approval",
      progressSummary: "Waiting for approval from user.",
      lastEventAt: NOW - 100,
    });

    const snapshot = buildTaskStatusSnapshot([task], { now: NOW });
    expect(snapshot.activeCount).toBe(1);
    expect(snapshot.focus?.status).toBe("awaiting_approval");
    expect(formatTaskStatusDetail(task)).toBe("Waiting for approval from user.");
  });

  it("maps intermediate active states to running task flows for now", () => {
    expect(deriveTaskFlowStatusFromTask({ status: "awaiting_approval", terminalOutcome: undefined })).toBe(
      "running",
    );
    expect(deriveTaskFlowStatusFromTask({ status: "waiting_external", terminalOutcome: undefined })).toBe(
      "running",
    );
  });
});
