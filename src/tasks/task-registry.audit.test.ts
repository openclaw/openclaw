// Covers task registry audit summaries used for maintenance diagnostics.
import { describe, expect, it } from "vitest";
import { normalizeTaskTimestamps } from "./task-registry-records.js";
import {
  listTaskAuditFindings,
  summarizeRetainedLostTaskAuditFindings,
  summarizeTaskAuditFindings,
} from "./task-registry.audit.js";
import { summarizeFullTaskInspection } from "./task-registry.audit.test-support.js";
import {
  addTaskStatusSummaryRecord,
  createEmptyTaskStatusSummary,
} from "./task-registry.summary.js";
import type { TaskRecord } from "./task-registry.types.js";

const DEFAULT_TASK_RETENTION_MS = 7 * 24 * 60 * 60_000;
const LOST_TASK_RETENTION_MS = 24 * 60 * 60_000;

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

  it("downgrades retained lost tasks with future cleanupAfter to warnings", () => {
    const now = Date.parse("2026-03-30T01:00:00.000Z");
    const findings = listTaskAuditFindings({
      now,
      tasks: [
        createTask({
          taskId: "lost-retained",
          status: "lost",
          error: "backing session missing",
          endedAt: now - 60_000,
          lastEventAt: now - 60_000,
          cleanupAfter: now + 60_000,
        }),
        createTask({
          taskId: "lost-expired",
          status: "lost",
          error: "backing session missing",
          endedAt: now - 120_000,
          lastEventAt: now - 120_000,
          cleanupAfter: now - 1,
        }),
      ],
    });

    expect(
      findings.map((finding) => [finding.task.taskId, finding.code, finding.severity]),
    ).toEqual([
      ["lost-expired", "lost", "error"],
      ["lost-retained", "lost", "warn"],
    ]);
  });

  it("reports future-retained lost tasks alongside full audit counts", () => {
    const now = Date.parse("2026-03-30T01:00:00.000Z");
    const nextCleanupAfter = now + 60_000;
    const findings = listTaskAuditFindings({
      now,
      tasks: [
        createTask({
          taskId: "lost-retained",
          status: "lost",
          endedAt: now - 60_000,
          cleanupAfter: nextCleanupAfter,
        }),
        createTask({
          taskId: "lost-expired",
          status: "lost",
          endedAt: now - 120_000,
          cleanupAfter: now - 1,
        }),
      ],
    });

    expect(summarizeTaskAuditFindings(findings)).toEqual({
      total: 2,
      warnings: 1,
      errors: 1,
      byCode: {
        stale_queued: 0,
        stale_running: 0,
        lost: 2,
        delivery_failed: 0,
        missing_cleanup: 0,
        inconsistent_timestamps: 0,
      },
    });
    expect(summarizeRetainedLostTaskAuditFindings(findings, { now })).toEqual({
      count: 1,
      nextCleanupAfter,
    });
  });

  it("treats old seven-day lost cleanupAfter values as expired after the lost window", () => {
    const now = Date.parse("2026-03-30T01:00:00.000Z");
    const endedAt = now - LOST_TASK_RETENTION_MS - 1;
    const findings = listTaskAuditFindings({
      now,
      tasks: [
        createTask({
          taskId: "lost-old-retention",
          status: "lost",
          endedAt,
          cleanupAfter: endedAt + DEFAULT_TASK_RETENTION_MS,
        }),
      ],
    });

    expect(summarizeTaskAuditFindings(findings).errors).toBe(1);
    expect(summarizeRetainedLostTaskAuditFindings(findings, { now })).toEqual({ count: 0 });
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

  it("flags terminal cron history that is missing cleanup", () => {
    const findings = listTaskAuditFindings({
      tasks: [
        createTask({
          taskId: "cron-history",
          runtime: "cron",
          status: "succeeded",
          endedAt: Date.now() - 60_000,
          cleanupAfter: undefined,
        }),
      ],
    });

    expect(findings.map((finding) => finding.code)).toEqual(["missing_cleanup"]);
  });

  it("folds normalized metadata with full-inspection parity at audit and retention boundaries", () => {
    const now = Date.parse("2026-03-30T01:00:00.000Z");
    const rawTasks = [
      createTask({ status: "queued", lastEventAt: now - 10 * 60_000 }),
      createTask({ status: "running", lastEventAt: now - 30 * 60_000 + 1 }),
      createTask({
        status: "running",
        lastEventAt: now - 40 * 60_000,
        endedAt: now - 35 * 60_000,
      }),
      createTask({
        status: "lost",
        endedAt: now - 60_000,
        cleanupAfter: now + 120_000,
        deliveryStatus: "failed",
      }),
      createTask({
        status: "lost",
        lastEventAt: now - 60_000,
        cleanupAfter: now + 60_000,
      }),
      createTask({
        status: "lost",
        endedAt: now - LOST_TASK_RETENTION_MS,
        cleanupAfter: now + DEFAULT_TASK_RETENTION_MS,
      }),
      createTask({ status: "lost", endedAt: now - 60_000, cleanupAfter: undefined }),
      createTask({ runtime: "cli", status: "failed", endedAt: now - 60_000 }),
      createTask({
        runtime: "cron",
        status: "succeeded",
        deliveryStatus: "failed",
        notifyPolicy: "silent",
        cleanupAfter: now + 60_000,
      }),
      createTask({
        runtime: "subagent",
        status: "timed_out",
        startedAt: now - 120_000,
        endedAt: now - 180_000,
        cleanupAfter: now + 60_000,
      }),
    ];
    const summary = createEmptyTaskStatusSummary();
    for (const task of rawTasks) {
      addTaskStatusSummaryRecord(
        summary,
        normalizeTaskTimestamps({
          runtime: task.runtime,
          status: task.status,
          deliveryStatus: task.deliveryStatus,
          notifyPolicy: task.notifyPolicy,
          createdAt: task.createdAt,
          startedAt: task.startedAt,
          endedAt: task.endedAt,
          lastEventAt: task.lastEventAt,
          cleanupAfter: task.cleanupAfter,
        }),
        now,
      );
    }

    expect(summary.tasks).toEqual({
      total: 10,
      active: 3,
      terminal: 7,
      failures: 4,
      byStatus: {
        queued: 1,
        running: 2,
        succeeded: 1,
        failed: 1,
        timed_out: 1,
        cancelled: 0,
        lost: 4,
      },
      byRuntime: { acp: 7, cli: 1, cron: 1, subagent: 1 },
    });
    expect(summary.taskAudit).toEqual({
      total: 7,
      warnings: 4,
      errors: 3,
      byCode: {
        stale_queued: 1,
        stale_running: 1,
        lost: 2,
        delivery_failed: 1,
        missing_cleanup: 1,
        inconsistent_timestamps: 1,
      },
    });
    expect(summary.taskAuditRetainedLost).toEqual({
      count: 2,
      nextCleanupAfter: now + 60_000,
    });

    expect(summary).toEqual(
      summarizeFullTaskInspection(rawTasks.map(normalizeTaskTimestamps), now),
    );
  });
});
