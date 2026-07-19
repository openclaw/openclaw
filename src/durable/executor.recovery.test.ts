import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { reconcileExpiredDurableStepClaims, runDurableExecutorOnce } from "./executor.js";
import { createDurableRuntimeRegistry } from "./registry.js";
import { openDurableRuntimeSqliteStore } from "./sqlite-store.js";

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-executor-recovery-"));
  const storePath = path.join(dir, "openclaw.sqlite");
  const store = openDurableRuntimeSqliteStore({ path: storePath });
  return {
    store,
    cleanup: () => {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function createTestRegistry() {
  const registry = createDurableRuntimeRegistry();
  registry.registerRuntime({
    operationKind: "test.runtime",
    version: "1",
    stepTypes: ["agent", "tool"],
  });
  return registry;
}

describe("durable runtime executor recovery", () => {
  it("rolls back a partial settlement and safely requeues an idempotent expired claim", async () => {
    const { store, cleanup } = tempStore();
    try {
      const registry = createTestRegistry();
      registry.registerStepHandler(
        "test.runtime",
        "tool",
        () => ({ kind: "succeeded", output: { ok: true }, completeRun: true }),
        { sideEffectPolicy: "idempotent" },
      );
      const run = store.createRun({
        operationKind: "test.runtime",
        rootOperationReason: "settlement_rollback_test",
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
      const appendEvent = store.appendEvent.bind(store);
      store.appendEvent = (input) => {
        if (input.eventType === "runtime.step.succeeded") {
          throw new Error("injected settlement event failure");
        }
        return appendEvent(input);
      };

      await expect(
        runDurableExecutorOnce({
          store,
          registry,
          workerId: "worker-1",
          operationKind: "test.runtime",
          claimTtlMs: 10,
          now: () => 200,
        }),
      ).rejects.toThrow("injected settlement event failure");
      expect(store.getRun(run.runtimeRunId)).toMatchObject({
        status: "running",
        recoveryState: "running",
      });
      expect(store.listSteps(run.runtimeRunId)).toEqual([
        expect.objectContaining({
          stepId: step.stepId,
          status: "running",
          recoveryState: "running",
        }),
      ]);
      expect(store.listSteps(run.runtimeRunId)[0]?.outputRef).toBeUndefined();
      expect(store.listRefs(run.runtimeRunId)).toEqual([]);
      expect(store.getTimeline(run.runtimeRunId).map((event) => event.eventType)).toEqual([
        "runtime.step.running",
      ]);

      store.appendEvent = appendEvent;
      expect(
        reconcileExpiredDurableStepClaims({
          store,
          registry,
          operationKind: "test.runtime",
          now: 211,
        }),
      ).toMatchObject({ scanned: 1, requeued: 1, unknownAfterSideEffect: 0 });
      await expect(
        runDurableExecutorOnce({
          store,
          registry,
          workerId: "worker-2",
          operationKind: "test.runtime",
          now: () => 220,
        }),
      ).resolves.toMatchObject({ claimed: true, outcome: "succeeded" });
      expect(store.getRun(run.runtimeRunId)).toMatchObject({
        status: "succeeded",
        recoveryState: "terminal",
      });
    } finally {
      cleanup();
    }
  });

  it("turns an expired uncertain claim into owner-visible uncertainty without replay", () => {
    const { store, cleanup } = tempStore();
    try {
      const registry = createTestRegistry();
      registry.registerStepHandler("test.runtime", "tool", () => ({
        kind: "succeeded",
        completeRun: true,
      }));
      const run = store.createRun({
        operationKind: "test.runtime",
        rootOperationReason: "expired_uncertain_claim_test",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });
      const step = store.createStep({
        runtimeRunId: run.runtimeRunId,
        stepType: "tool",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });
      const claim = store.claimNextRunnableStep({
        operationKind: "test.runtime",
        operationVersion: "1",
        workerId: "worker-1",
        claimTtlMs: 10,
        now: 110,
      });
      expect(claim).toMatchObject({ stepId: step.stepId });
      expect(
        store.updateStep({
          runtimeRunId: run.runtimeRunId,
          stepId: step.stepId,
          expectedClaimedBy: claim!.claimedBy,
          status: "running",
          recoveryState: "running",
          now: 115,
        }),
      ).toBeDefined();

      expect(
        reconcileExpiredDurableStepClaims({
          store,
          registry,
          operationKind: "test.runtime",
          now: 121,
        }),
      ).toMatchObject({ scanned: 1, requeued: 0, unknownAfterSideEffect: 1 });
      expect(store.getRun(run.runtimeRunId)).toMatchObject({
        status: "waiting",
        recoveryState: "unknown_after_side_effect",
      });
      expect(store.listSteps(run.runtimeRunId)).toEqual([
        expect.objectContaining({
          stepId: step.stepId,
          status: "waiting",
          recoveryState: "unknown_after_side_effect",
        }),
      ]);
      expect(store.listSteps(run.runtimeRunId)[0]?.claimedBy).toBeUndefined();
      expect(store.listUnresolvedUncertaintyFacts()).toEqual([
        expect.objectContaining({
          sourceRunId: run.runtimeRunId,
          stepId: step.stepId,
          kind: "unknown_after_side_effect",
        }),
      ]);
      expect(store.listWakeObligations()).toEqual([
        expect.objectContaining({ reason: "side_effect_uncertain", status: "pending" }),
      ]);
    } finally {
      cleanup();
    }
  });

  it("requires an owner decision when an expired claim has no registered handler", () => {
    const { store, cleanup } = tempStore();
    try {
      const registry = createTestRegistry();
      const run = store.createRun({
        operationKind: "test.runtime",
        rootOperationReason: "expired_no_handler_test",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });
      const step = store.createStep({
        runtimeRunId: run.runtimeRunId,
        stepType: "agent",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });
      const claim = store.claimNextRunnableStep({
        operationKind: "test.runtime",
        operationVersion: "1",
        workerId: "worker-1",
        claimTtlMs: 10,
        now: 100,
      });
      expect(
        store.updateStep({
          runtimeRunId: run.runtimeRunId,
          stepId: step.stepId,
          expectedClaimedBy: claim!.claimedBy!,
          status: "running",
          recoveryState: "running",
          now: 105,
        }),
      ).toBeDefined();

      expect(
        reconcileExpiredDurableStepClaims({
          store,
          registry,
          operationKind: "test.runtime",
          now: 111,
        }),
      ).toMatchObject({ scanned: 1, requiresOwnerDecision: 1 });
      expect(store.getRun(run.runtimeRunId)).toMatchObject({
        status: "blocked",
        recoveryState: "requires_owner_decision",
      });
      expect(store.listUnresolvedUncertaintyFacts()).toEqual([
        expect.objectContaining({ kind: "requires_owner_decision", stepId: step.stepId }),
      ]);
      expect(store.listWakeObligations()).toEqual([
        expect.objectContaining({ reason: "no_handler", status: "pending" }),
      ]);
    } finally {
      cleanup();
    }
  });

  it("does not claim an unregistered operation or borrow another operation handler", async () => {
    const { store, cleanup } = tempStore();
    try {
      const registry = createDurableRuntimeRegistry();
      registry.registerRuntime({ operationKind: "test.first", version: "1" });
      registry.registerRuntime({ operationKind: "test.second", version: "1" });
      const firstHandler = vi.fn(() => ({ kind: "succeeded" as const, completeRun: true }));
      registry.registerStepHandler("test.first", "tool", firstHandler, {
        sideEffectPolicy: "none",
      });
      const secondRun = store.createRun({
        operationKind: "test.second",
        rootOperationReason: "operation_scope_test",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });
      const secondStep = store.createStep({
        runtimeRunId: secondRun.runtimeRunId,
        stepType: "tool",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });

      await expect(
        runDurableExecutorOnce({
          store,
          registry,
          workerId: "worker-second",
          operationKind: "test.second",
          now: () => 110,
        }),
      ).resolves.toMatchObject({ claimed: true, outcome: "no_handler" });
      expect(firstHandler).not.toHaveBeenCalled();
      expect(store.listSteps(secondRun.runtimeRunId)).toEqual([
        expect.objectContaining({
          stepId: secondStep.stepId,
          recoveryState: "requires_owner_decision",
        }),
      ]);

      const unregisteredRun = store.createRun({
        operationKind: "test.unregistered",
        rootOperationReason: "operation_scope_test",
        status: "queued",
        recoveryState: "runnable",
        now: 200,
      });
      const unregisteredStep = store.createStep({
        runtimeRunId: unregisteredRun.runtimeRunId,
        stepType: "tool",
        status: "queued",
        recoveryState: "runnable",
        now: 200,
      });
      await expect(
        runDurableExecutorOnce({
          store,
          registry,
          workerId: "worker-unregistered",
          operationKind: "test.unregistered",
          now: () => 210,
        }),
      ).rejects.toThrow("operation is not registered");
      expect(store.listSteps(unregisteredRun.runtimeRunId)).toEqual([
        expect.objectContaining({
          stepId: unregisteredStep.stepId,
          status: "queued",
          recoveryState: "runnable",
        }),
      ]);
      expect(store.listSteps(unregisteredRun.runtimeRunId)[0]?.claimedBy).toBeUndefined();
      expect(store.getTimeline(unregisteredRun.runtimeRunId)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("supports an immediate idempotent retry without losing the zero delay", async () => {
    const { store, cleanup } = tempStore();
    try {
      const registry = createTestRegistry();
      registry.registerStepHandler(
        "test.runtime",
        "tool",
        () => ({ kind: "failed", retryAfterMs: 0 }),
        { sideEffectPolicy: "idempotent" },
      );
      const run = store.createRun({
        operationKind: "test.runtime",
        rootOperationReason: "immediate_retry_test",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });
      const step = store.createStep({
        runtimeRunId: run.runtimeRunId,
        stepType: "tool",
        status: "queued",
        recoveryState: "runnable",
        maxAttempts: 2,
        now: 100,
      });

      await expect(
        runDurableExecutorOnce({
          store,
          registry,
          workerId: "worker",
          operationKind: "test.runtime",
          now: () => 200,
        }),
      ).resolves.toMatchObject({ claimed: true, outcome: "failed" });
      expect(store.listSteps(run.runtimeRunId)).toEqual([
        expect.objectContaining({ stepId: step.stepId, status: "retry_scheduled", attempt: 2 }),
      ]);
      expect(store.listTimers(run.runtimeRunId)).toEqual([
        expect.objectContaining({ timerType: "retry", dueAt: 200, status: "pending" }),
      ]);
    } finally {
      cleanup();
    }
  });

  it("returns a non-terminal failed step to owner-scheduled run state", async () => {
    const { store, cleanup } = tempStore();
    try {
      const registry = createTestRegistry();
      registry.registerStepHandler("test.runtime", "tool", () => ({
        kind: "failed",
        completeRun: false,
      }));
      const run = store.createRun({
        operationKind: "test.runtime",
        rootOperationReason: "non_terminal_failure_test",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });
      store.createStep({
        runtimeRunId: run.runtimeRunId,
        stepType: "tool",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });

      await expect(
        runDurableExecutorOnce({
          store,
          registry,
          workerId: "worker",
          operationKind: "test.runtime",
          now: () => 200,
        }),
      ).resolves.toMatchObject({ claimed: true, outcome: "failed" });
      expect(store.getRun(run.runtimeRunId)).toMatchObject({
        status: "queued",
        recoveryState: "runnable",
      });
      expect(store.listSteps(run.runtimeRunId)).toEqual([
        expect.objectContaining({ status: "failed", recoveryState: "terminal" }),
      ]);
    } finally {
      cleanup();
    }
  });

  it("does not continue a run after a step requires an owner decision", async () => {
    const { store, cleanup } = tempStore();
    try {
      const registry = createTestRegistry();
      const toolHandler = vi.fn(() => ({ kind: "succeeded" as const, completeRun: true }));
      registry.registerStepHandler("test.runtime", "tool", toolHandler);
      const run = store.createRun({
        operationKind: "test.runtime",
        rootOperationReason: "owner_decision_fence_test",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });
      store.createStep({
        runtimeRunId: run.runtimeRunId,
        stepType: "agent",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });
      const toolStep = store.createStep({
        runtimeRunId: run.runtimeRunId,
        stepType: "tool",
        status: "queued",
        recoveryState: "runnable",
        now: 110,
      });
      const execute = () =>
        runDurableExecutorOnce({
          store,
          registry,
          workerId: "worker",
          operationKind: "test.runtime",
          now: () => 200,
        });

      await expect(execute()).resolves.toMatchObject({ claimed: true, outcome: "no_handler" });
      await expect(execute()).resolves.toEqual({ claimed: false, reason: "no_runnable_step" });
      expect(toolHandler).not.toHaveBeenCalled();
      expect(store.listSteps(run.runtimeRunId)).toContainEqual(
        expect.objectContaining({ stepId: toolStep.stepId, status: "queued" }),
      );
    } finally {
      cleanup();
    }
  });
});
