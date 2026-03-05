import { describe, expect, it } from "vitest";
import { evaluateChannelHealth, resolveChannelRestartReason } from "./channel-health-policy.js";

describe("evaluateChannelHealth", () => {
  it("treats disabled accounts as healthy unmanaged", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: false,
        enabled: false,
        configured: true,
      },
      {
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "unmanaged" });
  });

  it("uses channel connect grace before flagging disconnected", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
        lastStartAt: 95_000,
      },
      {
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "startup-connect-grace" });
  });

  it("treats active runs as busy even when disconnected", () => {
    const now = 100_000;
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
        activeRuns: 1,
        lastRunActivityAt: now - 30_000,
      },
      {
        now,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "busy" });
  });

  it("flags stale busy channels as stuck when run activity is too old", () => {
    const now = 100_000;
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
        activeRuns: 1,
        lastRunActivityAt: now - 26 * 60_000,
      },
      {
        now,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stuck" });
  });

  it("ignores inherited busy flags until current lifecycle reports run activity", () => {
    const now = 100_000;
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
        lastStartAt: now - 30_000,
        busy: true,
        activeRuns: 1,
        lastRunActivityAt: now - 31_000,
      },
      {
        now,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "disconnected" });
  });

  it("flags stale sockets when lastEventAt is set and exceeds threshold", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 0,
        lastEventAt: 10_000,
      },
      {
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
  });

  it("treats channels without lastEventAt as healthy (no false-positive stale-socket)", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 0,
        lastEventAt: null,
      },
      {
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("treats channels that never set lastEventAt as healthy", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 0,
      },
      {
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("reports healthy when lastEventAt is recent", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 0,
        lastEventAt: 85_000,
      },
      {
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });
});

describe("resolveChannelRestartReason", () => {
  it("maps not-running + high reconnect attempts to gave-up", () => {
    const reason = resolveChannelRestartReason(
      {
        running: false,
        reconnectAttempts: 10,
      },
      { healthy: false, reason: "not-running" },
    );
    expect(reason).toBe("gave-up");
  });
});
