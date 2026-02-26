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

  it("sends typing keepalive pings until idle cleanup", async () => {
    vi.useFakeTimers();
    try {
      const start = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      const onStartError = vi.fn();
      const callbacks = createTypingCallbacks({ start, stop, onStartError });

      await callbacks.onReplyStart();
      expect(start).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2_999);
      expect(start).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(start).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(3_000);
      expect(start).toHaveBeenCalledTimes(3);

      callbacks.onIdle?.();
      await flushMicrotasks();
      expect(stop).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(9_000);
      expect(start).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
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

  it("does not restart keepalive after idle cleanup", async () => {
    vi.useFakeTimers();
    try {
      const start = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      const onStartError = vi.fn();
      const callbacks = createTypingCallbacks({ start, stop, onStartError });

      await callbacks.onReplyStart();
      expect(start).toHaveBeenCalledTimes(1);

      callbacks.onIdle?.();
      await flushMicrotasks();

      await callbacks.onReplyStart();
      await vi.advanceTimersByTimeAsync(9_000);

      expect(start).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // ========== TTL Safety Tests ==========
  describe("TTL safety", () => {
    it("auto-stops typing after maxDurationMs", async () => {
      vi.useFakeTimers();
      try {
        const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const start = vi.fn().mockResolvedValue(undefined);
        const stop = vi.fn().mockResolvedValue(undefined);
        const onStartError = vi.fn();
        const callbacks = createTypingCallbacks({
          start,
          stop,
          onStartError,
          maxDurationMs: 10_000,
        });

        await callbacks.onReplyStart();
        expect(start).toHaveBeenCalledTimes(1);
        expect(stop).not.toHaveBeenCalled();

        // Advance past TTL
        await vi.advanceTimersByTimeAsync(10_000);

        // Should auto-stop
        expect(stop).toHaveBeenCalledTimes(1);
        expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining("TTL exceeded"));

        consoleWarn.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not auto-stop if idle is called before TTL", async () => {
      vi.useFakeTimers();
      try {
        const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const start = vi.fn().mockResolvedValue(undefined);
        const stop = vi.fn().mockResolvedValue(undefined);
        const onStartError = vi.fn();
        const callbacks = createTypingCallbacks({
          start,
          stop,
          onStartError,
          maxDurationMs: 10_000,
        });

        await callbacks.onReplyStart();

        // Stop before TTL
        await vi.advanceTimersByTimeAsync(5_000);
        callbacks.onIdle?.();
        await flushMicrotasks();

        expect(stop).toHaveBeenCalledTimes(1);

        // Advance past original TTL
        await vi.advanceTimersByTimeAsync(10_000);

        // Should not have triggered TTL warning
        expect(consoleWarn).not.toHaveBeenCalled();
        // Stop should still be called only once
        expect(stop).toHaveBeenCalledTimes(1);

        consoleWarn.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });

    it("uses default 60s TTL when not specified", async () => {
      vi.useFakeTimers();
      try {
        const start = vi.fn().mockResolvedValue(undefined);
        const stop = vi.fn().mockResolvedValue(undefined);
        const onStartError = vi.fn();
        const callbacks = createTypingCallbacks({ start, stop, onStartError });

        await callbacks.onReplyStart();

        // Should not stop at 59s
        await vi.advanceTimersByTimeAsync(59_000);
        expect(stop).not.toHaveBeenCalled();

        // Should stop at 60s
        await vi.advanceTimersByTimeAsync(1_000);
        expect(stop).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("disables TTL when maxDurationMs is 0", async () => {
      vi.useFakeTimers();
      try {
        const start = vi.fn().mockResolvedValue(undefined);
        const stop = vi.fn().mockResolvedValue(undefined);
        const onStartError = vi.fn();
        const callbacks = createTypingCallbacks({
          start,
          stop,
          onStartError,
          maxDurationMs: 0,
        });

        await callbacks.onReplyStart();

        // Should not auto-stop even after long time
        await vi.advanceTimersByTimeAsync(300_000);
        expect(stop).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("resets TTL timer on restart after idle", async () => {
      vi.useFakeTimers();
      try {
        const start = vi.fn().mockResolvedValue(undefined);
        const stop = vi.fn().mockResolvedValue(undefined);
        const onStartError = vi.fn();
        const callbacks = createTypingCallbacks({
          start,
          stop,
          onStartError,
          maxDurationMs: 10_000,
        });

        // First start
        await callbacks.onReplyStart();
        await vi.advanceTimersByTimeAsync(5_000);

        // Idle and restart
        callbacks.onIdle?.();
        await flushMicrotasks();
        expect(stop).toHaveBeenCalledTimes(1);

        // Reset mock to track second start
        stop.mockClear();

        // After stop, callbacks are closed, so new onReplyStart should be no-op
        await callbacks.onReplyStart();
        await vi.advanceTimersByTimeAsync(15_000);

        // Should not trigger stop again since it's closed
        expect(stop).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
