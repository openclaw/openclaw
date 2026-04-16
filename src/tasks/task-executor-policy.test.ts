import { describe, expect, it } from "vitest";
import {
  formatTaskBlockedFollowupMessage,
  formatTaskStateChangeMessage,
  formatTaskTerminalMessage,
  formatThreadBoundCompletion,
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
    requesterSessionKey: partial.requesterSessionKey ?? partial.ownerKey ?? "agent:main:main",
    ownerKey: partial.ownerKey ?? partial.requesterSessionKey ?? "agent:main:main",
    scopeKind: partial.scopeKind ?? "session",
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

  it("sanitizes leaked internal runtime context from terminal and progress copy", () => {
    const leaked = [
      "OpenClaw runtime context (internal):",
      "This context is runtime-generated, not user-authored. Keep internal details private.",
      "",
      "[Internal task completion event]",
      "source: subagent",
    ].join("\n");
    const blockedTask = createTask({
      status: "succeeded",
      terminalOutcome: "blocked",
      terminalSummary: leaked,
      runId: "run-1234567890",
      label: leaked,
    });
    const failedTask = createTask({
      status: "failed",
      error: leaked,
      terminalSummary: "Needs manual approval.",
      runId: "run-2234567890",
      label: leaked,
    });
    const progressEvent: TaskEventRecord = {
      at: 10,
      kind: "progress",
      summary: leaked,
    };

    expect(formatTaskTerminalMessage(blockedTask)).toBe(
      "Background task blocked: Background task (run run-1234).",
    );
    expect(formatTaskBlockedFollowupMessage(blockedTask)).toBe(
      "Task needs follow-up: Background task (run run-1234). Task is blocked and needs follow-up.",
    );
    expect(formatTaskTerminalMessage(failedTask)).toBe(
      "Background task failed: Background task (run run-2234). Needs manual approval.",
    );
    expect(formatTaskStateChangeMessage(blockedTask, progressEvent)).toBeNull();
  });

  it("redacts raw exec denial text from blocked task updates", () => {
    const blockedTask = createTask({
      status: "succeeded",
      terminalOutcome: "blocked",
      terminalSummary: "Exec denied (gateway id=req-1, approval-timeout): bash -lc ls",
      runId: "run-1234567890",
      label: "ACP import",
    });

    expect(formatTaskTerminalMessage(blockedTask)).toBe(
      "Background task blocked: ACP import (run run-1234). Command did not run: approval timed out.",
    );
    expect(formatTaskBlockedFollowupMessage(blockedTask)).toBe(
      "Task needs follow-up: ACP import (run run-1234). Command did not run: approval timed out.",
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

  describe("formatThreadBoundCompletion", () => {
    it("returns null for plain succeeded tasks with no summary", () => {
      // The parent stream relay already delivered the final reply into the
      // thread; no additional banner is useful.
      expect(
        formatThreadBoundCompletion(createTask({ status: "succeeded", runId: "run-xxxxxxxx" })),
      ).toBeNull();
    });

    it("preserves meaningful summaries without the Background task done prefix", () => {
      const summary = "Merged branch feat/x and pushed origin/main.";
      expect(
        formatThreadBoundCompletion(
          createTask({
            status: "succeeded",
            terminalSummary: summary,
            runId: "run-aaaaaaaa",
          }),
        ),
      ).toBe(summary);
    });

    it("routes blocked outcomes through the full terminal formatter", () => {
      // Blocked MUST surface visibly — the compact formatter delegates to the
      // verbose one so the operator sees the blocked-banner unchanged.
      const task = createTask({
        status: "succeeded",
        terminalOutcome: "blocked",
        terminalSummary: "Needs login.",
        runId: "run-1234567890",
        label: "ACP import",
      });
      expect(formatThreadBoundCompletion(task)).toBe(
        "Background task blocked: ACP import (run run-1234). Needs login.",
      );
    });

    it("routes failures through the full terminal formatter", () => {
      const task = createTask({
        status: "failed",
        error: "Permission denied.",
        runId: "run-bbbbbbbb",
        label: "ACP import",
      });
      expect(formatThreadBoundCompletion(task)).toBe(
        "Background task failed: ACP import (run run-bbbb). Permission denied.",
      );
    });

    it("routes timed_out through the full terminal formatter", () => {
      const task = createTask({
        status: "timed_out",
        runId: "run-cccccccc",
        label: "ACP import",
      });
      expect(formatThreadBoundCompletion(task)).toBe(
        "Background task timed out: ACP import (run run-cccc).",
      );
    });

    it("routes cancelled through the full terminal formatter", () => {
      const task = createTask({
        status: "cancelled",
        runId: "run-dddddddd",
        label: "ACP import",
      });
      expect(formatThreadBoundCompletion(task)).toBe(
        "Background task cancelled: ACP import (run run-dddd).",
      );
    });

    it("routes lost through the full terminal formatter", () => {
      const task = createTask({
        status: "lost",
        error: "Gateway unreachable.",
        runId: "run-eeeeeeee",
        label: "ACP import",
      });
      expect(formatThreadBoundCompletion(task)).toBe(
        "Background task lost: ACP import (run run-eeee). Gateway unreachable.",
      );
    });

    it("returns null for non-terminal statuses defensively", () => {
      expect(formatThreadBoundCompletion(createTask({ status: "running" }))).toBeNull();
      expect(formatThreadBoundCompletion(createTask({ status: "queued" }))).toBeNull();
    });
  });

  describe("shouldAutoDeliverTaskTerminalUpdate silent + thread-bound", () => {
    it("suppresses silent succeeded tasks with no summary", () => {
      expect(
        shouldAutoDeliverTaskTerminalUpdate(
          createTask({
            runtime: "acp",
            status: "succeeded",
            deliveryStatus: "pending",
            notifyPolicy: "silent",
          }),
        ),
      ).toBe(false);
    });

    it("allows silent failures so the operator still sees the failure banner", () => {
      expect(
        shouldAutoDeliverTaskTerminalUpdate(
          createTask({
            runtime: "acp",
            status: "failed",
            error: "Disk full.",
            deliveryStatus: "pending",
            notifyPolicy: "silent",
          }),
        ),
      ).toBe(true);
    });

    it("allows silent blocked outcomes", () => {
      expect(
        shouldAutoDeliverTaskTerminalUpdate(
          createTask({
            runtime: "acp",
            status: "succeeded",
            terminalOutcome: "blocked",
            terminalSummary: "Needs login.",
            deliveryStatus: "pending",
            notifyPolicy: "silent",
          }),
        ),
      ).toBe(true);
    });

    it("allows silent succeeded with meaningful summary", () => {
      expect(
        shouldAutoDeliverTaskTerminalUpdate(
          createTask({
            runtime: "acp",
            status: "succeeded",
            terminalSummary: "Shipped to prod.",
            deliveryStatus: "pending",
            notifyPolicy: "silent",
          }),
        ),
      ).toBe(true);
    });

    it("still suppresses silent subagent tasks", () => {
      expect(
        shouldAutoDeliverTaskTerminalUpdate(
          createTask({
            runtime: "subagent",
            status: "succeeded",
            deliveryStatus: "pending",
            notifyPolicy: "silent",
          }),
        ),
      ).toBe(false);
    });
  });
});
