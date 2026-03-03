import { describe, expect, it, vi } from "vitest";
import { startDeliveryRecoveryLoop } from "./delivery-recovery-loop.js";

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("startDeliveryRecoveryLoop", () => {
  it("runs immediately, skips overlapping ticks, and resumes after completion", async () => {
    const firstRun = createDeferred();
    const run = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(async () => await firstRun.promise)
      .mockResolvedValue(undefined);
    const setIntervalFn =
      vi.fn<NonNullable<Parameters<typeof startDeliveryRecoveryLoop>[0]["setIntervalFn"]>>();
    const clearIntervalFn =
      vi.fn<NonNullable<Parameters<typeof startDeliveryRecoveryLoop>[0]["clearIntervalFn"]>>();
    let scheduled: (() => void) | undefined;
    const intervalHandle = {} as ReturnType<typeof setInterval>;
    setIntervalFn.mockImplementation((cb) => {
      scheduled = cb as () => void;
      return intervalHandle;
    });

    const loop = startDeliveryRecoveryLoop({
      enabled: true,
      run,
      onError: () => {},
      setIntervalFn,
      clearIntervalFn,
      intervalMs: 1000,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduled).toBeTypeOf("function");

    scheduled?.();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);

    firstRun.resolve();
    await firstRun.promise;
    await Promise.resolve();

    scheduled?.();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));

    await loop.stop();
    expect(clearIntervalFn).toHaveBeenCalledWith(intervalHandle);
  });

  it("waits for in-flight recovery before stopping", async () => {
    const deferredRun = createDeferred();
    const run = vi
      .fn<() => Promise<void>>()
      .mockImplementation(async () => await deferredRun.promise);
    const setIntervalFn =
      vi.fn<NonNullable<Parameters<typeof startDeliveryRecoveryLoop>[0]["setIntervalFn"]>>();
    const clearIntervalFn =
      vi.fn<NonNullable<Parameters<typeof startDeliveryRecoveryLoop>[0]["clearIntervalFn"]>>();
    const intervalHandle = {} as ReturnType<typeof setInterval>;
    setIntervalFn.mockImplementation(() => intervalHandle);

    const loop = startDeliveryRecoveryLoop({
      enabled: true,
      run,
      onError: () => {},
      setIntervalFn,
      clearIntervalFn,
      intervalMs: 1000,
    });

    let stopped = false;
    const stopPromise = loop.stop().then(() => {
      stopped = true;
    });

    await Promise.resolve();
    expect(stopped).toBe(false);

    deferredRun.resolve();
    await stopPromise;
    expect(stopped).toBe(true);
    expect(clearIntervalFn).toHaveBeenCalledWith(intervalHandle);
  });

  it("does not schedule anything when disabled", async () => {
    const setIntervalFn =
      vi.fn<NonNullable<Parameters<typeof startDeliveryRecoveryLoop>[0]["setIntervalFn"]>>();

    const loop = startDeliveryRecoveryLoop({
      enabled: false,
      run: async () => {},
      onError: () => {},
      setIntervalFn,
    });

    expect(setIntervalFn).not.toHaveBeenCalled();
    await loop.stop();
  });
});
