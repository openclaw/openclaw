import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDraftStreamLoop } from "./draft-stream-loop.js";

describe("createDraftStreamLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reschedules buffered text when a send requests a throttle reset", async () => {
    let resolveFirstSend: ((value: boolean | "reschedule") => void) | undefined;
    const sendOrEditStreamMessage = vi.fn((text: string) => {
      if (text === "first") {
        return new Promise<boolean | "reschedule">((resolve) => {
          resolveFirstSend = resolve;
        });
      }
      return Promise.resolve(true);
    });
    const loop = createDraftStreamLoop({
      throttleMs: 1000,
      isStopped: () => false,
      sendOrEditStreamMessage,
    });

    loop.update("first");
    expect(sendOrEditStreamMessage).toHaveBeenCalledTimes(1);

    loop.update("second");
    resolveFirstSend?.("reschedule");
    vi.runAllTicks();

    expect(sendOrEditStreamMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(sendOrEditStreamMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(sendOrEditStreamMessage).toHaveBeenCalledTimes(2));
    expect(sendOrEditStreamMessage.mock.calls[1]?.[0]).toBe("second");
  });

  it("keeps flush pending until rescheduled buffered text is sent", async () => {
    let resolveFirstSend: ((value: boolean | "reschedule") => void) | undefined;
    const sendOrEditStreamMessage = vi.fn((text: string) => {
      if (text === "first") {
        return new Promise<boolean | "reschedule">((resolve) => {
          resolveFirstSend = resolve;
        });
      }
      return Promise.resolve(true);
    });
    const loop = createDraftStreamLoop({
      throttleMs: 1000,
      isStopped: () => false,
      sendOrEditStreamMessage,
    });

    loop.update("first");
    expect(sendOrEditStreamMessage).toHaveBeenCalledTimes(1);

    loop.update("second");
    let flushResolved = false;
    const flushPromise = loop.flush().then(() => {
      flushResolved = true;
    });

    resolveFirstSend?.("reschedule");
    await Promise.resolve();
    await Promise.resolve();

    expect(flushResolved).toBe(false);
    expect(sendOrEditStreamMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(flushResolved).toBe(false);
    expect(sendOrEditStreamMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await flushPromise;

    expect(flushResolved).toBe(true);
    expect(sendOrEditStreamMessage).toHaveBeenCalledTimes(2);
    expect(sendOrEditStreamMessage.mock.calls[1]?.[0]).toBe("second");
  });

  it("drains rescheduled buffered text immediately", async () => {
    let resolveFirstSend: ((value: boolean | "reschedule") => void) | undefined;
    const sendOrEditStreamMessage = vi.fn((text: string) => {
      if (text === "first") {
        return new Promise<boolean | "reschedule">((resolve) => {
          resolveFirstSend = resolve;
        });
      }
      return Promise.resolve(true);
    });
    const loop = createDraftStreamLoop({
      throttleMs: 1000,
      isStopped: () => false,
      sendOrEditStreamMessage,
    });

    loop.update("first");
    expect(sendOrEditStreamMessage).toHaveBeenCalledTimes(1);

    loop.update("second");
    const drainPromise = loop.drain();
    resolveFirstSend?.("reschedule");
    await drainPromise;

    expect(sendOrEditStreamMessage).toHaveBeenCalledTimes(2);
    expect(sendOrEditStreamMessage.mock.calls[1]?.[0]).toBe("second");
  });
});
