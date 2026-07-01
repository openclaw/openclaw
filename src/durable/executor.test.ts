import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDurableExecutorOnce } from "./executor.js";
import { createDurableWorkflowRegistry } from "./registry.js";
import { openDurableWorkflowSqliteStore } from "./sqlite-store.js";

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-executor-"));
  const store = openDurableWorkflowSqliteStore({
    path: path.join(dir, "openclaw.sqlite"),
  });
  return {
    store,
    cleanup: () => {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("durable workflow executor", () => {
  it("claims a runnable step, runs a handler, records heartbeat, and completes the run", async () => {
    const { store, cleanup } = tempStore();
    try {
      const registry = createDurableWorkflowRegistry();
      registry.registerStepHandler("tool", (context) => {
        context.heartbeat({ phase: "testing" });
        return {
          kind: "succeeded",
          output: { ok: true },
          completeRun: true,
        };
      });
      const run = store.createRun({
        workflowId: "test.workflow",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });
      const step = store.createStep({
        workflowRunId: run.workflowRunId,
        stepType: "tool",
        status: "queued",
        recoveryState: "runnable",
        now: 110,
      });
      let clock = 120;

      const result = await runDurableExecutorOnce({
        store,
        registry,
        workerId: "worker-1",
        workflowId: "test.workflow",
        now: () => {
          clock += 10;
          return clock;
        },
      });

      expect(result).toEqual({
        claimed: true,
        workflowRunId: run.workflowRunId,
        stepId: step.stepId,
        outcome: "succeeded",
      });
      expect(store.getRun(run.workflowRunId)).toMatchObject({
        status: "succeeded",
        recoveryState: "terminal",
      });
      expect(store.listSteps(run.workflowRunId)).toMatchObject([
        {
          stepId: step.stepId,
          status: "succeeded",
          recoveryState: "terminal",
          outputRef: expect.any(String),
        },
      ]);
      expect(store.getTimeline(run.workflowRunId).map((event) => event.eventType)).toEqual([
        "workflow.step.running",
        "workflow.step.heartbeat",
        "workflow.step.succeeded",
      ]);
    } finally {
      cleanup();
    }
  });

  it("schedules retry timers for retryable handler failures", async () => {
    const { store, cleanup } = tempStore();
    try {
      const registry = createDurableWorkflowRegistry();
      registry.registerStepHandler("tool", () => ({
        kind: "failed",
        error: { code: "temporary" },
        retryAfterMs: 500,
      }));
      const run = store.createRun({
        workflowId: "test.workflow",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });
      const step = store.createStep({
        workflowRunId: run.workflowRunId,
        stepType: "tool",
        status: "queued",
        recoveryState: "runnable",
        maxAttempts: 3,
        now: 110,
      });

      const result = await runDurableExecutorOnce({
        store,
        registry,
        workerId: "worker-1",
        workflowId: "test.workflow",
        now: () => 200,
      });

      expect(result).toMatchObject({ claimed: true, outcome: "failed" });
      expect(store.getRun(run.workflowRunId)).toMatchObject({
        status: "retry_scheduled",
        recoveryState: "retry_scheduled",
      });
      expect(store.listSteps(run.workflowRunId)).toMatchObject([
        {
          stepId: step.stepId,
          status: "retry_scheduled",
          recoveryState: "retry_scheduled",
          attempt: 2,
          errorRef: expect.any(String),
        },
      ]);
      expect(store.listTimers(run.workflowRunId)).toMatchObject([
        {
          timerType: "retry",
          dueAt: 700,
          status: "pending",
          stepId: step.stepId,
        },
      ]);
    } finally {
      cleanup();
    }
  });

  it("marks unhandled step types as unknown instead of replaying blindly", async () => {
    const { store, cleanup } = tempStore();
    try {
      const registry = createDurableWorkflowRegistry();
      const run = store.createRun({
        workflowId: "test.workflow",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });
      const step = store.createStep({
        workflowRunId: run.workflowRunId,
        stepType: "agent",
        status: "queued",
        recoveryState: "runnable",
        now: 110,
      });

      const result = await runDurableExecutorOnce({
        store,
        registry,
        workerId: "worker-1",
        workflowId: "test.workflow",
        now: () => 200,
      });

      expect(result).toEqual({
        claimed: true,
        workflowRunId: run.workflowRunId,
        stepId: step.stepId,
        outcome: "no_handler",
      });
      expect(store.getRun(run.workflowRunId)).toMatchObject({
        status: "waiting",
        recoveryState: "unknown_after_side_effect",
      });
      expect(store.listSteps(run.workflowRunId)).toMatchObject([
        {
          stepId: step.stepId,
          status: "waiting",
          recoveryState: "unknown_after_side_effect",
        },
      ]);
    } finally {
      cleanup();
    }
  });
});
