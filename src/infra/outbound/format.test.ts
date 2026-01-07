import { describe, expect, it } from "vitest";

import {
  buildOutboundDeliveryJson,
  formatOutboundDeliverySummary,
} from "./format.js";

describe("formatOutboundDeliverySummary", () => {
  it("falls back when result is missing", () => {
    expect(formatOutboundDeliverySummary("telegram")).toBe(
      "✅ Sent via telegram. Message ID: unknown",
    );
    expect(formatOutboundDeliverySummary("imessage")).toBe(
      "✅ Sent via iMessage. Message ID: unknown",
    );
  });

  it("adds chat or channel details", () => {
    expect(
      formatOutboundDeliverySummary("telegram", {
        provider: "telegram",
        messageId: "m1",
        chatId: "c1",
      }),
    ).toBe("✅ Sent via telegram. Message ID: m1 (chat c1)");

    expect(
      formatOutboundDeliverySummary("discord", {
        provider: "discord",
        messageId: "d1",
        channelId: "chan",
      }),
    ).toBe("✅ Sent via discord. Message ID: d1 (channel chan)");
  });
});

describe("buildOutboundDeliveryJson", () => {
  it("builds direct delivery payloads", () => {
    expect(
      buildOutboundDeliveryJson({
        provider: "telegram",
        to: "123",
        result: { provider: "telegram", messageId: "m1", chatId: "c1" },
        mediaUrl: "https://example.com/a.png",
      }),
    ).toEqual({
      provider: "telegram",
      via: "direct",
      to: "123",
      messageId: "m1",
      mediaUrl: "https://example.com/a.png",
      chatId: "c1",
    });
  });

  it("supports whatsapp metadata when present", () => {
    expect(
      buildOutboundDeliveryJson({
        provider: "whatsapp",
        to: "+1",
        result: { provider: "whatsapp", messageId: "w1", toJid: "jid" },
      }),
    ).toEqual({
      provider: "whatsapp",
      via: "direct",
      to: "+1",
      messageId: "w1",
      mediaUrl: null,
      toJid: "jid",
    });
  });

  it("keeps timestamp for signal", () => {
    expect(
      buildOutboundDeliveryJson({
        provider: "signal",
        to: "+1",
        result: { provider: "signal", messageId: "s1", timestamp: 123 },
      }),
    ).toEqual({
      provider: "signal",
      via: "direct",
      to: "+1",
      messageId: "s1",
      mediaUrl: null,
      timestamp: 123,
    });
  });
});
