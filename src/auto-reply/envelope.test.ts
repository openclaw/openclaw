import { describe, expect, it } from "vitest";

import { formatAgentEnvelope } from "./envelope.js";

describe("formatAgentEnvelope", () => {
  it("includes surface, from, ip, host, and timestamp", () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "UTC";

    const ts = Date.UTC(2025, 0, 2, 3, 4); // 2025-01-02T03:04:00Z
    const body = formatAgentEnvelope({
      surface: "WebChat",
      from: "user1",
      host: "mac-mini",
      ip: "10.0.0.5",
      timestamp: ts,
      body: "hello",
    });

    process.env.TZ = originalTz;

    expect(body).toMatch(
      /^\[WebChat user1 mac-mini 10\.0\.0\.5 2025-01-02T03:04\+00:00\{.+\}\] hello$/,
    );
  });

  it("formats timestamps in local time (not UTC)", () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";

    const ts = Date.UTC(2025, 0, 2, 3, 4); // 2025-01-02T03:04:00Z
    const body = formatAgentEnvelope({
      surface: "WebChat",
      timestamp: ts,
      body: "hello",
    });

    process.env.TZ = originalTz;

    expect(body).toBe(
      "[WebChat 2025-01-01T19:04-08:00{America/Los_Angeles}] hello",
    );
  });

  it("handles missing optional fields", () => {
    const body = formatAgentEnvelope({ surface: "Telegram", body: "hi" });
    expect(body).toBe("[Telegram] hi");
  });
});
