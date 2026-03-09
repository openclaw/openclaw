import { describe, expect, it } from "vitest";
import { isNumericTargetId, sendPayloadWithChunkedTextAndMedia } from "./reply-payload.js";

describe("sendPayloadWithChunkedTextAndMedia", () => {
  it("returns empty result when payload has no text and no media", async () => {
    const result = await sendPayloadWithChunkedTextAndMedia({
      ctx: { payload: {} },
      sendText: async () => ({ channel: "test", messageId: "text" }),
      sendMedia: async () => ({ channel: "test", messageId: "media" }),
      emptyResult: { channel: "test", messageId: "" },
    });
    expect(result).toEqual({ channel: "test", messageId: "" });
  });

  it("sends first media with text and remaining media without text", async () => {
    const calls: Array<{ text: string; mediaUrl: string }> = [];
    const result = await sendPayloadWithChunkedTextAndMedia({
      ctx: {
        payload: { text: "hello", mediaUrls: ["https://a", "https://b"] },
      },
      sendText: async () => ({ channel: "test", messageId: "text" }),
      sendMedia: async (ctx) => {
        calls.push({ text: ctx.text, mediaUrl: ctx.mediaUrl });
        return { channel: "test", messageId: ctx.mediaUrl };
      },
      emptyResult: { channel: "test", messageId: "" },
    });
    expect(calls).toEqual([
      { text: "hello", mediaUrl: "https://a" },
      { text: "", mediaUrl: "https://b" },
    ]);
    expect(result).toEqual({ channel: "test", messageId: "https://b" });
  });

  it("chunks text and sends each chunk", async () => {
    const chunks: string[] = [];
    const result = await sendPayloadWithChunkedTextAndMedia({
      ctx: { payload: { text: "alpha beta gamma" } },
      textChunkLimit: 5,
      chunker: () => ["alpha", "beta", "gamma"],
      sendText: async (ctx) => {
        chunks.push(ctx.text);
        return { channel: "test", messageId: ctx.text };
      },
      sendMedia: async () => ({ channel: "test", messageId: "media" }),
      emptyResult: { channel: "test", messageId: "" },
    });
    expect(chunks).toEqual(["alpha", "beta", "gamma"]);
    expect(result).toEqual({ channel: "test", messageId: "gamma" });
  });

  it("detects numeric target IDs", () => {
    expect(isNumericTargetId("12345")).toBe(true);
    expect(isNumericTargetId("  987  ")).toBe(true);
    expect(isNumericTargetId("ab12")).toBe(false);
    expect(isNumericTargetId("")).toBe(false);
  });
});
