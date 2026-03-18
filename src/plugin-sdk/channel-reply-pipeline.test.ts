import { describe, expect, it, vi } from "vitest";
import { createChannelReplyPipeline } from "./channel-reply-pipeline.js";

describe("createChannelReplyPipeline", () => {
  it("builds prefix options without forcing typing support", () => {
    const pipeline = createChannelReplyPipeline({
      cfg: {},
      agentId: "main",
      channel: "telegram",
      accountId: "default",
    });

    expect(typeof pipeline.onModelSelected).toBe("function");
    expect(typeof pipeline.responsePrefixContextProvider).toBe("function");
    expect(pipeline.typingCallbacks).toBeUndefined();
  });

  it("builds typing callbacks when typing config is provided", async () => {
    const start = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const pipeline = createChannelReplyPipeline({
      cfg: {},
      agentId: "main",
      channel: "discord",
      accountId: "default",
      typing: {
        start,
        stop,
        onStartError: () => {},
      },
    });

    await pipeline.typingCallbacks?.onReplyStart();
    pipeline.typingCallbacks?.onIdle?.();

    expect(start).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
  });
});
