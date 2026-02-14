import { describe, expect, it } from "vitest";
import { applyReplyThreading } from "./reply-payloads.js";

describe("applyReplyThreading auto-threading", () => {
  it("sets replyToId to currentMessageId even without [[reply_to_current]] tag", () => {
    const result = applyReplyThreading({
      payloads: [{ text: "Hello" }],
      replyToMode: "first",
      currentMessageId: "42",
    });

    expect(result).toHaveLength(1);
    expect(result[0].replyToId).toBe("42");
  });

  it("threads only first payload when mode is 'first'", () => {
    const result = applyReplyThreading({
      payloads: [{ text: "A" }, { text: "B" }],
      replyToMode: "first",
      currentMessageId: "42",
    });

    expect(result).toHaveLength(2);
    expect(result[0].replyToId).toBe("42");
    expect(result[1].replyToId).toBeUndefined();
  });

  it("threads all payloads when mode is 'all'", () => {
    const result = applyReplyThreading({
      payloads: [{ text: "A" }, { text: "B" }],
      replyToMode: "all",
      currentMessageId: "42",
    });

    expect(result).toHaveLength(2);
    expect(result[0].replyToId).toBe("42");
    expect(result[1].replyToId).toBe("42");
  });

  it("strips replyToId when mode is 'off'", () => {
    const result = applyReplyThreading({
      payloads: [{ text: "A" }],
      replyToMode: "off",
      currentMessageId: "42",
    });

    expect(result).toHaveLength(1);
    expect(result[0].replyToId).toBeUndefined();
  });

  it("does not bypass off mode for Slack when reply is implicit", () => {
    const result = applyReplyThreading({
      payloads: [{ text: "A" }],
      replyToMode: "off",
      replyToChannel: "slack",
      currentMessageId: "42",
    });

    expect(result).toHaveLength(1);
    expect(result[0].replyToId).toBeUndefined();
  });

  it("keeps explicit tags for Slack when off mode allows tags", () => {
    const result = applyReplyThreading({
      payloads: [{ text: "[[reply_to_current]]A" }],
      replyToMode: "off",
      replyToChannel: "slack",
      currentMessageId: "42",
    });

    expect(result).toHaveLength(1);
    expect(result[0].replyToId).toBe("42");
    expect(result[0].replyToTag).toBe(true);
  });

  it("keeps explicit tags for Telegram when off mode is enabled", () => {
    const result = applyReplyThreading({
      payloads: [{ text: "[[reply_to_current]]A" }],
      replyToMode: "off",
      replyToChannel: "telegram",
      currentMessageId: "42",
    });

    expect(result).toHaveLength(1);
    expect(result[0].replyToId).toBe("42");
    expect(result[0].replyToTag).toBe(true);
  });
});
