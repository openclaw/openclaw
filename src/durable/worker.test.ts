import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDurableRuntimeRegistry } from "./registry.js";
import { openDurableRuntimeSqliteStore } from "./sqlite-store.js";
import {
  runDurableWorkerBatch,
  runRegisteredDurableWorkersOnce,
  startDurableRuntimeWorker,
  startDurableRuntimeWorkerFromConfig,
} from "./worker.js";

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-worker-"));
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

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  expect(condition()).toBe(true);
}

describe("durable runtime worker", () => {
  it("runs a bounded batch of runnable steps", async () => {
    const { store, cleanup } = tempStore();
    try {
      const registry = createDurableRuntimeRegistry();
      registry.registerRuntime({ operationKind: "test.runtime", version: "1" });
      registry.registerStepHandler("test.runtime", "tool", () => ({
        kind: "succeeded",
        output: { ok: true },
        completeRun: false,
      }));
      const run = store.createRun({
        operationKind: "test.runtime",
        rootOperationReason: "worker_test_fixture",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });
      const stepOne = store.createStep({
        runtimeRunId: run.runtimeRunId,
        stepType: "tool",
        status: "queued",
        recoveryState: "runnable",
        now: 110,
      });
      const stepTwo = store.createStep({
        runtimeRunId: run.runtimeRunId,
        stepType: "tool",
        status: "queued",
        recoveryState: "runnable",
        now: 120,
      });

      const result = await runDurableWorkerBatch({
        store,
        registry,
        workerId: "worker-1",
        operationKind: "test.runtime",
        maxSteps: 2,
        now: () => 200,
      });

      expect(result.claimedSteps).toBe(2);
      expect(result.idle).toBe(false);
      expect(store.listSteps(run.runtimeRunId)).toMatchObject([
        {
          stepId: stepOne.stepId,
          status: "succeeded",
          recoveryState: "terminal",
        },
        {
          stepId: stepTwo.stepId,
          status: "succeeded",
          recoveryState: "terminal",
        },
      ]);
    } finally {
      cleanup();
    }
  });

  it("starts, claims work, and stops cleanly", async () => {
    const { store, cleanup } = tempStore();
    try {
      const registry = createDurableRuntimeRegistry();
      registry.registerRuntime({ operationKind: "test.runtime", version: "1" });
      registry.registerStepHandler("test.runtime", "tool", () => ({
        kind: "succeeded",
        output: { ok: true },
        completeRun: true,
      }));
      const run = store.createRun({
        operationKind: "test.runtime",
        rootOperationReason: "worker_test_fixture",
        status: "queued",
        recoveryState: "runnable",
      });
      store.createStep({
        runtimeRunId: run.runtimeRunId,
        stepType: "tool",
        status: "queued",
        recoveryState: "runnable",
      });

      const worker = startDurableRuntimeWorker({
        store,
        registry,
        workerId: "worker-loop",
        pollIntervalMs: 5,
        maxConcurrency: 1,
        operationKind: "test.runtime",
      });

      await waitFor(() => worker.getStatus().claimedSteps === 1);
      await worker.stop();

      expect(worker.getStatus()).toMatchObject({
        running: false,
        stopped: true,
        inFlight: 0,
        claimedSteps: 1,
      });
      expect(store.getRun(run.runtimeRunId)).toMatchObject({
        status: "succeeded",
        recoveryState: "terminal",
      });
    } finally {
      cleanup();
    }
  });

  it("does not start unless authority mode is explicit", async () => {
    const registry = createDurableRuntimeRegistry();
    const worker = startDurableRuntimeWorkerFromConfig({
      registry,
      workerId: "disabled-worker",
      operationKind: "test.runtime",
      config: { mode: "observe" },
    });

    expect(worker.getStatus()).toMatchObject({
      running: false,
      stopped: true,
      claimedSteps: 0,
    });
    await worker.stop();
  });

  it("refuses to start an unregistered operation-scoped worker", () => {
    const { store, cleanup } = tempStore();
    try {
      expect(() =>
        startDurableRuntimeWorker({
          store,
          registry: createDurableRuntimeRegistry(),
          workerId: "unregistered-worker",
          operationKind: "test.unregistered",
        }),
      ).toThrow(/operation is not registered/);
    } finally {
      cleanup();
    }
  });

  it("does not claim steps owned by another operation", async () => {
    const { store, cleanup } = tempStore();
    try {
      const registry = createDurableRuntimeRegistry();
      registry.registerRuntime({ operationKind: "test.owned", version: "1" });
      registry.registerStepHandler("test.owned", "tool", () => ({
        kind: "succeeded",
        completeRun: true,
      }));
      const otherRun = store.createRun({
        operationKind: "test.other",
        rootOperationReason: "worker_scope_fixture",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });
      store.createStep({
        runtimeRunId: otherRun.runtimeRunId,
        stepType: "tool",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });
      const ownedRun = store.createRun({
        operationKind: "test.owned",
        rootOperationReason: "worker_scope_fixture",
        status: "queued",
        recoveryState: "runnable",
        now: 200,
      });
      store.createStep({
        runtimeRunId: ownedRun.runtimeRunId,
        stepType: "tool",
        status: "queued",
        recoveryState: "runnable",
        now: 200,
      });

      const worker = startDurableRuntimeWorker({
        store,
        registry,
        workerId: "scoped-worker",
        operationKind: "test.owned",
        pollIntervalMs: 5,
      });
      await waitFor(() => worker.getStatus().claimedSteps === 1);
      await worker.stop();

      expect(store.getRun(ownedRun.runtimeRunId)).toMatchObject({ status: "succeeded" });
      expect(store.getRun(otherRun.runtimeRunId)).toMatchObject({
        status: "queued",
        recoveryState: "runnable",
      });
    } finally {
      cleanup();
    }
  });

  it("only reconciles expired claims when an operation has no handlers", async () => {
    const { store, cleanup } = tempStore();
    try {
      const registry = createDurableRuntimeRegistry();
      registry.registerRuntime({
        operationKind: "test.owner-only",
        version: "1",
        stepTypes: ["agent"],
      });
      const expiredRun = store.createRun({
        operationKind: "test.owner-only",
        rootOperationReason: "expired_owner_claim_test",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });
      const expiredStep = store.createStep({
        runtimeRunId: expiredRun.runtimeRunId,
        stepType: "agent",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });
      const claim = store.claimNextRunnableStep({
        operationKind: "test.owner-only",
        operationVersion: "1",
        workerId: "lost-owner",
        claimTtlMs: 10,
        now: 100,
      });
      expect(claim).toMatchObject({ stepId: expiredStep.stepId });
      expect(
        store.updateStep({
          runtimeRunId: expiredRun.runtimeRunId,
          stepId: expiredStep.stepId,
          expectedClaimedBy: claim!.claimedBy,
          status: "running",
          recoveryState: "running",
          now: 105,
        }),
      ).toBeDefined();

      const freshRun = store.createRun({
        operationKind: "test.owner-only",
        rootOperationReason: "fresh_owner_work_test",
        status: "queued",
        recoveryState: "runnable",
        now: 110,
      });
      const freshStep = store.createStep({
        runtimeRunId: freshRun.runtimeRunId,
        stepType: "agent",
        status: "queued",
        recoveryState: "runnable",
        now: 110,
      });

      await expect(
        runRegisteredDurableWorkersOnce({
          store,
          registry,
          workerId: "recovery",
          now: () => 111,
        }),
      ).resolves.toEqual({ claimsRecovered: 0, claimsBlocked: 1, stepsClaimed: 0 });
      expect(store.getRun(expiredRun.runtimeRunId)).toMatchObject({
        status: "blocked",
        recoveryState: "requires_owner_decision",
      });
      expect(store.listSteps(freshRun.runtimeRunId)).toEqual([
        expect.objectContaining({
          stepId: freshStep.stepId,
          status: "queued",
          recoveryState: "runnable",
        }),
      ]);
      expect(store.listSteps(freshRun.runtimeRunId)[0]?.claimedBy).toBeUndefined();
      expect(store.listWakeObligations()).toEqual([
        expect.objectContaining({ reason: "no_handler", status: "pending" }),
      ]);
    } finally {
      cleanup();
    }
  });

  it("executes only registered operation versions that have handlers", async () => {
    const { store, cleanup } = tempStore();
    try {
      const registry = createDurableRuntimeRegistry();
      registry.registerRuntime({
        operationKind: "test.versioned",
        version: "2",
        stepTypes: ["tool"],
      });
      registry.registerStepHandler(
        "test.versioned",
        "tool",
        () => ({ kind: "succeeded", completeRun: true }),
        { operationVersion: "2", sideEffectPolicy: "idempotent" },
      );
      const versionOne = store.createRun({
        operationKind: "test.versioned",
        operationVersion: "1",
        rootOperationReason: "version_scope_test",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });
      store.createStep({
        runtimeRunId: versionOne.runtimeRunId,
        stepType: "tool",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });
      const versionTwo = store.createRun({
        operationKind: "test.versioned",
        operationVersion: "2",
        rootOperationReason: "version_scope_test",
        status: "queued",
        recoveryState: "runnable",
        now: 110,
      });
      store.createStep({
        runtimeRunId: versionTwo.runtimeRunId,
        stepType: "tool",
        status: "queued",
        recoveryState: "runnable",
        now: 110,
      });

      await expect(
        runRegisteredDurableWorkersOnce({
          store,
          registry,
          workerId: "recovery",
          maxStepsPerOperation: 2,
          now: () => 200,
        }),
      ).resolves.toEqual({ claimsRecovered: 0, claimsBlocked: 0, stepsClaimed: 1 });
      expect(store.getRun(versionTwo.runtimeRunId)).toMatchObject({ status: "succeeded" });
      expect(store.getRun(versionOne.runtimeRunId)).toMatchObject({
        status: "queued",
        recoveryState: "runnable",
      });
    } finally {
      cleanup();
    }
  });

  it("renews long-running registered work against the live clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { store, cleanup } = tempStore();
    let releaseHandler!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    try {
      const registry = createDurableRuntimeRegistry();
      registry.registerRuntime({ operationKind: "test.long-running", version: "1" });
      registry.registerStepHandler("test.long-running", "tool", async () => {
        await released;
        return { kind: "succeeded", completeRun: true };
      });
      const run = store.createRun({
        operationKind: "test.long-running",
        rootOperationReason: "live_clock_renewal_test",
        status: "queued",
        recoveryState: "runnable",
        now: 1_000,
      });
      store.createStep({
        runtimeRunId: run.runtimeRunId,
        stepType: "tool",
        status: "queued",
        recoveryState: "runnable",
        now: 1_000,
      });

      const execution = runRegisteredDurableWorkersOnce({
        store,
        registry,
        workerId: "recovery",
        claimTtlMs: 120,
        maxStepsPerOperation: 1,
      });
      await vi.advanceTimersByTimeAsync(121);

      expect(store.listSteps(run.runtimeRunId)).toEqual([
        expect.objectContaining({ claimExpiresAt: 1_240 }),
      ]);
      releaseHandler();
      await expect(execution).resolves.toMatchObject({ stepsClaimed: 1 });
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });
});
