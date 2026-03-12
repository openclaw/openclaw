import { describe, it, expect } from "vitest";
import {
  evaluateChannelHealth,
  resolveChannelRestartReason,
  DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  DEFAULT_CHANNEL_CONNECT_GRACE_MS,
} from "./channel-health-policy.js";
import type { ChannelHealthSnapshot, ChannelHealthPolicy } from "./channel-health-policy.js";

describe("DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS", () => {
  it("should be 30 minutes", () => {
    expect(DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS).toBe(30 * 60 * 1000);
  });
});

describe("DEFAULT_CHANNEL_CONNECT_GRACE_MS", () => {
  it("should be 2 minutes", () => {
    expect(DEFAULT_CHANNEL_CONNECT_GRACE_MS).toBe(2 * 60 * 1000);
  });
});

describe("evaluateChannelHealth", () => {
  const basePolicy: ChannelHealthPolicy = {
    channelId: "test-channel",
    now: Date.now(),
    staleEventThresholdMs: DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
    channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  };

  it("should return unmanaged for disabled channels", () => {
    const snapshot: ChannelHealthSnapshot = { enabled: false };
    const result = evaluateChannelHealth(snapshot, basePolicy);
    expect(result).toEqual({ healthy: true, reason: "unmanaged" });
  });

  it("should return unmanaged for unconfigured channels", () => {
    const snapshot: ChannelHealthSnapshot = { configured: false };
    const result = evaluateChannelHealth(snapshot, basePolicy);
    expect(result).toEqual({ healthy: true, reason: "unmanaged" });
  });

  it("should return not-running for stopped channels", () => {
    const snapshot: ChannelHealthSnapshot = { enabled: true, configured: true, running: false };
    const result = evaluateChannelHealth(snapshot, basePolicy);
    expect(result).toEqual({ healthy: false, reason: "not-running" });
  });

  it("should return healthy for running connected channel", () => {
    const snapshot: ChannelHealthSnapshot = {
      enabled: true,
      configured: true,
      running: true,
      connected: true,
    };
    const result = evaluateChannelHealth(snapshot, basePolicy);
    expect(result).toEqual({ healthy: true, reason: "healthy" });
  });

  it("should return disconnected for running but disconnected channel", () => {
    const snapshot: ChannelHealthSnapshot = {
      enabled: true,
      configured: true,
      running: true,
      connected: false,
    };
    const result = evaluateChannelHealth(snapshot, basePolicy);
    expect(result).toEqual({ healthy: false, reason: "disconnected" });
  });

  it("should return busy for active channel", () => {
    const snapshot: ChannelHealthSnapshot = {
      enabled: true,
      configured: true,
      running: true,
      connected: true,
      busy: true,
      lastStartAt: basePolicy.now - 10000,
      lastRunActivityAt: basePolicy.now - 1000,
    };
    const result = evaluateChannelHealth(snapshot, basePolicy);
    expect(result).toEqual({ healthy: true, reason: "busy" });
  });

  it("should return stuck for busy channel with stale activity", () => {
    const snapshot: ChannelHealthSnapshot = {
      enabled: true,
      configured: true,
      running: true,
      connected: true,
      busy: true,
      lastStartAt: basePolicy.now - 100000,
      lastRunActivityAt: basePolicy.now - 30 * 60 * 1000, // 30 minutes ago
    };
    const result = evaluateChannelHealth(snapshot, basePolicy);
    expect(result).toEqual({ healthy: false, reason: "stuck" });
  });

  it("should return startup-connect-grace for recently started channel", () => {
    const snapshot: ChannelHealthSnapshot = {
      enabled: true,
      configured: true,
      running: true,
      lastStartAt: basePolicy.now - 30000, // 30 seconds ago
    };
    const result = evaluateChannelHealth(snapshot, basePolicy);
    expect(result).toEqual({ healthy: true, reason: "startup-connect-grace" });
  });

  it("should skip stale check for telegram channels", () => {
    const policy: ChannelHealthPolicy = {
      ...basePolicy,
      channelId: "telegram",
    };
    const snapshot: ChannelHealthSnapshot = {
      enabled: true,
      configured: true,
      running: true,
      connected: true,
      lastEventAt: basePolicy.now - 60 * 60 * 1000, // 1 hour ago
    };
    const result = evaluateChannelHealth(snapshot, policy);
    expect(result).toEqual({ healthy: true, reason: "healthy" });
  });

  it("should skip stale check for webhook mode channels", () => {
    const snapshot: ChannelHealthSnapshot = {
      enabled: true,
      configured: true,
      running: true,
      connected: true,
      mode: "webhook",
      lastEventAt: basePolicy.now - 60 * 60 * 1000,
    };
    const result = evaluateChannelHealth(snapshot, basePolicy);
    expect(result).toEqual({ healthy: true, reason: "healthy" });
  });

  it("should return stale-socket for channel with stale events", () => {
    const snapshot: ChannelHealthSnapshot = {
      enabled: true,
      configured: true,
      running: true,
      connected: true,
      lastStartAt: basePolicy.now - 5 * 60 * 1000,
      lastEventAt: basePolicy.now - 45 * 60 * 1000, // 45 minutes ago
    };
    const result = evaluateChannelHealth(snapshot, basePolicy);
    expect(result).toEqual({ healthy: false, reason: "stale-socket" });
  });

  it("should handle zero activeRuns", () => {
    const snapshot: ChannelHealthSnapshot = {
      enabled: true,
      configured: true,
      running: true,
      connected: true,
      activeRuns: 0,
    };
    const result = evaluateChannelHealth(snapshot, basePolicy);
    expect(result.healthy).toBe(true);
  });

  it("should handle positive activeRuns", () => {
    const snapshot: ChannelHealthSnapshot = {
      enabled: true,
      configured: true,
      running: true,
      connected: true,
      activeRuns: 5,
      lastStartAt: basePolicy.now - 10000,
      lastRunActivityAt: basePolicy.now - 1000,
    };
    const result = evaluateChannelHealth(snapshot, basePolicy);
    expect(result.reason).toBe("busy");
  });

  it("should handle NaN activeRuns", () => {
    const snapshot: ChannelHealthSnapshot = {
      enabled: true,
      configured: true,
      running: true,
      connected: true,
      activeRuns: NaN,
    };
    const result = evaluateChannelHealth(snapshot, basePolicy);
    expect(result.healthy).toBe(true);
  });

  it("should handle Infinity activeRuns", () => {
    const snapshot: ChannelHealthSnapshot = {
      enabled: true,
      configured: true,
      running: true,
      connected: true,
      activeRuns: Infinity,
    };
    const result = evaluateChannelHealth(snapshot, basePolicy);
    expect(result.healthy).toBe(true);
  });
});

