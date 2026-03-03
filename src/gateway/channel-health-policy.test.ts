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

  it("flags stale sockets when no events arrive beyond threshold", () => {
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
    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
  });

  it("does not apply stale-socket detection when connection state is unknown", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
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
