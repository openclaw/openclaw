import { describe, expect, it } from "vitest";
import { buildReplyPayloads } from "./agent-runner-payloads.js";

const baseParams = {
  isHeartbeat: false,
  didLogHeartbeatStrip: false,
  blockStreamingEnabled: false,
  blockReplyPipeline: null,
  replyToMode: "off" as const,
};

describe("buildReplyPayloads media filter integration", () => {
  it("strips media URL from payload when in messagingToolSentMediaUrls", () => {
    const { replyPayloads } = buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }],
      messagingToolSentMediaUrls: ["file:///tmp/photo.jpg"],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0].mediaUrl).toBeUndefined();
  });

  it("preserves media URL when not in messagingToolSentMediaUrls", () => {
    const { replyPayloads } = buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }],
      messagingToolSentMediaUrls: ["file:///tmp/other.jpg"],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0].mediaUrl).toBe("file:///tmp/photo.jpg");
  });

  it("applies media filter after text filter", () => {
    const { replyPayloads } = buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello world!", mediaUrl: "file:///tmp/photo.jpg" }],
      messagingToolSentTexts: ["hello world!"],
      messagingToolSentMediaUrls: ["file:///tmp/photo.jpg"],
    });

    // Text filter removes the payload entirely (text matched), so nothing remains.
    expect(replyPayloads).toHaveLength(0);
  });

  it("does not dedupe text for cross-target messaging sends", () => {
    const { replyPayloads } = buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello world!" }],
      messageProvider: "telegram",
      originatingTo: "telegram:123",
      messagingToolSentTexts: ["hello world!"],
      messagingToolSentTargets: [{ tool: "discord", provider: "discord", to: "channel:C1" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.text).toBe("hello world!");
  });

  it("does not dedupe media for cross-target messaging sends", () => {
    const { replyPayloads } = buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "photo", mediaUrl: "file:///tmp/photo.jpg" }],
      messageProvider: "telegram",
      originatingTo: "telegram:123",
      messagingToolSentMediaUrls: ["file:///tmp/photo.jpg"],
      messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.mediaUrl).toBe("file:///tmp/photo.jpg");
  });

  it("suppresses same-target replies when messageProvider is synthetic but originatingChannel is set", () => {
    const { replyPayloads } = buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello world!" }],
      messageProvider: "heartbeat",
      originatingChannel: "telegram",
      originatingTo: "268300329",
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [{ tool: "telegram", provider: "telegram", to: "268300329" }],
    });

    expect(replyPayloads).toHaveLength(0);
  });
});
