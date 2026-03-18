import { describe, expect, it } from "vitest";
import {
  attachChannelToResult,
  attachChannelToResults,
  buildChannelSendResult,
  createAttachedChannelResultAdapter,
  createEmptyChannelResult,
  createRawChannelSendResultAdapter,
} from "./channel-send-result.js";

describe("attachChannelToResult", () => {
  it("preserves the existing result shape and stamps the channel", () => {
    expect(
      attachChannelToResult("discord", {
        messageId: "m1",
        ok: true,
        extra: "value",
      }),
    ).toEqual({
      channel: "discord",
      messageId: "m1",
      ok: true,
      extra: "value",
    });
  });
});

describe("attachChannelToResults", () => {
  it("stamps each result in a list with the shared channel id", () => {
    expect(
      attachChannelToResults("signal", [
        { messageId: "m1", timestamp: 1 },
        { messageId: "m2", timestamp: 2 },
      ]),
    ).toEqual([
      { channel: "signal", messageId: "m1", timestamp: 1 },
      { channel: "signal", messageId: "m2", timestamp: 2 },
    ]);
  });
});

describe("buildChannelSendResult", () => {
  it("normalizes raw send results", () => {
    const result = buildChannelSendResult("zalo", {
      ok: false,
      messageId: null,
      error: "boom",
    });

    expect(result.channel).toBe("zalo");
    expect(result.ok).toBe(false);
    expect(result.messageId).toBe("");
    expect(result.error).toEqual(new Error("boom"));
  });
});

describe("createEmptyChannelResult", () => {
  it("builds an empty outbound result with channel metadata", () => {
    expect(createEmptyChannelResult("line", { chatId: "u1" })).toEqual({
      channel: "line",
      messageId: "",
      chatId: "u1",
    });
  });
});

describe("createAttachedChannelResultAdapter", () => {
  it("wraps outbound delivery and poll results", async () => {
    const adapter = createAttachedChannelResultAdapter({
      channel: "discord",
      sendText: async () => ({ messageId: "m1", channelId: "c1" }),
      sendMedia: async () => ({ messageId: "m2" }),
      sendPoll: async () => ({ messageId: "m3", pollId: "p1" }),
    });

    await expect(adapter.sendText!({ cfg: {} as never, to: "x", text: "hi" })).resolves.toEqual({
      channel: "discord",
      messageId: "m1",
      channelId: "c1",
    });
    await expect(adapter.sendMedia!({ cfg: {} as never, to: "x", text: "hi" })).resolves.toEqual({
      channel: "discord",
      messageId: "m2",
    });
    await expect(
      adapter.sendPoll!({
        cfg: {} as never,
        to: "x",
        poll: { question: "t", options: ["a", "b"] },
      }),
    ).resolves.toEqual({
      channel: "discord",
      messageId: "m3",
      pollId: "p1",
    });
  });
});

describe("createRawChannelSendResultAdapter", () => {
  it("normalizes raw send results", async () => {
    const adapter = createRawChannelSendResultAdapter({
      channel: "zalo",
      sendText: async () => ({ ok: true, messageId: "m1" }),
      sendMedia: async () => ({ ok: false, error: "boom" }),
    });

    await expect(adapter.sendText!({ cfg: {} as never, to: "x", text: "hi" })).resolves.toEqual({
      channel: "zalo",
      ok: true,
      messageId: "m1",
      error: undefined,
    });
    await expect(adapter.sendMedia!({ cfg: {} as never, to: "x", text: "hi" })).resolves.toEqual({
      channel: "zalo",
      ok: false,
      messageId: "",
      error: new Error("boom"),
    });
  });
});
