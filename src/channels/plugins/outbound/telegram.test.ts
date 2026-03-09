import { describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../../auto-reply/types.js";
import { telegramOutbound } from "./telegram.js";

describe("telegramOutbound", () => {
  it("passes parsed reply/thread ids for sendText", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "tg-text-1", chatId: "123" });
    const sendText = telegramOutbound.sendText;
    expect(sendText).toBeDefined();

    const result = await sendText!({
      cfg: {},
      to: "123",
      text: "<b>hello</b>",
      accountId: "work",
      replyToId: "44",
      threadId: "55",
      deps: { sendTelegram },
    });

    expect(sendTelegram).toHaveBeenCalledWith(
      "123",
      "<b>hello</b>",
      expect.objectContaining({
        textMode: "html",
        verbose: false,
        accountId: "work",
        replyToMessageId: 44,
        messageThreadId: 55,
      }),
    );
    expect(result).toEqual({ channel: "telegram", messageId: "tg-text-1", chatId: "123" });
  });

  it("parses scoped DM thread ids for sendText", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "tg-text-2", chatId: "12345" });
    const sendText = telegramOutbound.sendText;
    expect(sendText).toBeDefined();

    await sendText!({
      cfg: {},
      to: "12345",
      text: "<b>hello</b>",
      accountId: "work",
      threadId: "12345:99",
      deps: { sendTelegram },
    });

    expect(sendTelegram).toHaveBeenCalledWith(
      "12345",
      "<b>hello</b>",
      expect.objectContaining({
        textMode: "html",
        verbose: false,
        accountId: "work",
        messageThreadId: 99,
      }),
    );
  });

  it("passes media options for sendMedia", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "tg-media-1", chatId: "123" });
    const sendMedia = telegramOutbound.sendMedia;
    expect(sendMedia).toBeDefined();

    const result = await sendMedia!({
      cfg: {},
      to: "123",
      text: "caption",
      mediaUrl: "https://example.com/a.jpg",
      mediaLocalRoots: ["/tmp/media"],
      accountId: "default",
      deps: { sendTelegram },
    });

    expect(sendTelegram).toHaveBeenCalledWith(
      "123",
      "caption",
      expect.objectContaining({
        textMode: "html",
        verbose: false,
        mediaUrl: "https://example.com/a.jpg",
        mediaLocalRoots: ["/tmp/media"],
      }),
    );
    expect(result).toEqual({ channel: "telegram", messageId: "tg-media-1", chatId: "123" });
  });

  it("sends payload media list and applies buttons only to first message", async () => {
    const sendTelegram = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "tg-1", chatId: "123" })
      .mockResolvedValueOnce({ messageId: "tg-2", chatId: "123" });
    const sendPayload = telegramOutbound.sendPayload;
    expect(sendPayload).toBeDefined();

    const payload: ReplyPayload = {
      text: "caption",
      mediaUrls: ["https://example.com/1.jpg", "https://example.com/2.jpg"],
      channelData: {
        telegram: {
          quoteText: "quoted",
          buttons: [[{ text: "Approve", callback_data: "ok" }]],
        },
      },
    };

    const result = await sendPayload!({
      cfg: {},
      to: "123",
      text: "",
      payload,
      mediaLocalRoots: ["/tmp/media"],
      accountId: "default",
      deps: { sendTelegram },
    });

    expect(sendTelegram).toHaveBeenCalledTimes(2);
    expect(sendTelegram).toHaveBeenNthCalledWith(
      1,
      "123",
      "caption",
      expect.objectContaining({
        mediaUrl: "https://example.com/1.jpg",
        quoteText: "quoted",
        buttons: [[{ text: "Approve", callback_data: "ok" }]],
      }),
    );
    expect(sendTelegram).toHaveBeenNthCalledWith(
      2,
      "123",
      "",
      expect.objectContaining({
        mediaUrl: "https://example.com/2.jpg",
      }),
    );
    const secondCallOpts = sendTelegram.mock.calls[1]?.[2] as Record<string, unknown>;
    expect(secondCallOpts?.buttons).toBeUndefined();
    expect(result).toEqual({ channel: "telegram", messageId: "tg-2", chatId: "123" });
  });

  it("chunks oversized text payloads to avoid Telegram message length errors", async () => {
    const sendTelegram = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "tg-1", chatId: "123" })
      .mockResolvedValueOnce({ messageId: "tg-2", chatId: "123" })
      .mockResolvedValueOnce({ messageId: "tg-3", chatId: "123" });

    const payload: ReplyPayload = {
      text: "a".repeat(9000),
      channelData: {
        telegram: {
          buttons: [[{ text: "Ok", callback_data: "ok" }]],
        },
      },
    };

    const result = await telegramOutbound.sendPayload?.({
      cfg: {},
      to: "123",
      text: "",
      payload,
      deps: { sendTelegram },
    });

    expect(sendTelegram).toHaveBeenCalledTimes(3);
    expect(sendTelegram.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ buttons: [[{ text: "Ok", callback_data: "ok" }]] }),
    );
    expect((sendTelegram.mock.calls[1]?.[2] as Record<string, unknown>)?.buttons).toBeUndefined();
    expect((sendTelegram.mock.calls[2]?.[2] as Record<string, unknown>)?.buttons).toBeUndefined();

    // Enforce per-chunk length safety.
    for (const call of sendTelegram.mock.calls) {
      const text = call[1] as string;
      expect(text.length).toBeLessThanOrEqual(4000);
    }

    expect(result).toEqual({ channel: "telegram", messageId: "tg-3", chatId: "123" });
  });

  it("splits long captions: first chunk rides on first media, remainder sent as follow-up text", async () => {
    const sendTelegram = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "tg-1", chatId: "123" })
      .mockResolvedValueOnce({ messageId: "tg-2", chatId: "123" })
      .mockResolvedValueOnce({ messageId: "tg-3", chatId: "123" });

    const payload: ReplyPayload = {
      text: "b".repeat(5000),
      mediaUrls: ["https://example.com/1.jpg", "https://example.com/2.jpg"],
      channelData: {
        telegram: {
          buttons: [[{ text: "Ok", callback_data: "ok" }]],
        },
      },
    };

    const result = await telegramOutbound.sendPayload?.({
      cfg: {},
      to: "123",
      text: "",
      payload,
      deps: { sendTelegram },
    });

    // 2 media sends + 1 follow-up text chunk
    expect(sendTelegram).toHaveBeenCalledTimes(3);

    // First media gets first chunk + buttons
    expect(sendTelegram).toHaveBeenNthCalledWith(
      1,
      "123",
      expect.any(String),
      expect.objectContaining({
        mediaUrl: "https://example.com/1.jpg",
        buttons: [[{ text: "Ok", callback_data: "ok" }]],
      }),
    );

    // Second media has empty caption
    expect(sendTelegram).toHaveBeenNthCalledWith(
      2,
      "123",
      "",
      expect.objectContaining({ mediaUrl: "https://example.com/2.jpg" }),
    );

    // Follow-up text has no mediaUrl
    const thirdOpts = sendTelegram.mock.calls[2]?.[2] as Record<string, unknown>;
    expect(thirdOpts?.mediaUrl).toBeUndefined();
    expect(thirdOpts?.buttons).toBeUndefined();

    expect(result).toEqual({ channel: "telegram", messageId: "tg-3", chatId: "123" });
  });
});
