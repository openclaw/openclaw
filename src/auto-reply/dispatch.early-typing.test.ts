import { afterEach, describe, expect, it, vi } from "vitest";
import { createReplyDispatcherWithTyping } from "./reply/reply-dispatcher.js";

describe("reply dispatcher early typing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates an eager typing controller only for opt-in paths", () => {
    const optedIn = createReplyDispatcherWithTyping({
      deliver: async () => undefined,
      onReplyStart: async () => undefined,
      earlyTyping: {
        start: "accepted_inbound",
        typingIntervalSeconds: 1,
      },
    });
    const defaultPath = createReplyDispatcherWithTyping({
      deliver: async () => undefined,
      onReplyStart: async () => undefined,
    });

    expect(optedIn.replyOptions.earlyTyping?.controller).toBeDefined();
    expect(optedIn.replyOptions.earlyTyping?.start).toBe("accepted_inbound");
    expect(defaultPath.replyOptions.earlyTyping).toBeUndefined();
  });

  it("uses the configured typing interval for eager early-typing controllers", async () => {
    vi.useFakeTimers();
    const onReplyStart = vi.fn(async () => undefined);
    const { replyOptions, markRunComplete, markDispatchIdle } = createReplyDispatcherWithTyping({
      deliver: async () => undefined,
      onReplyStart,
      earlyTyping: {
        start: "accepted_inbound",
        typingIntervalSeconds: 1,
      },
    });

    const typing = replyOptions.earlyTyping?.controller;
    expect(typing).toBeDefined();

    await typing?.startTypingLoop();
    expect(onReplyStart).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(onReplyStart).toHaveBeenCalledTimes(2);

    markRunComplete();
    markDispatchIdle();
  });
});
