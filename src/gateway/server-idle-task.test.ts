import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  GatewayDrainingError,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { scheduleGatewayIdleTask } from "./server-idle-task.js";

afterEach(() => {
  resetGatewayWorkAdmission();
  vi.useRealTimers();
});

describe("scheduleGatewayIdleTask", () => {
  it("still completes ordinary idle work", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const handle = scheduleGatewayIdleTask({
      delayMs: 10,
      retryDelayMs: 5,
      isClosing: () => false,
      isBusy: () => false,
      run,
      log: { warn: vi.fn() },
      errorMessage: "idle task failed",
    });

    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();
    expect(run).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await handle.stop();
  });

  it("quietly cancels idle work rejected by an active restart drain", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const warn = vi.fn();
    const handle = scheduleGatewayIdleTask({
      delayMs: 10,
      retryDelayMs: 5,
      isClosing: () => false,
      isBusy: () => false,
      run,
      log: { warn },
      errorMessage: "idle task failed",
    });

    markGatewayRestartDraining();
    await vi.advanceTimersByTimeAsync(10);

    expect(run).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await handle.stop();
  });

  it("warns when idle work throws a draining error without an active restart", async () => {
    vi.useFakeTimers();
    const error = new GatewayDrainingError("unexpected task failure");
    const warn = vi.fn();
    const handle = scheduleGatewayIdleTask({
      delayMs: 10,
      retryDelayMs: 5,
      isClosing: () => false,
      isBusy: () => false,
      run: async () => {
        throw error;
      },
      log: { warn },
      errorMessage: "idle task failed",
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(warn).toHaveBeenCalledWith(`idle task failed: ${String(error)}`);
    await handle.stop();
  });
});

it("repeats only after completion, defers busy work once, and joins stop", async () => {
  vi.useFakeTimers();
  const released = createDeferred();
  const run = vi.fn(async () => {
    if (run.mock.calls.length === 2) {
      await released.promise;
    }
  });
  const isBusy = vi.fn(() => false);
  const handle = scheduleGatewayIdleTask({
    delayMs: 10,
    retryDelayMs: 5,
    repeatDelayMs: 20,
    isClosing: () => false,
    isBusy,
    run,
    log: { warn: vi.fn() },
    errorMessage: "idle task failed",
  });
  try {
    await vi.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    // Admission sees idle; newly admitted foreground work wins before execution.
    isBusy.mockReturnValueOnce(false).mockReturnValueOnce(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    let stopped = false;
    const stopping = Promise.resolve(handle.stop()).then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    released.resolve();
    await stopping;
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    released.resolve();
    await handle.stop();
  }
});

it("does not rearm a periodic task when restart drain begins during its run", async () => {
  vi.useFakeTimers();
  const released = createDeferred();
  const run = vi.fn(() => released.promise);
  const handle = scheduleGatewayIdleTask({
    delayMs: 0,
    retryDelayMs: 5,
    repeatDelayMs: 20,
    isClosing: () => false,
    isBusy: () => false,
    run,
    log: { warn: vi.fn() },
    errorMessage: "idle task failed",
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledOnce();
    markGatewayRestartDraining();
    released.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    released.resolve();
    await handle.stop();
  }
});
