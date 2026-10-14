import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { waitForSignalExitBarriers } from "../cli/signal-exit-barrier.js";
import {
  captureRuntimeWorkerSource,
  withRuntimeWorkerGeneration,
} from "./runtime-worker-generation.js";

afterEach(() => {
  vi.useRealTimers();
});

it.each([false, true])(
  "keeps native retirement joined after its warning and preserves the outcome (failed=%s)",
  async (failed) => {
    vi.useFakeTimers();
    const accepted = createDeferred();
    const native = createDeferred();
    const release = vi.fn(async () => {});
    const report = vi.fn(() => "/retained-runtime");
    const failure = new Error("update failed");
    const close = vi.fn(() => native.promise);
    const settle = vi.fn(async () => {
      await accepted.promise;
      return close;
    });
    const result = withRuntimeWorkerGeneration(
      async (bind) => {
        bind(() => new URL("file:///retained-runtime/worker.mjs"));
        const { runtimeGeneration } = captureRuntimeWorkerSource(new URL("file:///worker.mjs"));
        assert.ok(runtimeGeneration);
        runtimeGeneration.retain({}, settle);
        if (failed) {
          throw failure;
        }
        return "update complete";
      },
      release,
      report,
    );
    const completed = vi.fn();
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
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(settle).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      expect(completed).not.toHaveBeenCalled();

      accepted.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(close).toHaveBeenCalledOnce();
      expect(report).toHaveBeenCalledWith(expect.stringContaining("waiting for native retirement"));
      expect(release).not.toHaveBeenCalled();
      expect(completed).not.toHaveBeenCalled();

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
    vi.useFakeTimers();
    const native = createDeferred();
    const release = vi.fn(async () => {});
    const report = vi.fn(() => "/retained-runtime");
    const settlementFailure = new Error("worker did not settle");
    const operationFailure = new Error("update failed");
    const close = vi.fn(() => native.promise);
    const result = withRuntimeWorkerGeneration(
      async (bind) => {
        bind(() => new URL("file:///retained-runtime/worker.mjs"));
        const { runtimeGeneration } = captureRuntimeWorkerSource(new URL("file:///worker.mjs"));
        assert.ok(runtimeGeneration);
        runtimeGeneration.retain({}, async () => close);
        runtimeGeneration.retain({}, async () => {
          throw settlementFailure;
        });
        if (operationFailed) {
          throw operationFailure;
        }
      },
      release,
      report,
    );
    const completed = vi.fn();
    const outcome = result.catch((error: unknown) => {
      completed();
      return error;
    });
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(close).toHaveBeenCalledOnce();
      expect(completed).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      native.resolve();
      const error = await outcome;
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
  vi.useFakeTimers();
  const native = createDeferred();
  const release = vi.fn(async () => {});
  const report = vi.fn(() => "/retained-runtime");
  const completed = vi.fn();
  const operationFailure = new Error("update failed");
  const result = withRuntimeWorkerGeneration(
    async (bind) => {
      bind(() => new URL("file:///retained-runtime/worker.mjs"));
      const { runtimeGeneration } = captureRuntimeWorkerSource(new URL("file:///worker.mjs"));
      assert.ok(runtimeGeneration);
      runtimeGeneration.retain({}, async () => async () => {
        throw new Error("native retirement failed");
      });
      runtimeGeneration.retain({}, async () => () => native.promise);
      throw operationFailure;
    },
    release,
    report,
  ).catch((error: unknown) => {
    completed();
    return error;
  });
  try {
    await vi.advanceTimersByTimeAsync(10_000);
    expect(completed).not.toHaveBeenCalled();
    native.resolve();
    expect(await result).toBe(operationFailure);
    expect(report).toHaveBeenLastCalledWith(expect.stringContaining("termination failed"));
    expect(release).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    native.resolve();
    await result;
  }
});
