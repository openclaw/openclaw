import { describe, expect, it, vi } from "vitest";
import { formatLastHeartbeatDetail } from "./status.last-heartbeat.js";

describe("formatLastHeartbeatDetail", () => {
  it("does not duplicate the relative-time suffix", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T05:37:00Z"));
    try {
      const rendered = formatLastHeartbeatDetail({
        status: "ok-token",
        ts: Date.now() - 60_000,
        silent: true,
        indicatorType: "ok",
      });
      expect(rendered).toContain("ok-token");
      expect(rendered).toContain("1m ago");
      expect(rendered).not.toContain("ago ago");
      expect(rendered).not.toContain("unknown");
    } finally {
      vi.useRealTimers();
    }
  });

  it("includes channel and account when provided", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T05:37:00Z"));
    try {
      const rendered = formatLastHeartbeatDetail({
        status: "ok-token",
        ts: Date.now() - 60_000,
        channel: "telegram",
        accountId: "default",
        silent: true,
        indicatorType: "ok",
      });
      expect(rendered).toContain("telegram");
      expect(rendered).toContain("account default");
    } finally {
      vi.useRealTimers();
    }
  });
});
