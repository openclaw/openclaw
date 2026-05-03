import { describe, expect, it } from "vitest";
import type { TaskRecord } from "./task-registry.types.js";
import {
  buildTaskOperationalSummary,
  buildTaskLifecycleEvent,
  buildTaskStatusSnapshot,
  formatTaskLifecycleEvent,
  formatTaskOperationalSummary,
  formatTaskStatusDetail,
  formatTaskStatusTitle,
  sanitizeTaskStatusText,
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

  it("strips leaked internal runtime context from task details", () => {
    const task = makeTask({
      status: "failed",
      error: [
        "OpenClaw runtime context (internal):",
        "This context is runtime-generated, not user-authored. Keep internal details private.",
        "",
        "[Internal task completion event]",
        "source: subagent",
      ].join("\n"),
    });

    expect(formatTaskStatusDetail(task)).toBeUndefined();
  });

  it("sanitizes task titles before truncation", () => {
    const task = makeTask({
      task: [
        "OpenClaw runtime context (internal):",
        "This context is runtime-generated, not user-authored. Keep internal details private.",
        "",
        "[Internal task completion event]",
        "source: subagent",
      ].join("\n"),
    });

    expect(formatTaskStatusTitle(task)).toBe("Background task");
  });

  it("falls back to sanitized terminal summary when the error strips empty", () => {
    const task = makeTask({
      status: "failed",
      error: [
        "OpenClaw runtime context (internal):",
        "This context is runtime-generated, not user-authored. Keep internal details private.",
        "",
        "[Internal task completion event]",
        "source: subagent",
      ].join("\n"),
      terminalSummary: "Needs login approval.",
    });

    expect(formatTaskStatusDetail(task)).toBe("Needs login approval.");
  });

  it("redacts raw exec denial detail from terminal task status", () => {
    const task = makeTask({
      status: "succeeded",
      terminalOutcome: "blocked",
      terminalSummary: "Exec denied (gateway id=req-1, approval-timeout): bash -lc ls",
    });

    expect(formatTaskStatusDetail(task)).toBe("Command did not run: approval timed out.");
  });

  it("sanitizes free-form task status text for reuse in other surfaces", () => {
    expect(
      sanitizeTaskStatusText(
        [
          "OpenClaw runtime context (internal):",
          "This context is runtime-generated, not user-authored. Keep internal details private.",
          "",
          "[Internal task completion event]",
          "source: subagent",
        ].join("\n"),
      ),
    ).toBe("");
  });

  it("builds a blocked operational summary for approval waits", () => {
    const task = makeTask({
      status: "awaiting_approval",
      progressSummary: "patch applied",
    });

    expect(buildTaskOperationalSummary(task)).toMatchObject({
      state: "blocked",
      stage: "awaiting approval",
      lastGoodStep: "patch applied",
      blocker: "approval required",
      nextAction: "approve and continue",
    });
    expect(formatTaskOperationalSummary(task)).toBe(
      "blocked · awaiting approval · last good step: patch applied · blocker: approval required · next: approve and continue",
    );
  });

  it("builds an active operational summary for running work", () => {
    const task = makeTask({
      status: "running",
      progressSummary: "tests running",
    });

    expect(formatTaskOperationalSummary(task)).toBe(
      "active · running · last good step: tests running · next: wait for completion",
    );
  });
});

