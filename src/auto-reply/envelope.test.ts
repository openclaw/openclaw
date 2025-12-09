import { describe, expect, it } from "vitest";

import { formatAgentEnvelope } from "./envelope.js";

describe("formatAgentEnvelope", () => {
  it("includes surface, from, ip, host, and timestamp", () => {
    const ts = Date.UTC(2025, 0, 2, 3, 4); // 2025-01-02T03:04:00Z
    const body = formatAgentEnvelope({
      surface: "WebChat",
      from: "user1",
      host: "mac-mini",
      ip: "10.0.0.5",
      timestamp: ts,
      body: "hello",
    });
    expect(body).toBe(
      "[WebChat user1 mac-mini 10.0.0.5 2025-01-02 03:04] hello",
    );
  });

  it("handles missing optional fields", () => {
    const body = formatAgentEnvelope({ surface: "Telegram", body: "hi" });
    expect(body).toBe("[Telegram] hi");
  });
});
