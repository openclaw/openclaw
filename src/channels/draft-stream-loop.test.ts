// Draft stream loop tests cover incremental draft updates while channel replies stream.
import { setImmediate as nextMacrotask } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  it.each(["unchanged", "rejected"])(
    "sends a newer coalesced value after an %s send",
    async (outcome) => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      let releaseFirst!: () => void;
      const first = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const error = new Error("send rejected");
      const onBackgroundFlushError = vi.fn();
      const send = vi.fn(async () => {
        if (send.mock.calls.length === 1) {
          await first;
          if (outcome === "rejected") {
            throw error;
          }
          return false;
        }
        return true;
      });
      const loop = createDraftStreamLoop({
        throttleMs: 1_000,
        coalesceInFlight: true,
        isStopped: () => false,
        sendOrEditStreamMessage: send,
        onBackgroundFlushError,
      });
      loop.update("First snapshot");
      loop.update("New milestone");
      releaseFirst();
      if (outcome === "rejected") {
        await expect(loop.waitForInFlight()).rejects.toBe(error);
        await waitForBackgroundFlushError(onBackgroundFlushError);
        expect(onBackgroundFlushError).toHaveBeenCalledExactlyOnceWith(error);
      } else {
        await loop.waitForInFlight();
      }
      await vi.advanceTimersByTimeAsync(1_000);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenLastCalledWith("New milestone");
      loop.stop();
    },
  );

  it("coalesces updates arriving during a send without delaying explicit attention flushes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const send = vi.fn(async () => {
      if (send.mock.calls.length === 1) {
        await first;
      }
    });
    const loop = createDraftStreamLoop({
      throttleMs: 1_000,
      coalesceInFlight: true,
      isStopped: () => false,
      sendOrEditStreamMessage: send,
    });
    loop.update("First milestone");
    loop.update("Second milestone");
    loop.update("Latest milestone");
    releaseFirst();
    await loop.waitForInFlight();
    await vi.advanceTimersByTimeAsync(999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenLastCalledWith("Latest milestone");
    loop.update("Approval required");
    await loop.flush();
    expect(send).toHaveBeenLastCalledWith("Approval required");
    loop.stop();
  });

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

  it("preserves generic pending updates when consecutive sends return false", async () => {
    type Update = { text: string; blocks: string[] };
    const initial = { text: "initial", blocks: ["initial-blocks"] };
    const latest = { text: "latest", blocks: ["latest-blocks"] };
    let releaseFirst: (() => void) | undefined;
    const firstSend = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sendOrEditStreamMessage = vi
      .fn<(update: Update) => Promise<boolean>>()
      .mockImplementationOnce(async () => {
        await firstSend;
        return false;
      })
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const loop = createDraftStreamLoop<Update>({
      throttleMs: 0,
      isStopped: () => false,
      emptyValue: { text: "", blocks: [] },
      isEmpty: (update) => !update.text,
      sendOrEditStreamMessage,
    });

    loop.update(initial);
    await flushMicrotasks();
    loop.update(latest);
    releaseFirst?.();
    await loop.flush();
    await loop.flush();

    expect(sendOrEditStreamMessage.mock.calls).toEqual([[initial], [latest], [latest]]);
  });
});
