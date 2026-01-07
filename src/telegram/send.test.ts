import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadWebMedia } = vi.hoisted(() => ({
  loadWebMedia: vi.fn(),
}));

vi.mock("../web/media.js", () => ({
  loadWebMedia,
}));

import { reactMessageTelegram, sendMessageTelegram } from "./send.js";

describe("sendMessageTelegram", () => {
  beforeEach(() => {
    loadWebMedia.mockReset();
  });

  it("falls back to plain text when Telegram rejects Markdown", async () => {
    const chatId = "123";
    const parseErr = new Error(
      "400: Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 9",
    );
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(parseErr)
      .mockResolvedValueOnce({
        message_id: 42,
        chat: { id: chatId },
      });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    const res = await sendMessageTelegram(chatId, "_oops_", {
      token: "tok",
      api,
      verbose: true,
    });

    expect(sendMessage).toHaveBeenNthCalledWith(1, chatId, "_oops_", {
      parse_mode: "Markdown",
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, chatId, "_oops_");
    expect(res.chatId).toBe(chatId);
    expect(res.messageId).toBe("42");
  });

  it("normalizes chat ids with internal prefixes", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 1,
      chat: { id: "123" },
    });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await sendMessageTelegram("telegram:123", "hi", {
      token: "tok",
      api,
    });

    expect(sendMessage).toHaveBeenCalledWith("123", "hi", {
      parse_mode: "Markdown",
    });
  });

  it("wraps chat-not-found with actionable context", async () => {
    const chatId = "123";
    const err = new Error("400: Bad Request: chat not found");
    const sendMessage = vi.fn().mockRejectedValue(err);
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await expect(
      sendMessageTelegram(chatId, "hi", { token: "tok", api }),
    ).rejects.toThrow(/chat not found/i);
    await expect(
      sendMessageTelegram(chatId, "hi", { token: "tok", api }),
    ).rejects.toThrow(/chat_id=123/);
  });

  it("retries on transient errors with retry_after", async () => {
    vi.useFakeTimers();
    const chatId = "123";
    const err = Object.assign(new Error("429"), {
      parameters: { retry_after: 0.5 },
    });
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({
        message_id: 1,
        chat: { id: chatId },
      });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    const promise = sendMessageTelegram(chatId, "hi", {
      token: "tok",
      api,
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 1000, jitter: 0 },
    });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ messageId: "1", chatId });
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(500);
    setTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it("does not retry on non-transient errors", async () => {
    const chatId = "123";
    const sendMessage = vi
      .fn()
      .mockRejectedValue(new Error("400: Bad Request"));
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await expect(
      sendMessageTelegram(chatId, "hi", {
        token: "tok",
        api,
        retry: { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }),
    ).rejects.toThrow(/Bad Request/);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("sends GIF media as animation", async () => {
    const chatId = "123";
    const sendAnimation = vi.fn().mockResolvedValue({
      message_id: 9,
      chat: { id: chatId },
    });
    const api = { sendAnimation } as unknown as {
      sendAnimation: typeof sendAnimation;
    };

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("GIF89a"),
      fileName: "fun.gif",
    });

    const res = await sendMessageTelegram(chatId, "caption", {
      token: "tok",
      api,
      mediaUrl: "https://example.com/fun",
    });

    expect(sendAnimation).toHaveBeenCalledTimes(1);
    expect(sendAnimation).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: "caption",
    });
    expect(res.messageId).toBe("9");
  });
});

describe("reactMessageTelegram", () => {
  it("sends emoji reactions", async () => {
    const setMessageReaction = vi.fn().mockResolvedValue(undefined);
    const api = { setMessageReaction } as unknown as {
      setMessageReaction: typeof setMessageReaction;
    };

    await reactMessageTelegram("telegram:123", "456", "✅", {
      token: "tok",
      api,
    });

    expect(setMessageReaction).toHaveBeenCalledWith("123", 456, [
      { type: "emoji", emoji: "✅" },
    ]);
  });

  it("removes reactions when emoji is empty", async () => {
    const setMessageReaction = vi.fn().mockResolvedValue(undefined);
    const api = { setMessageReaction } as unknown as {
      setMessageReaction: typeof setMessageReaction;
    };

    await reactMessageTelegram("123", 456, "", {
      token: "tok",
      api,
    });

    expect(setMessageReaction).toHaveBeenCalledWith("123", 456, []);
  });

  it("removes reactions when remove flag is set", async () => {
    const setMessageReaction = vi.fn().mockResolvedValue(undefined);
    const api = { setMessageReaction } as unknown as {
      setMessageReaction: typeof setMessageReaction;
    };

    await reactMessageTelegram("123", 456, "✅", {
      token: "tok",
      api,
      remove: true,
    });

    expect(setMessageReaction).toHaveBeenCalledWith("123", 456, []);
  });
});
