import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { promoteRestartZombieTaskRuns, RESTART_ZOMBIE_TASK_ERROR } from "./restart-drain.js";
import { createRunningTaskRun } from "./task-executor.js";
import { getTaskById, resetTaskRegistryForTests } from "./task-registry.js";

function createRunningCliTask(params: {
  runId: string;
  task: string;
  startedAt: number;
  lastEventAt: number;
}) {
  return createRunningTaskRun({
    runtime: "cli",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    runId: params.runId,
    task: params.task,
    startedAt: params.startedAt,
    lastEventAt: params.lastEventAt,
    deliveryStatus: "pending",
  });
}

describe("restart drain zombie task promotion", () => {
  beforeEach(() => {
    resetTaskRegistryForTests({ persist: false });
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    resetTaskRegistryForTests({ persist: false });
    resetDiagnosticEventsForTest();
  });

  it("promotes only stale running task runs during restart drain", () => {
    const nowMs = 1_000_000;
    const zombie = createRunningCliTask({
      runId: "run-zombie",
      task: "stale cli task",
      startedAt: nowMs - 400_000,
      lastEventAt: nowMs - 301_000,
    });
    const healthy = createRunningCliTask({
      runId: "run-healthy",
      task: "healthy cli task",
      startedAt: nowMs - 30_000,
      lastEventAt: nowMs - 1_000,
    });
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));

    try {
      const promoted = promoteRestartZombieTaskRuns({
        nowMs,
        zombieTtlMs: 300_000,
      });

      expect(promoted.map((entry) => entry.task.taskId)).toEqual([zombie.taskId]);
      expect(getTaskById(zombie.taskId)).toMatchObject({
        status: "failed",
        error: RESTART_ZOMBIE_TASK_ERROR,
        endedAt: nowMs,
        lastEventAt: nowMs,
      });
      expect(getTaskById(healthy.taskId)).toMatchObject({
        status: "running",
        lastEventAt: nowMs - 1_000,
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "task.zombie_promoted",
          taskId: zombie.taskId,
          runId: "run-zombie",
          reason: RESTART_ZOMBIE_TASK_ERROR,
        }),
      );
    } finally {
      stop();
    }
  });
});
