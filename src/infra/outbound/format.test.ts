import { describe, expect, it, vi } from "vitest";
import {
  buildOutboundDeliveryJson,
  formatGatewaySummary,
  formatOutboundDeliverySummary,
} from "./format.js";

const getChannelPluginMock = vi.hoisted(() => vi.fn((_channel: unknown) => undefined));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: getChannelPluginMock,
}));

describe("formatOutboundDeliverySummary", () => {
  it("formats fallback and provider-specific detail variants", () => {
    const cases = [
      {
        name: "fallback telegram",
        channel: "telegram" as const,
        result: undefined,
        expected: "✅ Sent via Telegram. Message ID: unknown",
      },
      {
        name: "fallback imessage",
        channel: "imessage" as const,
        result: undefined,
        expected: "✅ Sent via iMessage. Message ID: unknown",
      },
      {
        name: "telegram with chat detail",
        channel: "telegram" as const,
        result: {
          channel: "telegram" as const,
          messageId: "m1",
          chatId: "c1",
        },
        expected: "✅ Sent via Telegram. Message ID: m1 (chat c1)",
      },
      {
        name: "discord with channel detail",
        channel: "discord" as const,
        result: {
          channel: "discord" as const,
          messageId: "d1",
          channelId: "chan",
        },
        expected: "✅ Sent via Discord. Message ID: d1 (channel chan)",
      },
      {
        name: "slack with room detail",
        channel: "slack" as const,
        result: {
          channel: "slack" as const,
          messageId: "s1",
          roomId: "room-1",
        },
        expected: "✅ Sent via Slack. Message ID: s1 (room room-1)",
      },
      {
        name: "msteams with conversation detail",
        channel: "msteams" as const,
        result: {
          channel: "msteams" as const,
          messageId: "t1",
          conversationId: "conv-1",
        },
        expected: "✅ Sent via msteams. Message ID: t1 (conversation conv-1)",
      },
    ];

    for (const testCase of cases) {
      expect(formatOutboundDeliverySummary(testCase.channel, testCase.result), testCase.name).toBe(
        testCase.expected,
      );
    }
  });
});

describe("buildOutboundDeliveryJson", () => {
  it("builds delivery payloads across provider-specific fields", () => {
    const cases = [
      {
        name: "telegram direct payload",
        input: {
          channel: "telegram" as const,
          to: "123",
          result: { channel: "telegram" as const, messageId: "m1", chatId: "c1" },
          mediaUrl: "https://example.com/a.png",
        },
        expected: {
          channel: "telegram",
          via: "direct",
          to: "123",
          messageId: "m1",
          mediaUrl: "https://example.com/a.png",
          chatId: "c1",
        },
      },
      {
        name: "whatsapp metadata",
        input: {
          channel: "whatsapp" as const,
          to: "+1",
          result: { channel: "whatsapp" as const, messageId: "w1", toJid: "jid" },
        },
        expected: {
          channel: "whatsapp",
          via: "direct",
          to: "+1",
          messageId: "w1",
          mediaUrl: null,
          toJid: "jid",
        },
      },
      {
        name: "signal timestamp",
        input: {
          channel: "signal" as const,
          to: "+1",
          result: { channel: "signal" as const, messageId: "s1", timestamp: 123 },
        },
        expected: {
          channel: "signal",
          via: "direct",
          to: "+1",
          messageId: "s1",
          mediaUrl: null,
          timestamp: 123,
        },
      },
      {
        name: "gateway payload with meta and explicit via",
        input: {
          channel: "discord" as const,
          to: "channel:1",
          via: "gateway" as const,
          result: {
            messageId: "g1",
            channelId: "1",
            meta: { thread: "2" },
          },
        },
        expected: {
          channel: "discord",
          via: "gateway",
          to: "channel:1",
          messageId: "g1",
          mediaUrl: null,
          channelId: "1",
          meta: { thread: "2" },
        },
      },
    ];

    for (const testCase of cases) {
      expect(buildOutboundDeliveryJson(testCase.input), testCase.name).toEqual(testCase.expected);
    }
  });
});

describe("formatGatewaySummary", () => {
  it("formats default and custom gateway action summaries", () => {
    const cases = [
      {
        name: "default send action",
        input: { channel: "whatsapp", messageId: "m1" },
        expected: "✅ Sent via gateway (whatsapp). Message ID: m1",
      },
      {
        name: "custom action",
        input: { action: "Poll sent", channel: "discord", messageId: "p1" },
        expected: "✅ Poll sent via gateway (discord). Message ID: p1",
      },
      {
        name: "missing channel and message id",
        input: {},
        expected: "✅ Sent via gateway. Message ID: unknown",
      },
    ];

    for (const testCase of cases) {
      expect(formatGatewaySummary(testCase.input), testCase.name).toBe(testCase.expected);
    }
  });
});
