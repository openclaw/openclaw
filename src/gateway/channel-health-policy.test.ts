import { describe, expect, it } from "vitest";
import {
  evaluateChannelHealth,
  extractLastDisconnectAt,
  resolveChannelRestartReason,
} from "./channel-health-policy.js";

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

describe("reconnect grace period (#31710)", () => {
  const policy = {
    now: 500_000,
    channelConnectGraceMs: 120_000,
    staleEventThresholdMs: 1_800_000,
  };

  it("treats recently disconnected channel as healthy during reconnect grace", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
        lastStartAt: 10_000, // well outside startup grace
        lastDisconnectAt: 495_000, // 5s ago, within 120s reconnect grace
      },
      policy,
    );
    expect(evaluation).toEqual({ healthy: true, reason: "reconnect-grace" });
  });

  it("flags disconnected channel after reconnect grace expires", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
        lastStartAt: 10_000,
        lastDisconnectAt: 300_000, // 200s ago > 120s grace
      },
      policy,
    );
    expect(evaluation).toEqual({ healthy: false, reason: "disconnected" });
  });

  it("flags disconnected when lastDisconnectAt is missing", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
        lastStartAt: 10_000, // well outside startup grace
        // no lastDisconnectAt
      },
      policy,
    );
    expect(evaluation).toEqual({ healthy: false, reason: "disconnected" });
  });
});

describe("extractLastDisconnectAt", () => {
  it("extracts at from object", () => {
    expect(extractLastDisconnectAt({ at: 12345, status: 1006 })).toBe(12345);
  });

  it("returns undefined for string", () => {
    expect(extractLastDisconnectAt("some error")).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(extractLastDisconnectAt(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(extractLastDisconnectAt(undefined)).toBeUndefined();
  });
});
