import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { imessageOutbound } from "./imessage.js";

describe("imessageOutbound", () => {
  const cfg: OpenClawConfig = {
    channels: {
      imessage: {
        mediaMaxMb: 2,
      },
    },
  };

  it("passes replyToId through sendText", async () => {
    const sendIMessage = vi.fn().mockResolvedValue({ messageId: "text-1" });
    const sendText = imessageOutbound.sendText;
    expect(sendText).toBeDefined();

    const result = await sendText!({
      cfg,
      to: "chat_id:123",
      text: "hello",
      accountId: "default",
      replyToId: "msg-123",
      deps: { sendIMessage },
    });

    expect(sendIMessage).toHaveBeenCalledWith(
      "chat_id:123",
      "hello",
      expect.objectContaining({
        replyToId: "msg-123",
        accountId: "default",
        maxBytes: 2 * 1024 * 1024,
      }),
    );
    expect(result).toEqual({ channel: "imessage", messageId: "text-1" });
  });

  it("passes replyToId through sendMedia", async () => {
    const sendIMessage = vi.fn().mockResolvedValue({ messageId: "media-1" });
    const sendMedia = imessageOutbound.sendMedia;
    expect(sendMedia).toBeDefined();

    const result = await sendMedia!({
      cfg,
      to: "chat_id:123",
      text: "caption",
      mediaUrl: "https://example.com/file.jpg",
      mediaLocalRoots: ["/tmp"],
      accountId: "acct-1",
      replyToId: "msg-456",
      deps: { sendIMessage },
    });

    expect(sendIMessage).toHaveBeenCalledWith(
      "chat_id:123",
      "caption",
      expect.objectContaining({
        mediaUrl: "https://example.com/file.jpg",
        mediaLocalRoots: ["/tmp"],
        replyToId: "msg-456",
        accountId: "acct-1",
        maxBytes: 2 * 1024 * 1024,
      }),
    );
    expect(result).toEqual({ channel: "imessage", messageId: "media-1" });
  });

  it("routes audioAsVoice payloads through sendPayload and sends text separately", async () => {
    const sendIMessage = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "voice-1" })
      .mockResolvedValueOnce({ messageId: "text-1" })
      .mockResolvedValueOnce({ messageId: "extra-1" });
    const sendPayload = imessageOutbound.sendPayload;
    expect(sendPayload).toBeDefined();

    const result = await sendPayload!({
      cfg,
      to: "chat_id:123",
      text: "voice caption",
      payload: {
        text: "voice caption",
        mediaUrls: ["https://example.com/voice.m4a", "https://example.com/extra.png"],
        audioAsVoice: true,
      },
      mediaLocalRoots: ["/tmp"],
      accountId: "acct-1",
      replyToId: "msg-voice",
      deps: { sendIMessage },
    });

    expect(sendIMessage).toHaveBeenNthCalledWith(
      1,
      "chat_id:123",
      "",
      expect.objectContaining({
        audioAsVoice: true,
        mediaUrl: "https://example.com/voice.m4a",
        mediaLocalRoots: ["/tmp"],
        replyToId: "msg-voice",
        accountId: "acct-1",
        maxBytes: 2 * 1024 * 1024,
      }),
    );
    expect(sendIMessage).toHaveBeenNthCalledWith(
      2,
      "chat_id:123",
      "voice caption",
      expect.objectContaining({
        replyToId: "msg-voice",
        accountId: "acct-1",
        maxBytes: 2 * 1024 * 1024,
      }),
    );
    expect(sendIMessage).toHaveBeenNthCalledWith(
      3,
      "chat_id:123",
      "",
      expect.objectContaining({
        mediaUrl: "https://example.com/extra.png",
        mediaLocalRoots: ["/tmp"],
        replyToId: "msg-voice",
        accountId: "acct-1",
        maxBytes: 2 * 1024 * 1024,
      }),
    );
    expect(result).toEqual({ channel: "imessage", messageId: "extra-1" });
  });
});
