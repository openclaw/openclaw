import { describe, expect, it } from "vitest";

import {
  formatAgentEnvelope,
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
} from "./envelope.js";

describe("formatAgentEnvelope", () => {
  it("includes channel, from, ip, host, and timestamp", () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "UTC";

    const ts = Date.UTC(2025, 0, 2, 3, 4); // 2025-01-02T03:04:00Z
    const body = formatAgentEnvelope({
      channel: "WebChat",
      from: "user1",
      host: "mac-mini",
      ip: "10.0.0.5",
      timestamp: ts,
      envelope: { timezone: "utc" },
      body: "hello",
    });

    process.env.TZ = originalTz;

    expect(body).toBe("[WebChat user1 mac-mini 10.0.0.5 2025-01-02T03:04Z] hello");
  });

  it("formats timestamps in local timezone by default", () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";

    const ts = Date.UTC(2025, 0, 2, 3, 4); // 2025-01-02T03:04:00Z
    const body = formatAgentEnvelope({
      channel: "WebChat",
      timestamp: ts,
      body: "hello",
    });

    process.env.TZ = originalTz;

    expect(body).toMatch(/\[WebChat 2025-01-01 19:04 [^\]]+\] hello/);
  });

  it("formats timestamps in UTC when configured", () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";

    const ts = Date.UTC(2025, 0, 2, 3, 4); // 2025-01-02T03:04:00Z (19:04 PST)
    const body = formatAgentEnvelope({
      channel: "WebChat",
      timestamp: ts,
      envelope: { timezone: "utc" },
      body: "hello",
    });

    process.env.TZ = originalTz;

    expect(body).toBe("[WebChat 2025-01-02T03:04Z] hello");
  });

  it("formats timestamps in user timezone when configured", () => {
    const ts = Date.UTC(2025, 0, 2, 3, 4); // 2025-01-02T03:04:00Z (04:04 CET)
    const body = formatAgentEnvelope({
      channel: "WebChat",
      timestamp: ts,
      envelope: { timezone: "user", userTimezone: "Europe/Vienna" },
      body: "hello",
    });

    expect(body).toMatch(/\[WebChat 2025-01-02 04:04 [^\]]+\] hello/);
  });

  it("omits timestamps when configured", () => {
    const ts = Date.UTC(2025, 0, 2, 3, 4);
    const body = formatAgentEnvelope({
      channel: "WebChat",
      timestamp: ts,
      envelope: { includeTimestamp: false },
      body: "hello",
    });
    expect(body).toBe("[WebChat] hello");
  });

  it("handles missing optional fields", () => {
    const body = formatAgentEnvelope({ channel: "Telegram", body: "hi" });
    expect(body).toBe("[Telegram] hi");
  });
});

describe("formatInboundEnvelope", () => {
  it("prefixes sender for non-direct chats", () => {
    const body = formatInboundEnvelope({
      channel: "Discord",
      from: "Guild #general",
      body: "hi",
      chatType: "channel",
      senderLabel: "Alice",
    });
    expect(body).toBe("[Discord Guild #general] Alice: hi");
  });

  it("uses sender fields when senderLabel is missing", () => {
    const body = formatInboundEnvelope({
      channel: "Signal",
      from: "Signal Group id:123",
      body: "ping",
      chatType: "group",
      sender: { name: "Bob", id: "42" },
    });
    expect(body).toBe("[Signal Signal Group id:123] Bob (42): ping");
  });

  it("keeps direct messages unprefixed", () => {
    const body = formatInboundEnvelope({
      channel: "iMessage",
      from: "+1555",
      body: "hello",
      chatType: "direct",
      senderLabel: "Alice",
    });
    expect(body).toBe("[iMessage +1555] hello");
  });

  it("includes elapsed time when previousTimestamp is provided", () => {
    const now = Date.now();
    const twoMinutesAgo = now - 2 * 60 * 1000;
    const body = formatInboundEnvelope({
      channel: "Telegram",
      from: "Alice",
      body: "follow-up message",
      timestamp: now,
      previousTimestamp: twoMinutesAgo,
      chatType: "direct",
      envelope: { includeTimestamp: false },
    });
    expect(body).toContain("Alice +2m");
    expect(body).toContain("follow-up message");
  });

  it("omits elapsed time when disabled", () => {
    const now = Date.now();
    const body = formatInboundEnvelope({
      channel: "Telegram",
      from: "Alice",
      body: "follow-up message",
      timestamp: now,
      previousTimestamp: now - 2 * 60 * 1000,
      chatType: "direct",
      envelope: { includeElapsed: false, includeTimestamp: false },
    });
    expect(body).toBe("[Telegram Alice] follow-up message");
  });

  it("resolves envelope options from config", () => {
    const options = resolveEnvelopeFormatOptions({
      agents: {
        defaults: {
          envelopeTimezone: "user",
          envelopeTimestamp: "off",
          envelopeElapsed: "off",
          userTimezone: "Europe/Vienna",
        },
      },
    });
    expect(options).toEqual({
      timezone: "user",
      includeTimestamp: false,
      includeElapsed: false,
      userTimezone: "Europe/Vienna",
    });
  });
});
