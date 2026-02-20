import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { normalizeIMessageMessagingTarget } from "./normalize/imessage.js";
import { looksLikeSignalTargetId, normalizeSignalMessagingTarget } from "./normalize/signal.js";
import { normalizeSignalAccountInput } from "./onboarding/signal.js";
import { telegramOutbound } from "./outbound/telegram.js";
import { whatsappOutbound } from "./outbound/whatsapp.js";

describe("imessage target normalization", () => {
  it("preserves service prefixes for handles", () => {
    expect(normalizeIMessageMessagingTarget("sms:+1 (555) 222-3333")).toBe("sms:+15552223333");
  });

  it("drops service prefixes for chat targets", () => {
    expect(normalizeIMessageMessagingTarget("sms:chat_id:123")).toBe("chat_id:123");
    expect(normalizeIMessageMessagingTarget("imessage:CHAT_GUID:abc")).toBe("chat_guid:abc");
    expect(normalizeIMessageMessagingTarget("auto:ChatIdentifier:foo")).toBe("chat_identifier:foo");
  });
});

describe("signal target normalization", () => {
  it("normalizes uuid targets by stripping uuid:", () => {
    expect(normalizeSignalMessagingTarget("uuid:123E4567-E89B-12D3-A456-426614174000")).toBe(
      "123e4567-e89b-12d3-a456-426614174000",
    );
  });

  it("normalizes signal:uuid targets", () => {
    expect(normalizeSignalMessagingTarget("signal:uuid:123E4567-E89B-12D3-A456-426614174000")).toBe(
      "123e4567-e89b-12d3-a456-426614174000",
    );
  });

  it("preserves case for group targets", () => {
    expect(
      normalizeSignalMessagingTarget("signal:group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg="),
    ).toBe("group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=");
  });

  it("preserves case for base64-like group IDs without signal prefix", () => {
    expect(
      normalizeSignalMessagingTarget("group:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/ABCD="),
    ).toBe("group:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/ABCD=");
  });

  it("accepts uuid prefixes for target detection", () => {
    expect(looksLikeSignalTargetId("uuid:123e4567-e89b-12d3-a456-426614174000")).toBe(true);
    expect(looksLikeSignalTargetId("signal:uuid:123e4567-e89b-12d3-a456-426614174000")).toBe(true);
  });

  it("accepts signal-prefixed E.164 targets for detection", () => {
    expect(looksLikeSignalTargetId("signal:+15551234567")).toBe(true);
    expect(looksLikeSignalTargetId("signal:15551234567")).toBe(true);
  });

  it("accepts compact UUIDs for target detection", () => {
    expect(looksLikeSignalTargetId("123e4567e89b12d3a456426614174000")).toBe(true);
    expect(looksLikeSignalTargetId("uuid:123e4567e89b12d3a456426614174000")).toBe(true);
  });

  it("rejects invalid uuid prefixes", () => {
    expect(looksLikeSignalTargetId("uuid:")).toBe(false);
    expect(looksLikeSignalTargetId("uuid:not-a-uuid")).toBe(false);
  });
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

describe("whatsappOutbound.resolveTarget", () => {
  it("returns error when no target is provided even with allowFrom", () => {
    const result = whatsappOutbound.resolveTarget?.({
      to: undefined,
      allowFrom: ["+15551234567"],
      mode: "implicit",
    });

    expect(result).toEqual({
      ok: false,
      error: expect.any(Error),
    });
  });

  it("returns error when implicit target is not in allowFrom", () => {
    const result = whatsappOutbound.resolveTarget?.({
      to: "+15550000000",
      allowFrom: ["+15551234567"],
      mode: "implicit",
    });

    expect(result).toEqual({
      ok: false,
      error: expect.any(Error),
    });
  });

  it("keeps group JID targets even when allowFrom does not contain them", () => {
    const result = whatsappOutbound.resolveTarget?.({
      to: "120363401234567890@g.us",
      allowFrom: ["+15551234567"],
      mode: "implicit",
    });

    expect(result).toEqual({
      ok: true,
      to: "120363401234567890@g.us",
    });
  });
});

describe("normalizeSignalAccountInput", () => {
  it("accepts already normalized numbers", () => {
    expect(normalizeSignalAccountInput("+15555550123")).toBe("+15555550123");
  });

  it("normalizes formatted input", () => {
    expect(normalizeSignalAccountInput("  +1 (555) 000-1234 ")).toBe("+15550001234");
  });

  it("rejects empty input", () => {
    expect(normalizeSignalAccountInput("   ")).toBeNull();
  });

  it("rejects non-numeric input", () => {
    expect(normalizeSignalAccountInput("ok")).toBeNull();
    expect(normalizeSignalAccountInput("++--")).toBeNull();
  });

  it("rejects inputs with stray + characters", () => {
    expect(normalizeSignalAccountInput("++12345")).toBeNull();
    expect(normalizeSignalAccountInput("+1+2345")).toBeNull();
  });

  it("rejects numbers that are too short or too long", () => {
    expect(normalizeSignalAccountInput("+1234")).toBeNull();
    expect(normalizeSignalAccountInput("+1234567890123456")).toBeNull();
  });
});
