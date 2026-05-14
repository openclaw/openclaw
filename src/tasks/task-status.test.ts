import { describe, expect, it } from "vitest";
import type { TaskRecord } from "./task-registry.types.js";
import {
  buildTaskStatusSnapshot,
  formatTaskStatusDetail,
  formatTaskStatusTitle,
} from "./task-status.js";

const NOW = 1_000_000_000_000;

function makeTask(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    taskId: "task-1",
    runId: "run-1",
    task: "default task",
    runtime: "subagent",
    status: "running",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    createdAt: NOW - 1_000,
    deliveryStatus: "pending",
    notifyPolicy: "done_only",
    ...overrides,
  };
}

describe("task status snapshot", () => {
  it("keeps old active tasks active without maintenance reconciliation", () => {
    const staleButActive = makeTask({
      createdAt: NOW - 10 * 60_000,
      startedAt: NOW - 10 * 60_000,
      lastEventAt: NOW - 10 * 60_000,
      progressSummary: "still running",
    });

    const snapshot = buildTaskStatusSnapshot([staleButActive], { now: NOW });

    expect(snapshot.activeCount).toBe(1);
    expect(snapshot.recentFailureCount).toBe(0);
    expect(snapshot.focus?.status).toBe("running");
    expect(snapshot.focus?.taskId).toBe("task-1");
  });

  it("filters tasks whose cleanupAfter has expired", () => {
    const expired = makeTask({
      status: "succeeded",
      endedAt: NOW - 60_000,
      cleanupAfter: NOW - 1,
    });

    const snapshot = buildTaskStatusSnapshot([expired], { now: NOW });

    expect(snapshot.totalCount).toBe(0);
    expect(snapshot.focus).toBeUndefined();
  });
});

describe("task status formatting", () => {
  it("truncates long task titles and details", () => {
    const task = makeTask({
      task: "This is a deliberately long task prompt that should never be emitted in full because it may include internal instructions and file paths.",
      progressSummary:
        "This progress detail is also intentionally long so the status line proves it truncates verbose task context instead of dumping a wall of text.",
    });

    expect(formatTaskStatusTitle(task)).toContain(
      "This is a deliberately long task prompt that should never be emitted in full",
    );
    expect(formatTaskStatusTitle(task).endsWith("…")).toBe(true);
    expect(formatTaskStatusDetail(task)).toContain(
      "This progress detail is also intentionally long so the status line proves it truncates verbose task context",
    );
    expect(formatTaskStatusDetail(task)?.endsWith("…")).toBe(true);
  });
});
