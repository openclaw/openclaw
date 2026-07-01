import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDurableExecutorOnce } from "./executor.js";
import { createDurableRuntimeRegistry } from "./registry.js";
import { openDurableRuntimeSqliteStore } from "./sqlite-store.js";

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-executor-"));
  const store = openDurableRuntimeSqliteStore({
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

describe("durable runtime executor", () => {
  it("claims a runnable step, runs a handler, records heartbeat, and completes the run", async () => {
    const { store, cleanup } = tempStore();
    try {
      const registry = createDurableRuntimeRegistry();
      registry.registerStepHandler("tool", (context) => {
        context.heartbeat({ phase: "testing" });
        return {
          kind: "succeeded",
          output: { ok: true },
          completeRun: true,
        };
      });
      const run = store.createRun({
        operationKind: "test.runtime",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });
      const step = store.createStep({
        runtimeRunId: run.runtimeRunId,
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
        operationKind: "test.runtime",
        now: () => {
          clock += 10;
          return clock;
        },
      });

      expect(result).toEqual({
        claimed: true,
        runtimeRunId: run.runtimeRunId,
        stepId: step.stepId,
        outcome: "succeeded",
      });
      expect(store.getRun(run.runtimeRunId)).toMatchObject({
        status: "succeeded",
        recoveryState: "terminal",
      });
      expect(store.listSteps(run.runtimeRunId)).toMatchObject([
        {
          stepId: step.stepId,
          status: "succeeded",
          recoveryState: "terminal",
          outputRef: expect.any(String),
        },
      ]);
      expect(store.getTimeline(run.runtimeRunId).map((event) => event.eventType)).toEqual([
        "runtime.step.running",
        "runtime.step.heartbeat",
        "runtime.step.succeeded",
      ]);
    } finally {
      cleanup();
    }
  });

  it("schedules retry timers for retryable handler failures", async () => {
    const { store, cleanup } = tempStore();
    try {
      const registry = createDurableRuntimeRegistry();
      registry.registerStepHandler(
        "tool",
        () => ({
          kind: "failed",
          error: { code: "temporary" },
          retryAfterMs: 500,
        }),
        { sideEffectPolicy: "idempotent" },
      );
      const run = store.createRun({
        operationKind: "test.runtime",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });
      const step = store.createStep({
        runtimeRunId: run.runtimeRunId,
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
        operationKind: "test.runtime",
        now: () => 200,
      });

      expect(result).toMatchObject({ claimed: true, outcome: "failed" });
      expect(store.getRun(run.runtimeRunId)).toMatchObject({
        status: "retry_scheduled",
        recoveryState: "retry_scheduled",
      });
      expect(store.listSteps(run.runtimeRunId)).toMatchObject([
        {
          stepId: step.stepId,
          status: "retry_scheduled",
          recoveryState: "retry_scheduled",
          attempt: 2,
          errorRef: expect.any(String),
        },
      ]);
      expect(store.listTimers(run.runtimeRunId)).toMatchObject([
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

  it("does not let a stale worker complete a step after ownership changes", async () => {
    const { store, cleanup } = tempStore();
    try {
      const registry = createDurableRuntimeRegistry();
      registry.registerStepHandler("tool", (context) => {
        context.store.updateStep({
          runtimeRunId: context.step.runtimeRunId,
          stepId: context.step.stepId,
          claimedBy: "worker-2",
          claimExpiresAt: 1_000,
          now: 300,
        });
        return {
          kind: "succeeded",
          output: { stale: true },
          completeRun: true,
        };
      });
      const run = store.createRun({
        operationKind: "test.runtime",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });
      const step = store.createStep({
        runtimeRunId: run.runtimeRunId,
        stepType: "tool",
        status: "queued",
        recoveryState: "runnable",
        now: 110,
      });

      const result = await runDurableExecutorOnce({
        store,
        registry,
        workerId: "worker-1",
        operationKind: "test.runtime",
        claimTtlMs: 10,
        now: () => 200,
      });

      expect(result).toEqual({
        claimed: true,
        runtimeRunId: run.runtimeRunId,
        stepId: step.stepId,
        outcome: "claim_lost",
      });
      expect(store.getRun(run.runtimeRunId)).toMatchObject({
        status: "running",
        recoveryState: "running",
      });
      expect(store.listSteps(run.runtimeRunId)).toMatchObject([
        {
          stepId: step.stepId,
          status: "running",
          recoveryState: "running",
          claimedBy: "worker-2",
        },
      ]);
      expect(store.getTimeline(run.runtimeRunId).map((event) => event.eventType)).toEqual([
        "runtime.step.running",
        "runtime.step.claim_lost",
      ]);
    } finally {
      cleanup();
    }
  });

  it("blocks automatic retry when side effects are not declared idempotent", async () => {
    const { store, cleanup } = tempStore();
    try {
      const registry = createDurableRuntimeRegistry();
      registry.registerStepHandler("tool", () => ({
        kind: "failed",
        error: { code: "maybe-delivered" },
        retryAfterMs: 500,
      }));
      const run = store.createRun({
        operationKind: "test.runtime",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });
      const step = store.createStep({
        runtimeRunId: run.runtimeRunId,
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
        operationKind: "test.runtime",
        now: () => 200,
      });

      expect(result).toEqual({
        claimed: true,
        runtimeRunId: run.runtimeRunId,
        stepId: step.stepId,
        outcome: "unknown_after_side_effect",
      });
      expect(store.getRun(run.runtimeRunId)).toMatchObject({
        status: "waiting",
        recoveryState: "unknown_after_side_effect",
      });
      expect(store.listTimers(run.runtimeRunId)).toEqual([]);
      expect(store.getTimeline(run.runtimeRunId).map((event) => event.eventType)).toContain(
        "runtime.step.retry_blocked_unknown_side_effect",
      );
    } finally {
      cleanup();
    }
  });

  it("marks unhandled step types as unknown instead of replaying blindly", async () => {
    const { store, cleanup } = tempStore();
    try {
      const registry = createDurableRuntimeRegistry();
      const run = store.createRun({
        operationKind: "test.runtime",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });
      const step = store.createStep({
        runtimeRunId: run.runtimeRunId,
        stepType: "agent",
        status: "queued",
        recoveryState: "runnable",
        now: 110,
      });

      const result = await runDurableExecutorOnce({
        store,
        registry,
        workerId: "worker-1",
        operationKind: "test.runtime",
        now: () => 200,
      });

      expect(result).toEqual({
        claimed: true,
        runtimeRunId: run.runtimeRunId,
        stepId: step.stepId,
        outcome: "no_handler",
      });
      expect(store.getRun(run.runtimeRunId)).toMatchObject({
        status: "waiting",
        recoveryState: "unknown_after_side_effect",
      });
      expect(store.listSteps(run.runtimeRunId)).toMatchObject([
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