describe("task lifecycle events", () => {
  it("builds a task.created event for queued tasks", () => {
    const task = makeTask({ status: "queued" });
    const event = buildTaskLifecycleEvent(task, "queued");

    expect(event.event).toBe("task.created");
    expect(event.state).toBe("active");
    expect(event.stage).toBe("queued");
    expect(event.fromStatus).toBe("queued");
    expect(event.nextAction).toBe("wait for start");
  });

  it("builds a task.started event when transitioning from queued to running", () => {
    const task = makeTask({ status: "running", progressSummary: "initializing" });
    const event = buildTaskLifecycleEvent(task, "queued");

    expect(event.event).toBe("task.started");
    expect(event.state).toBe("active");
    expect(event.fromStatus).toBe("queued");
    expect(event.summary).toContain("initializing");
  });

  it("builds a task.blocked event for awaiting_approval", () => {
    const task = makeTask({
      status: "awaiting_approval",
      progressSummary: "patch applied",
    });
    const event = buildTaskLifecycleEvent(task, "running");

    expect(event.event).toBe("task.blocked");
    expect(event.state).toBe("blocked");
    expect(event.blocker).toBe("approval required");
    expect(event.nextAction).toBe("approve and continue");
  });

  it("builds a task.blocked event for waiting_external", () => {
    const task = makeTask({
      status: "waiting_external",
      progressSummary: "awaiting user input",
    });
    const event = buildTaskLifecycleEvent(task, "running");

    expect(event.event).toBe("task.blocked");
    expect(event.state).toBe("blocked");
    expect(event.blocker).toBe("external dependency");
  });

  it("builds a task.completed event for succeeded tasks", () => {
    const task = makeTask({
      status: "succeeded",
      terminalSummary: "All tests passed",
    });
    const event = buildTaskLifecycleEvent(task, "running");

    expect(event.event).toBe("task.completed");
    expect(event.state).toBe("finished");
    expect(event.summary).toContain("All tests passed");
  });

  it("builds a task.failed event for failed tasks", () => {
    const task = makeTask({
      status: "failed",
      error: "AssertionError: expected 2 to equal 3",
    });
    const event = buildTaskLifecycleEvent(task, "running");

    expect(event.event).toBe("task.failed");
    expect(event.state).toBe("failed");
    expect(event.blocker).toContain("AssertionError");
  });

  it("builds a task.cancelled event for cancelled tasks", () => {
    const task = makeTask({ status: "cancelled" });
    const event = buildTaskLifecycleEvent(task, "running");

    expect(event.event).toBe("task.cancelled");
    expect(event.state).toBe("cancelled");
    expect(event.stage).toBe("cancelled");
  });

  it("omits fromStatus when previous status is not provided", () => {
    const task = makeTask({ status: "running" });
    const event = buildTaskLifecycleEvent(task);

    expect(event.event).toBe("task.started");
    expect(event.fromStatus).toBeUndefined();
  });

  it("formats a lifecycle event as a compact string", () => {
    const task = makeTask({
      status: "running",
      progressSummary: "fetching data",
    });
    const event = buildTaskLifecycleEvent(task, "queued");
    const formatted = formatTaskLifecycleEvent(event);

    expect(formatted).toContain("active");
    expect(formatted).toContain("running");
    expect(formatted).toContain("from: queued");
    expect(formatted).toContain("fetching data");
  });

  it("formats a blocked lifecycle event compactly", () => {
    const task = makeTask({
      status: "awaiting_approval",
      progressSummary: "waiting for approval",
    });
    const event = buildTaskLifecycleEvent(task, "running");
    const formatted = formatTaskLifecycleEvent(event);

    expect(formatted).toContain("blocked");
    expect(formatted).toContain("awaiting approval");
    expect(formatted).toContain("blocker: approval required");
    expect(formatted).toContain("next: approve and continue");
  });

  it("includes updatedAt when lastEventAt is set", () => {
    const task = makeTask({
      status: "succeeded",
      lastEventAt: NOW,
    });
    const event = buildTaskLifecycleEvent(task, "running");

    expect(event.updatedAt).toBe(NOW);
  });

  it("omits updatedAt when lastEventAt is not set", () => {
    const task = makeTask({
      status: "queued",
      createdAt: NOW,
    });
    const event = buildTaskLifecycleEvent(task);

    expect(event.updatedAt).toBeUndefined();
  });

  it("strips 'no action' from formatted output", () => {
    const task = makeTask({ status: "succeeded" });
    const event = buildTaskLifecycleEvent(task);
    const formatted = formatTaskLifecycleEvent(event);

    expect(formatted).not.toContain("no action");
  });
});
