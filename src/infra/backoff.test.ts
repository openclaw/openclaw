import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
// Covers retry backoff calculation and abortable sleep behavior.
import { describe, expect, it, vi } from "vitest";
import { sleepWithAbort } from "./backoff.js";

async function expectAbortedSleep(promise: Promise<void>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("expected aborted sleep");
}

describe("backoff helpers", () => {
  it("removes the abort listener after the sleep completes", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const addEventListenerSpy = vi.spyOn(controller.signal, "addEventListener");
    const removeEventListenerSpy = vi.spyOn(controller.signal, "removeEventListener");
    try {
      const sleeper = sleepWithAbort(50, controller.signal);
      const onSettled = vi.fn();
      void sleeper.then(onSettled);
      const abortListener = addEventListenerSpy.mock.calls[0]?.[1];

      expect(abortListener).toBeDefined();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(49);
      expect(onSettled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(sleeper).resolves.toBeUndefined();

      expect(removeEventListenerSpy).toHaveBeenCalledWith("abort", abortListener);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("clears the timer and listener when aborted during the sleep", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const addEventListenerSpy = vi.spyOn(controller.signal, "addEventListener");
    const removeEventListenerSpy = vi.spyOn(controller.signal, "removeEventListener");
    try {
      const sleeper = sleepWithAbort(50, controller.signal);
      const rejectedSleep = expectAbortedSleep(sleeper);
      const abortListener = addEventListenerSpy.mock.calls[0]?.[1];

      expect(abortListener).toBeDefined();
      expect(vi.getTimerCount()).toBe(1);
      controller.abort(new Error("stop retrying"));

      const error = await rejectedSleep;
      expect(error.message).toBe("aborted");
      expect(removeEventListenerSpy).toHaveBeenCalledWith("abort", abortListener);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("clamps oversized sleep durations before scheduling", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const sleeper = sleepWithAbort(Number.MAX_SAFE_INTEGER);

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);

      await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);
      await expect(sleeper).resolves.toBeUndefined();
    } finally {
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("rejects if the signal aborts during listener registration", async () => {
    let aborted = false;
    const signal = {
      get aborted() {
        return aborted;
      },
      get reason() {
        return new Error("listener-registration-race");
      },
      addEventListener(_eventValue: string, _listener: EventListenerOrEventListenerObject) {
        aborted = true;
      },
      removeEventListener() {},
    } as unknown as AbortSignal;

    const error = await expectAbortedSleep(sleepWithAbort(50, signal));
    expect(error.message).toBe("aborted");
    expect(error.cause).toStrictEqual(new Error("listener-registration-race"));
  });
});
