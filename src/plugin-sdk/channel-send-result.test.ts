import { expect, it } from "vitest";
import {
  attachChannelToResult,
  attachChannelToResults,
  buildChannelSendResult,
  createAttachedChannelResultAdapter,
  createEmptyChannelResult,
  createRawChannelSendResultAdapter,
} from "./channel-send-result.js";

it("stamps channel metadata on single and batch results", () => {
  const result = { messageId: "m1", ok: true, extra: "value" };
  expect(attachChannelToResult("discord", result)).toEqual({
    channel: "discord",
    messageId: "m1",
    ok: true,
    extra: "value",
  });

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
it("normalizes raw send results directly", () => {
  const result = buildChannelSendResult("zalo", {
    ok: false,
    messageId: null,
    error: "boom",
  });

  expect(result).toEqual({ channel: "zalo", ok: false, messageId: "", error: new Error("boom") });
});
it("builds an empty outbound result with channel metadata", () => {
  expect(createEmptyChannelResult("line", { target: { kind: "chat", id: "u1" } })).toEqual({
    channel: "line",
    messageId: "",
    target: { kind: "chat", id: "u1" },
  });
});
it("wraps outbound delivery and poll results", async () => {
  const adapter = createAttachedChannelResultAdapter({
    channel: "discord",
    sendText: async () => ({
      messageId: "m1",
      target: { kind: "channel", id: "c1" },
    }),
    sendMedia: async () => ({ messageId: "m2" }),
    sendPoll: async () => ({ messageId: "m3", pollId: "p1" }),
  });

  const ctx = { cfg: {}, to: "x", text: "hi" };
  await expect(adapter.sendText!(ctx)).resolves.toEqual({
    channel: "discord",
    messageId: "m1",
    target: { kind: "channel", id: "c1" },
  });
  await expect(adapter.sendMedia!(ctx)).resolves.toEqual({ channel: "discord", messageId: "m2" });
  await expect(
    adapter.sendPoll!({ ...ctx, poll: { question: "t", options: ["a", "b"] } }),
  ).resolves.toEqual({ channel: "discord", messageId: "m3", pollId: "p1" });
});
it("normalizes successes and rejects provider failures", async () => {
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
  await expect(adapter.sendMedia!({ cfg: {} as never, to: "x", text: "hi" })).rejects.toThrow(
    "boom",
  );
});

it("uses a channel-specific error when a failed result has no message", async () => {
  const adapter = createRawChannelSendResultAdapter({
    channel: "legacy-test",
    sendText: async () => ({ ok: false }),
  });

  await expect(adapter.sendText!({ cfg: {} as never, to: "x", text: "hi" })).rejects.toThrow(
    "Channel send failed for legacy-test",
  );
});
