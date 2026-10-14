// Covers direct/gateway outbound summary formatting.
import { describe, expect, it, vi } from "vitest";
import { formatGatewaySummary, formatOutboundDeliverySummary } from "./format.js";

const getChannelPluginMock = vi.hoisted(() =>
  vi.fn((channel: string) => {
    const labels: Record<string, string> = {
      alpha: "Alpha",
    };
    const label = labels[channel];
    return label ? { meta: { label } } : undefined;
  }),
);

vi.mock("../../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: getChannelPluginMock,
  getChannelPlugin: getChannelPluginMock,
}));
describe("formatOutboundDeliverySummary", () => {
  it.each([
    {
      channel: "alpha" as const,
      result: undefined,
      expected: "✅ Sent via Alpha. Message ID: unknown",
    },
    {
      channel: "alpha" as const,
      result: {
        channel: "alpha" as const,
        messageId: "m1",
        target: { kind: "chat" as const, id: "c1" },
      },
      expected: "✅ Sent via Alpha. Message ID: m1 (chat c1)",
    },
  ])("formats delivery summary for %j", ({ channel, result, expected }) => {
    expect(formatOutboundDeliverySummary(channel, result)).toBe(expected);
  });
});

describe("formatGatewaySummary", () => {
  it.each([
    {
      input: { channel: "directchat", messageId: "m1" },
      expected: "✅ Sent via gateway (directchat). Message ID: m1",
    },
    {
      input: { action: "Poll sent", channel: "richchat", messageId: "p1" },
      expected: "✅ Poll sent via gateway (richchat). Message ID: p1",
    },
    {
      input: {},
      expected: "✅ Sent via gateway. Message ID: unknown",
    },
  ])("formats gateway summary for %j", ({ input, expected }) => {
    expect(formatGatewaySummary(input)).toBe(expected);
  });
});
