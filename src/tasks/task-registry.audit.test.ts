import { describe, expect, it } from "vitest";
import { listTaskAuditFindings, summarizeTaskAuditFindings } from "./task-registry.audit.js";
import type { TaskRecord } from "./task-registry.types.js";

function createTask(partial: Partial<TaskRecord>): TaskRecord {
  return {
    taskId: partial.taskId ?? "task-1",
    runtime: partial.runtime ?? "acp",
    requesterSessionKey: partial.requesterSessionKey ?? partial.ownerKey ?? "agent:main:main",
    ownerKey: partial.ownerKey ?? partial.requesterSessionKey ?? "agent:main:main",
    scopeKind: partial.scopeKind ?? "session",
    task: partial.task ?? "Background task",
    status: partial.status ?? "queued",
    deliveryStatus: partial.deliveryStatus ?? "pending",
    notifyPolicy: partial.notifyPolicy ?? "done_only",
    createdAt: partial.createdAt ?? Date.parse("2026-03-30T00:00:00.000Z"),
    ...partial,
  };
}

describe("task-registry audit", () => {
  it("flags stale running, lost, and missing cleanup tasks", () => {
    const now = Date.parse("2026-03-30T01:00:00.000Z");
    const findings = listTaskAuditFindings({
      now,
      tasks: [
        createTask({
          taskId: "stale-running",
          status: "running",
          startedAt: now - 40 * 60_000,
          lastEventAt: now - 40 * 60_000,
        }),
        createTask({
          taskId: "lost-task",
          status: "lost",
          error: "backing session missing",
          endedAt: now - 5 * 60_000,
        }),
        createTask({
          taskId: "missing-cleanup",
          status: "failed",
          endedAt: now - 60_000,
          cleanupAfter: undefined,
        }),
      ],
    });

    expect(findings.map((finding) => [finding.code, finding.task.taskId])).toEqual([
      ["lost", "lost-task"],
      ["stale_running", "stale-running"],
      ["missing_cleanup", "missing-cleanup"],
    ]);
  });

  it("summarizes findings by severity and code", () => {
    const summary = summarizeTaskAuditFindings([
      {
        severity: "error",
        code: "stale_running",
        task: createTask({ taskId: "a", status: "running" }),
        detail: "running task appears stuck",
      },
      {
        severity: "warn",
        code: "delivery_failed",
        task: createTask({ taskId: "b", status: "failed" }),
        detail: "terminal update delivery failed",
      },
    ]);

    expect(summary).toEqual({
      total: 2,
      warnings: 1,
      errors: 1,
      byCode: {
        stale_queued: 0,
        stale_running: 1,
        lost: 0,
        delivery_failed: 1,
        missing_cleanup: 0,
        inconsistent_timestamps: 0,
      },
    });
  });

  it("flags inconsistent_timestamps when startedAt predates createdAt", () => {
    // Regression: pi-embedded-runner events can arrive at the registry with
    // evt.ts (used as startedAt) earlier than the wall-clock at registry
    // intake (used as createdAt) due to queue latency.  The registry clamps
    // startedAt >= createdAt so this state should never be persisted, but the
    // audit check itself must remain correct so that genuine ordering bugs are
    // still caught.
    const createdAt = Date.parse("2026-03-30T01:00:00.000Z");
    const startedAt = createdAt - 1; // intentionally earlier than createdAt
    const findings = listTaskAuditFindings({
      now: createdAt + 60_000,
      tasks: [
        createTask({
          taskId: "ts-ordering-bug",
          status: "running",
          createdAt,
          startedAt,
        }),
      ],
    });

    expect(findings.map((f) => [f.code, f.detail])).toEqual([
      ["inconsistent_timestamps", "startedAt is earlier than createdAt"],
    ]);
  });

  it("does not double-report lost tasks as missing cleanup", () => {
    const now = Date.parse("2026-03-30T01:00:00.000Z");
    const findings = listTaskAuditFindings({
      now,
      tasks: [
        createTask({
          taskId: "lost-projected",
          status: "lost",
          endedAt: now - 60_000,
          cleanupAfter: undefined,
        }),
      ],
    });

    expect(findings.map((finding) => finding.code)).toEqual(["lost"]);
  });
});
