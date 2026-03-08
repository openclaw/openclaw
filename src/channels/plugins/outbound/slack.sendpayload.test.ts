import { describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../../auto-reply/types.js";
import { slackOutbound } from "./slack.js";

function baseCtx(payload: ReplyPayload) {
  return {
    cfg: {},
    to: "C12345",
    text: "",
    payload,
    deps: {
      sendSlack: vi
        .fn()
        .mockResolvedValue({ messageId: "sl-1", channelId: "C12345", ts: "1234.5678" }),
    },
  };
}

describe("slackOutbound sendPayload", () => {
  it("text-only delegates to sendText", async () => {
    const ctx = baseCtx({ text: "hello" });
    const result = await slackOutbound.sendPayload!(ctx);

    expect(ctx.deps.sendSlack).toHaveBeenCalledTimes(1);
    expect(ctx.deps.sendSlack).toHaveBeenCalledWith("C12345", "hello", expect.any(Object));
    expect(result).toMatchObject({ channel: "slack" });
  });

  it("single media delegates to sendMedia", async () => {
    const ctx = baseCtx({ text: "cap", mediaUrl: "https://example.com/a.jpg" });
    const result = await slackOutbound.sendPayload!(ctx);

    expect(ctx.deps.sendSlack).toHaveBeenCalledTimes(1);
    expect(ctx.deps.sendSlack).toHaveBeenCalledWith(
      "C12345",
      "cap",
      expect.objectContaining({ mediaUrl: "https://example.com/a.jpg" }),
    );
    expect(result).toMatchObject({ channel: "slack" });
  });

  it("multi-media iterates URLs with caption on first", async () => {
    const sendSlack = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "sl-1", channelId: "C12345" })
      .mockResolvedValueOnce({ messageId: "sl-2", channelId: "C12345" });
    const ctx = {
      cfg: {},
      to: "C12345",
      text: "",
      payload: {
        text: "caption",
        mediaUrls: ["https://example.com/1.jpg", "https://example.com/2.jpg"],
      } as ReplyPayload,
      deps: { sendSlack },
    };
    const result = await slackOutbound.sendPayload!(ctx);

    expect(sendSlack).toHaveBeenCalledTimes(2);
    expect(sendSlack).toHaveBeenNthCalledWith(
      1,
      "C12345",
      "caption",
      expect.objectContaining({ mediaUrl: "https://example.com/1.jpg" }),
    );
    expect(sendSlack).toHaveBeenNthCalledWith(
      2,
      "C12345",
      "",
      expect.objectContaining({ mediaUrl: "https://example.com/2.jpg" }),
    );
    expect(result).toMatchObject({ channel: "slack", messageId: "sl-2" });
  });

  it("empty payload returns no-op", async () => {
    const ctx = baseCtx({});
    const result = await slackOutbound.sendPayload!(ctx);

    expect(ctx.deps.sendSlack).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "slack", messageId: "" });
  });

  it("text exceeding chunk limit is sent as-is when chunker is null", async () => {
    // Slack has chunker: null, so long text should be sent as a single message
    const ctx = baseCtx({ text: "a".repeat(5000) });
    const result = await slackOutbound.sendPayload!(ctx);

    expect(ctx.deps.sendSlack).toHaveBeenCalledTimes(1);
    expect(ctx.deps.sendSlack).toHaveBeenCalledWith("C12345", "a".repeat(5000), expect.any(Object));
    expect(result).toMatchObject({ channel: "slack" });
  });
});
