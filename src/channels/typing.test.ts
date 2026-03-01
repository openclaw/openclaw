import { describe, expect, it, vi } from "vitest";
import { createTypingCallbacks } from "./typing.js";

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("createTypingCallbacks", () => {
  it("invokes start on reply start", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const onStartError = vi.fn();
    const callbacks = createTypingCallbacks({ start, onStartError });

    await callbacks.onReplyStart();

    expect(start).toHaveBeenCalledTimes(1);
    expect(onStartError).not.toHaveBeenCalled();
  });

  it("reports start errors", async () => {
    const start = vi.fn().mockRejectedValue(new Error("fail"));
    const onStartError = vi.fn();
    const callbacks = createTypingCallbacks({ start, onStartError });

    await callbacks.onReplyStart();

    expect(onStartError).toHaveBeenCalledTimes(1);
  });

  it("invokes stop on idle and reports stop errors", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockRejectedValue(new Error("stop"));
    const onStartError = vi.fn();
    const onStopError = vi.fn();
    const callbacks = createTypingCallbacks({ start, stop, onStartError, onStopError });

    callbacks.onIdle?.();
    await flushMicrotasks();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(onStopError).toHaveBeenCalledTimes(1);
  });

  it("deduplicates stop across idle and cleanup", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    const onStartError = vi.fn();
    const callbacks = createTypingCallbacks({ start, stop, onStartError });

    callbacks.onIdle?.();
    callbacks.onCleanup?.();
    await flushMicrotasks();

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("does not restart after idle cleanup", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    const onStartError = vi.fn();
    const callbacks = createTypingCallbacks({ start, stop, onStartError });

    await callbacks.onReplyStart();
    expect(start).toHaveBeenCalledTimes(1);

    callbacks.onIdle?.();
    await flushMicrotasks();

    // After closed, onReplyStart is a no-op
    await callbacks.onReplyStart();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("does not start when breaker trips on initial start", async () => {
    const start = vi.fn().mockRejectedValue(new Error("gone"));
    const onStartError = vi.fn();
    const callbacks = createTypingCallbacks({
      start,
      onStartError,
      maxConsecutiveFailures: 1,
    });

    await callbacks.onReplyStart();
    expect(start).toHaveBeenCalledTimes(1);
    expect(onStartError).toHaveBeenCalledTimes(1);
  });

  // ========== Race condition tests ==========
  it("does not leak state when fireStop races during async start", async () => {
    let startResolve: () => void;
    const start = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          startResolve = resolve;
        }),
    );
    const stop = vi.fn().mockResolvedValue(undefined);
    const onStartError = vi.fn();
    const callbacks = createTypingCallbacks({ start, stop, onStartError });

    // Begin onReplyStart — it will await fireStart() which is now pending
    const replyPromise = callbacks.onReplyStart();

    // While start() is pending, a concurrent stop fires (e.g. from cleanup)
    callbacks.onIdle?.();
    await flushMicrotasks();
    expect(stop).toHaveBeenCalledTimes(1);

    // Now resolve the pending start — onReplyStart should see closed=true
    startResolve!();
    await replyPromise;

    // start was called once by the initial fireStart; no further side effects
    expect(start).toHaveBeenCalledTimes(1);
  });

  // ========== Multi-call (controller tick simulation) ==========
  it("handles repeated onReplyStart calls without issues", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const onStartError = vi.fn();
    const callbacks = createTypingCallbacks({ start, onStartError });

    // Simulate the controller's keepalive ticking onReplyStart multiple times
    await callbacks.onReplyStart();
    await callbacks.onReplyStart();
    await callbacks.onReplyStart();

    expect(start).toHaveBeenCalledTimes(3);
    expect(onStartError).not.toHaveBeenCalled();
  });

  it("trips circuit breaker across repeated onReplyStart calls", async () => {
    const start = vi.fn().mockRejectedValue(new Error("403"));
    const onStartError = vi.fn();
    const callbacks = createTypingCallbacks({
      start,
      onStartError,
      maxConsecutiveFailures: 2,
    });

    // Each onReplyStart call accumulates failures (no reset between ticks)
    await callbacks.onReplyStart(); // failure 1
    await callbacks.onReplyStart(); // failure 2 → trips breaker
    await callbacks.onReplyStart(); // should be skipped (breaker tripped)

    expect(start).toHaveBeenCalledTimes(2);
    expect(onStartError).toHaveBeenCalledTimes(2);
  });
});
