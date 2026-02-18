import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { telegramOutbound } from "./telegram.js";

const sendPollTelegramMock = vi.fn();

vi.mock("../../../telegram/send.js", async () => {
  const actual = await vi.importActual<typeof import("../../../telegram/send.js")>(
    "../../../telegram/send.js",
  );
  return {
    ...actual,
    sendPollTelegram: (...args: unknown[]) => sendPollTelegramMock(...args),
  };
});

describe("telegramOutbound.sendPayload", () => {
  it("sends text payload with buttons", async () => {
    const sendTelegram = vi.fn(async () => ({ messageId: "m1", chatId: "c1" }));

    const result = await telegramOutbound.sendPayload?.({
      cfg: {} as OpenClawConfig,
      to: "telegram:123",
      text: "ignored",
      payload: {
        text: "Hello",
        channelData: {
          telegram: {
            buttons: [[{ text: "Option", callback_data: "/option" }]],
          },
        },
      },
      deps: { sendTelegram },
    });

    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram).toHaveBeenCalledWith(
      "telegram:123",
      "Hello",
      expect.objectContaining({
        buttons: [[{ text: "Option", callback_data: "/option" }]],
        textMode: "html",
      }),
    );
    expect(result).toEqual({ channel: "telegram", messageId: "m1", chatId: "c1" });
  });

  it("sends media payloads and attaches buttons only to first", async () => {
    const sendTelegram = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "m1", chatId: "c1" })
      .mockResolvedValueOnce({ messageId: "m2", chatId: "c1" });

    const result = await telegramOutbound.sendPayload?.({
      cfg: {} as OpenClawConfig,
      to: "telegram:123",
      text: "ignored",
      payload: {
        text: "Caption",
        mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
        channelData: {
          telegram: {
            buttons: [[{ text: "Go", callback_data: "/go" }]],
          },
        },
      },
      deps: { sendTelegram },
    });

    expect(sendTelegram).toHaveBeenCalledTimes(2);
    expect(sendTelegram).toHaveBeenNthCalledWith(
      1,
      "telegram:123",
      "Caption",
      expect.objectContaining({
        mediaUrl: "https://example.com/a.png",
        buttons: [[{ text: "Go", callback_data: "/go" }]],
      }),
    );
    const secondOpts = sendTelegram.mock.calls[1]?.[2] as { buttons?: unknown } | undefined;
    expect(sendTelegram).toHaveBeenNthCalledWith(
      2,
      "telegram:123",
      "",
      expect.objectContaining({
        mediaUrl: "https://example.com/b.png",
      }),
    );
    expect(secondOpts?.buttons).toBeUndefined();
    expect(result).toEqual({ channel: "telegram", messageId: "m2", chatId: "c1" });
  });
});

describe("telegramOutbound.sendPoll", () => {
  it("forwards poll params to sendPollTelegram", async () => {
    sendPollTelegramMock.mockReset();
    sendPollTelegramMock.mockResolvedValue({
      messageId: "p1",
      chatId: "c1",
      pollId: "poll1",
    });

    const result = await telegramOutbound.sendPoll?.({
      cfg: {} as OpenClawConfig,
      to: "telegram:123",
      poll: {
        question: "Snack?",
        options: ["Pizza", "Sushi"],
        maxSelections: 1,
      },
      accountId: "acc1",
      threadId: "99",
      silent: true,
      isAnonymous: false,
    });

    expect(sendPollTelegramMock).toHaveBeenCalledTimes(1);
    expect(sendPollTelegramMock).toHaveBeenCalledWith(
      "telegram:123",
      {
        question: "Snack?",
        options: ["Pizza", "Sushi"],
        maxSelections: 1,
      },
      {
        accountId: "acc1",
        messageThreadId: 99,
        silent: true,
        isAnonymous: false,
      },
    );
    expect(result).toEqual({ messageId: "p1", chatId: "c1", pollId: "poll1" });
  });
});
