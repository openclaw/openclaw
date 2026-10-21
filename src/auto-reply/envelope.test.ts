import { describe, expect, it } from "vitest";
import {
  formatAgentEnvelope,
  formatAgentEnvelopeTimestamp as stamp,
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
} from "./envelope.js";

const timestamp = Date.UTC(2025, 0, 2, 3, 4, 5);
const optionsFor = (userTimezone: string) =>
  resolveEnvelopeFormatOptions({ agents: { defaults: { userTimezone } } });
function agentEnvelope(options: Partial<Parameters<typeof formatAgentEnvelope>[0]> = {}) {
  return formatAgentEnvelope({ channel: "WebChat", body: "hello", timestamp, ...options });
}
function inboundEnvelope(options: Partial<Parameters<typeof formatInboundEnvelope>[0]> = {}) {
  return formatInboundEnvelope({
    channel: "Telegram",
    from: "Alice",
    body: "hello",
    chatType: "direct",
    ...options,
  });
}

describe("formatAgentEnvelope", () => {
  it("includes channel, from, ip, host, and timestamp", () => {
    const body = agentEnvelope({
      from: "user1",
      host: "mac-mini",
      ip: "10.0.0.5",
      envelope: { timezone: "utc" },
    });

    expect(body).toBe("[WebChat user1 mac-mini 10.0.0.5 Thu 2025-01-02T03:04:05Z] hello");
  });

  it("formats timestamps in local timezone by default", () => {
    const ts = Date.UTC(2025, 0, 2, 3, 4);
    const expectedTimestamp = stamp(ts, { timezone: "local" });
    const body = agentEnvelope({ timestamp: ts });

    expect(body).toBe(`[WebChat ${expectedTimestamp}] hello`);
  });

  it("formats timestamps in UTC across date boundaries", () => {
    for (const [date, timezone, expected] of [
      ["2025-01-02T03:04:05Z", "utc", "Thu 2025-01-02T03:04:05Z"],
      ["2024-12-31T23:59:59Z", "utc", "Tue 2024-12-31T23:59:59Z"],
      ["2025-01-01T00:00:00Z", "gmt", "Wed 2025-01-01T00:00:00Z"],
      ["2025-01-03T00:00:00Z", "utc", "Fri 2025-01-03T00:00:00Z"],
    ] as const) {
      expect(
        agentEnvelope({
          timestamp: new Date(date),
          envelope: { timezone },
        }),
      ).toBe(`[WebChat ${expected}] hello`);
    }
  });

  it("formats timestamps in user timezone when configured", () => {
    const body = agentEnvelope({
      envelope: { timezone: "user", userTimezone: "Europe/Vienna" },
    });

    expect(body).toMatch(/\[WebChat Thu 2025-01-02 04:04:05 [^\]]+\] hello/);
  });

  it("falls back to the host timezone for an invalid configured user timezone", () => {
    const options = optionsFor("Not/A_Timezone");
    expect(options.timezone).toBe("local");
    expect(stamp(timestamp, options)).toBe(stamp(timestamp, { timezone: "local" }));
  });

  it("keeps the UTC fallback for an invalid explicit timezone option", () => {
    expect(stamp(timestamp, { timezone: "Not/A_Timezone" })).toBe(
      stamp(timestamp, { timezone: "utc" }),
    );
  });
});

describe("formatInboundEnvelope", () => {
  it.each([
    [
      {
        channel: "Signal",
        from: "Signal Group id:123",
        body: "ping",
        chatType: "group",
        sender: { name: "Bob", id: "42" },
      },
      "[Signal Signal Group id:123] Bob (42): ping",
    ],
    [{ from: "Alice id:123" }, "[Telegram Alice id:123] Alice: hello"],
    [
      { from: "Ops: Alice id:123", body: "/status" },
      "[Telegram Ops: Alice id:123] (sender): /status",
    ],
    [
      { channel: "WhatsApp", from: "+1555", body: "outbound msg", fromMe: true },
      "[WhatsApp +1555] (self): outbound msg",
    ],
    [
      {
        channel: "WhatsApp",
        from: "Family Chat",
        chatType: "group",
        senderLabel: "Alice",
        fromMe: true,
      },
      "[WhatsApp Family Chat] Alice: hello",
    ],
  ] as const)("labels the inbound sender: %j", (options, expected) => {
    expect(inboundEnvelope(options)).toBe(expected);
  });

  it.each([undefined, false])("formats elapsed time (enabled: %s)", (includeElapsed) => {
    const body = inboundEnvelope({
      body: "follow-up message",
      timestamp,
      previousTimestamp: timestamp - 2 * 60 * 1000,
      envelope: { includeElapsed, includeTimestamp: false },
    });
    const elapsed = includeElapsed === false ? "" : " +2m";
    expect(body).toBe(`[Telegram Alice${elapsed}] Alice: follow-up message`);
  });

  it("uses fixed envelope options while preserving the user timezone", () => {
    const options = optionsFor("Europe/Vienna");
    expect(options).toEqual({
      timezone: "Europe/Vienna",
      includeTimestamp: true,
      includeElapsed: true,
      userTimezone: "Europe/Vienna",
    });
  });
});
