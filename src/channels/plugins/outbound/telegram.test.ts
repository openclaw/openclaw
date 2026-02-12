import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { telegramOutbound } from "./telegram.js";

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

describe("telegramOutbound.resolveTarget", () => {
  const resolve = telegramOutbound.resolveTarget!;

  it("returns explicit to when provided", () => {
    expect(resolve({ to: "12345", allowFrom: ["99999"], mode: "explicit" })).toEqual({
      ok: true,
      to: "12345",
    });
  });

  it("falls back to allowFrom[0] in implicit mode when to is empty", () => {
    expect(resolve({ to: "", allowFrom: ["12345"], mode: "implicit" })).toEqual({
      ok: true,
      to: "12345",
    });
  });

  it("falls back to allowFrom[0] in heartbeat mode when to is empty", () => {
    expect(resolve({ to: undefined, allowFrom: ["12345"], mode: "heartbeat" })).toEqual({
      ok: true,
      to: "12345",
    });
  });

  it("does NOT fall back to allowFrom in explicit mode", () => {
    const result = resolve({ to: "", allowFrom: ["12345"], mode: "explicit" });
    expect(result.ok).toBe(false);
  });

  it("returns error when to is empty and allowFrom is empty", () => {
    const result = resolve({ to: "", allowFrom: [], mode: "implicit" });
    expect(result.ok).toBe(false);
  });

  it("returns error when to is empty and no allowFrom", () => {
    const result = resolve({ to: undefined, mode: "implicit" });
    expect(result.ok).toBe(false);
  });
});
