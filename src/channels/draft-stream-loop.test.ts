// Draft stream loop tests cover incremental draft updates while channel replies stream.
import { setImmediate as nextMacrotask } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import { createDraftStreamLoop } from "./draft-stream-loop.js";

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const flushMacrotask = async () => {
  await nextMacrotask();
};

async function waitForBackgroundFlushError(
  onBackgroundFlushError: ReturnType<typeof vi.fn<(err: unknown) => void>>,
) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await flushMicrotasks();
    if (onBackgroundFlushError.mock.calls.length > 0) {
      return;
    }
  }
}

async function captureUnhandledRejections(
  run: (rejections: unknown[]) => Promise<void>,
  settle: () => Promise<void> = flushMacrotask,
) {
  const rejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    await run(rejections);
    await settle();
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
}

describe("createDraftStreamLoop", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    if (vi.isFakeTimers()) {
      vi.clearAllTimers();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("contains immediate background flush rejections and preserves pending text", async () => {
    await captureUnhandledRejections(async (rejections) => {
      const error = new Error("send failed");
      const onBackgroundFlushError = vi.fn<(err: unknown) => void>();
      const sendOrEditStreamMessage = vi
        .fn<(text: string) => Promise<boolean>>()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(true);

      const loop = createDraftStreamLoop({
        throttleMs: 0,
        isStopped: () => false,
        sendOrEditStreamMessage,
        onBackgroundFlushError,
      });

      loop.update("hello");
      await waitForBackgroundFlushError(onBackgroundFlushError);
      await flushMacrotask();
      await loop.flush();

      expect(rejections).toStrictEqual([]);
      expect(onBackgroundFlushError).toHaveBeenCalledWith(error);
      expect(sendOrEditStreamMessage).toHaveBeenNthCalledWith(1, "hello");
      expect(sendOrEditStreamMessage).toHaveBeenNthCalledWith(2, "hello");
    });
  });

  it("contains scheduled background flush rejections and preserves pending text", async () => {
    vi.useFakeTimers();
    try {
      await captureUnhandledRejections(
        async (rejections) => {
          const error = new Error("send failed");
          const onBackgroundFlushError = vi.fn<(err: unknown) => void>();
          const sendOrEditStreamMessage = vi
            .fn<(text: string) => Promise<boolean>>()
            .mockRejectedValueOnce(error)
            .mockResolvedValueOnce(true);

          const loop = createDraftStreamLoop({
            throttleMs: 100,
            isStopped: () => false,
            sendOrEditStreamMessage,
            onBackgroundFlushError,
          });

          loop.update("scheduled");
          await vi.advanceTimersByTimeAsync(100);
          await flushMicrotasks();
          await loop.flush();

          expect(rejections).toStrictEqual([]);
          expect(onBackgroundFlushError).toHaveBeenCalledWith(error);
          expect(sendOrEditStreamMessage).toHaveBeenNthCalledWith(1, "scheduled");
          expect(sendOrEditStreamMessage).toHaveBeenNthCalledWith(2, "scheduled");
        },
        async () => {
          await vi.advanceTimersByTimeAsync(0);
        },
      );
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("clamps oversized throttle timers", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const sendOrEditStreamMessage = vi.fn(async () => true);
      const loop = createDraftStreamLoop({
        throttleMs: Number.MAX_SAFE_INTEGER,
        isStopped: () => false,
        sendOrEditStreamMessage,
      });

      loop.update("hello");

      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(MAX_TIMER_TIMEOUT_MS - 1);
      expect(sendOrEditStreamMessage).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(sendOrEditStreamMessage).toHaveBeenCalledExactlyOnceWith("hello");
      loop.stop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("takes the latest queued text without interrupting the in-flight send", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let releaseSend: (() => void) | undefined;
    const sendPending = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendOrEditStreamMessage = vi.fn(async () => {
      await sendPending;
      return true;
    });
    const loop = createDraftStreamLoop({
      throttleMs: 0,
      isStopped: () => false,
      sendOrEditStreamMessage,
    });

    loop.update("in flight");
    await flushMicrotasks();
    loop.update("queued first");
    loop.update("queued latest");

    expect(vi.getTimerCount()).toBe(1);
    expect(loop.takePending()).toBe("queued latest");
    expect(vi.getTimerCount()).toBe(0);

    releaseSend?.();
    await loop.waitForInFlight();
    await flushMicrotasks();

    expect(sendOrEditStreamMessage).toHaveBeenCalledExactlyOnceWith("in flight");
  });

  it("contains synchronous sender failures from background flushes", async () => {
    await captureUnhandledRejections(async (rejections) => {
      const error = new Error("send failed");
      const onBackgroundFlushError = vi.fn<(err: unknown) => void>();
      const sendOrEditStreamMessage = vi
        .fn<(text: string) => Promise<boolean>>()
        .mockImplementationOnce(() => {
          throw error;
        })
        .mockResolvedValueOnce(true);

      const loop = createDraftStreamLoop({
        throttleMs: 0,
        isStopped: () => false,
        sendOrEditStreamMessage,
        onBackgroundFlushError,
      });

      loop.update("hello");
      await waitForBackgroundFlushError(onBackgroundFlushError);
      await flushMacrotask();
      await loop.flush();

      expect(rejections).toStrictEqual([]);
      expect(onBackgroundFlushError).toHaveBeenCalledWith(error);
      expect(sendOrEditStreamMessage).toHaveBeenNthCalledWith(1, "hello");
      expect(sendOrEditStreamMessage).toHaveBeenNthCalledWith(2, "hello");
    });
  });

  it("contains background flush error reporter failures", async () => {
    await captureUnhandledRejections(async (rejections) => {
      const error = new Error("send failed");
      const onBackgroundFlushError = vi.fn<(err: unknown) => void>(() => {
        throw new Error("report failed");
      });
      const sendOrEditStreamMessage = vi
        .fn<(text: string) => Promise<boolean>>()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(true);

      const loop = createDraftStreamLoop({
        throttleMs: 0,
        isStopped: () => false,
        sendOrEditStreamMessage,
        onBackgroundFlushError,
      });

      loop.update("hello");
      await waitForBackgroundFlushError(onBackgroundFlushError);
      await flushMacrotask();
      await loop.flush();

      expect(rejections).toStrictEqual([]);
      expect(onBackgroundFlushError).toHaveBeenCalledWith(error);
      expect(sendOrEditStreamMessage).toHaveBeenNthCalledWith(2, "hello");
    });
  });

  it("keeps explicit flush rejections visible and preserves pending text", async () => {
    const error = new Error("send failed");
    const sendOrEditStreamMessage = vi
      .fn<(text: string) => Promise<boolean>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(true);

    const loop = createDraftStreamLoop({
      throttleMs: 100,
      isStopped: () => false,
      sendOrEditStreamMessage,
    });

    loop.update("hello");
    await expect(loop.flush()).rejects.toThrow(error);
    await loop.flush();

    expect(sendOrEditStreamMessage).toHaveBeenNthCalledWith(1, "hello");
    expect(sendOrEditStreamMessage).toHaveBeenNthCalledWith(2, "hello");
  });

  it("bounds consecutive sends per flush and preserves pending text instead of looping unbounded (#106644)", async () => {
    // A producer that keeps appending new text between iterations would spin the
    // flush() while-loop forever. flush() must instead terminate after a bounded
    // number of sends, keep the pending text, and hand the remainder back to the
    // throttle timer rather than discarding it.
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      let sends = 0;
      const loop = createDraftStreamLoop({
        throttleMs: 100,
        isStopped: () => false,
        sendOrEditStreamMessage: async () => {
          sends += 1;
          // Replenish pending text as a microtask so it lands while flush() is
          // awaiting this send (inFlightPromise is set) — mirroring a real
          // streaming producer appending text between iterations.
          void Promise.resolve().then(() => loop.update(`text-${sends + 1}`));
          return true;
        },
      });

      loop.update("text-1");
      // Must terminate (not hang) even though pending text is always replenished.
      await loop.flush();

      // flush() yielded after the batch cap instead of looping forever...
      expect(sends).toBe(20);
      // ...armed a follow-up flush through the throttle timer...
      expect(vi.getTimerCount()).toBe(1);
      // ...and preserved the pending text rather than dropping it (no data loss).
      expect(loop.takePending()).toBe("text-21");

      loop.stop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});
