import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { waitForSignalExitBarriers } from "../cli/signal-exit-barrier.js";
import {
  captureRuntimeWorkerSource,
  withRuntimeWorkerGeneration,
  type RuntimeWorkerGeneration,
} from "./runtime-worker-generation.js";

afterEach(() => {
  vi.useRealTimers();
});

function runGeneration(operation: (generation: RuntimeWorkerGeneration) => Promise<unknown>) {
  vi.useFakeTimers();
  const release = vi.fn(async () => {});
  const report = vi.fn(() => "/retained-runtime");
  const completed = vi.fn();
  const result = withRuntimeWorkerGeneration(
    async (bind) => {
      bind(() => new URL("file:///retained-runtime/worker.mjs"));
      const { runtimeGeneration } = captureRuntimeWorkerSource(new URL("file:///worker.mjs"));
      assert.ok(runtimeGeneration);
      return operation(runtimeGeneration);
    },
    release,
    report,
  );
  const outcome = result.then(
    (value) => {
      completed();
      return { value };
    },
    (error: unknown) => {
      completed();
      return { error };
    },
  );
  return { release, report, completed, outcome };
}

function expectPending(...callbacks: (() => unknown)[]) {
  for (const callback of callbacks) {
    expect(callback).not.toHaveBeenCalled();
  }
}

it.each([false, true])(
  "keeps native retirement joined after its warning and preserves the outcome (failed=%s)",
  async (failed) => {
    const accepted = createDeferred();
    const native = createDeferred();
    const failure = new Error("update failed");
    const close = vi.fn(() => native.promise);
    const settle = vi.fn(async () => {
      await accepted.promise;
      return close;
    });
    const { release, report, completed, outcome } = runGeneration(async (runtimeGeneration) => {
      runtimeGeneration.retain({}, settle);
      if (failed) {
        throw failure;
      }
      return "update complete";
    });
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(settle).toHaveBeenCalledOnce();
      expectPending(close, report, release, completed);

      accepted.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(close).toHaveBeenCalledOnce();
      expect(report).toHaveBeenCalledWith(expect.stringContaining("waiting for native retirement"));
      expectPending(release, completed);

      const signalCompleted = vi.fn();
      const signalDrain = waitForSignalExitBarriers().then(signalCompleted);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(signalCompleted).not.toHaveBeenCalled();
      expect(settle).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(report).toHaveBeenCalledOnce();
      native.resolve();
      await signalDrain;
      expect(await outcome).toEqual(failed ? { error: failure } : { value: "update complete" });
      expect(release).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      accepted.resolve();
      native.resolve();
      await outcome;
    }
  },
);

it.each([false, true])(
  "joins successful siblings without releasing a failed settlement (operationFailed=%s)",
  async (operationFailed) => {
    const native = createDeferred();
    const settlementFailure = new Error("worker did not settle");
    const operationFailure = new Error("update failed");
    const close = vi.fn(() => native.promise);
    const { release, report, completed, outcome } = runGeneration(async (runtimeGeneration) => {
      runtimeGeneration.retain({}, async () => close);
      runtimeGeneration.retain({}, async () => {
        throw settlementFailure;
      });
      if (operationFailed) {
        throw operationFailure;
      }
    });
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(close).toHaveBeenCalledOnce();
      expectPending(completed, release);
      native.resolve();
      const result = await outcome;
      assert.ok("error" in result);
      const { error } = result;
      if (operationFailed) {
        expect(error).toMatchObject({
          errors: [operationFailure, { errors: [settlementFailure] }],
        });
      } else {
        expect(error).toMatchObject({ errors: [settlementFailure] });
      }
      expect(report).toHaveBeenLastCalledWith(expect.stringContaining("workers did not settle"));
      expect(release).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      native.resolve();
      await outcome;
    }
  },
);

it("joins all native retirements and retains the command error when one fails", async () => {
  const native = createDeferred();
  const operationFailure = new Error("update failed");
  const { release, report, completed, outcome } = runGeneration(async (runtimeGeneration) => {
    runtimeGeneration.retain({}, async () => async () => {
      throw new Error("native retirement failed");
    });
    runtimeGeneration.retain({}, async () => () => native.promise);
    throw operationFailure;
  });
  try {
    await vi.advanceTimersByTimeAsync(10_000);
    expect(completed).not.toHaveBeenCalled();
    native.resolve();
    const result = await outcome;
    assert.ok("error" in result);
    expect(result.error).toBe(operationFailure);
    expect(report).toHaveBeenLastCalledWith(expect.stringContaining("termination failed"));
    expect(release).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    native.resolve();
    await outcome;
  }
});
