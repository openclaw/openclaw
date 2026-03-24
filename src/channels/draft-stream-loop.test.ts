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
    await vi.waitFor(() => expect(sendOrEditStreamMessage).toHaveBeenCalledTimes(1));

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
});