describe("resolveChannelRestartReason", () => {
  it("should return stale-socket for stale-socket evaluation", () => {
    const snapshot: ChannelHealthSnapshot = {};
    const evaluation = { healthy: false, reason: "stale-socket" as const };
    expect(resolveChannelRestartReason(snapshot, evaluation)).toBe("stale-socket");
  });

  it("should return stopped for not-running with few reconnects", () => {
    const snapshot: ChannelHealthSnapshot = { reconnectAttempts: 3 };
    const evaluation = { healthy: false, reason: "not-running" as const };
    expect(resolveChannelRestartReason(snapshot, evaluation)).toBe("stopped");
  });

  it("should return gave-up for not-running with many reconnects", () => {
    const snapshot: ChannelHealthSnapshot = { reconnectAttempts: 15 };
    const evaluation = { healthy: false, reason: "not-running" as const };
    expect(resolveChannelRestartReason(snapshot, evaluation)).toBe("gave-up");
  });

  it("should return disconnected for disconnected evaluation", () => {
    const snapshot: ChannelHealthSnapshot = {};
    const evaluation = { healthy: false, reason: "disconnected" as const };
    expect(resolveChannelRestartReason(snapshot, evaluation)).toBe("disconnected");
  });

  it("should return stuck for stuck evaluation", () => {
    const snapshot: ChannelHealthSnapshot = {};
    const evaluation = { healthy: false, reason: "stuck" as const };
    expect(resolveChannelRestartReason(snapshot, evaluation)).toBe("stuck");
  });

  it("should return stuck for healthy evaluation", () => {
    const snapshot: ChannelHealthSnapshot = {};
    const evaluation = { healthy: true, reason: "healthy" as const };
    expect(resolveChannelRestartReason(snapshot, evaluation)).toBe("stuck");
  });

  it("should return stopped for zero reconnect attempts", () => {
    const snapshot: ChannelHealthSnapshot = { reconnectAttempts: 0 };
    const evaluation = { healthy: false, reason: "not-running" as const };
    expect(resolveChannelRestartReason(snapshot, evaluation)).toBe("stopped");
  });

  it("should return gave-up for exactly 10 reconnect attempts", () => {
    const snapshot: ChannelHealthSnapshot = { reconnectAttempts: 10 };
    const evaluation = { healthy: false, reason: "not-running" as const };
    expect(resolveChannelRestartReason(snapshot, evaluation)).toBe("gave-up");
  });
});
