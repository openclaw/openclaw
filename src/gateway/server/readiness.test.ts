import { describe, expect, it } from "vitest";
import type { ChannelManager } from "../server-channels.js";
import { createReadinessChecker } from "./readiness.js";

function makeChannelManager(
  accounts: Record<
    string,
    Record<
      string,
      {
        running?: boolean;
        connected?: boolean;
        enabled?: boolean;
        configured?: boolean;
        lastStartAt?: number;
        lastEventAt?: number;
      }
    >
  >,
): Pick<ChannelManager, "getRuntimeSnapshot"> {
  return {
    getRuntimeSnapshot: () => ({
      channels: {},
      channelAccounts: accounts as never,
    }),
  };
}

describe("createReadinessChecker", () => {
  it("returns ready=true when all channels are connected", () => {
    const startedAt = Date.now() - 200_000;
    const checker = createReadinessChecker({
      channelManager: makeChannelManager({
        discord: { default: { running: true, connected: true, enabled: true, configured: true } },
        telegram: { default: { running: true, connected: true, enabled: true, configured: true } },
      }) as ChannelManager,
      startedAt,
    });

    const result = checker();

    expect(result.ready).toBe(true);
    expect(result.failing).toEqual([]);
  });

  it("returns ready=false when a channel is disconnected", () => {
    const startedAt = Date.now() - 200_000;
    const checker = createReadinessChecker({
      channelManager: makeChannelManager({
        discord: { default: { running: true, connected: false, enabled: true, configured: true } },
        telegram: { default: { running: true, connected: true, enabled: true, configured: true } },
      }) as ChannelManager,
      startedAt,
    });

    const result = checker();

    expect(result.ready).toBe(false);
    expect(result.failing).toContain("discord");
    expect(result.failing).not.toContain("telegram");
  });

  it("excludes disabled channels from failing", () => {
    const startedAt = Date.now() - 200_000;
    const checker = createReadinessChecker({
      channelManager: makeChannelManager({
        discord: {
          default: { running: false, connected: false, enabled: false, configured: true },
        },
      }) as ChannelManager,
      startedAt,
    });

    const result = checker();

    expect(result.ready).toBe(true);
    expect(result.failing).toEqual([]);
  });

  it("excludes unconfigured channels from failing", () => {
    const startedAt = Date.now() - 200_000;
    const checker = createReadinessChecker({
      channelManager: makeChannelManager({
        telegram: {
          default: { running: false, connected: false, enabled: true, configured: false },
        },
      }) as ChannelManager,
      startedAt,
    });

    const result = checker();

    expect(result.ready).toBe(true);
    expect(result.failing).toEqual([]);
  });

  it("channel within per-channel connect grace is not in failing", () => {
    const startedAt = Date.now() - 200_000;
    const channelStartedAt = Date.now() - 10_000; // channel started 10s ago, within 120s connect grace
    const checker = createReadinessChecker({
      channelManager: makeChannelManager({
        slack: {
          default: {
            running: true,
            connected: false,
            enabled: true,
            configured: true,
            lastStartAt: channelStartedAt,
          },
        },
      }) as ChannelManager,
      startedAt,
    });

    const result = checker();

    expect(result.ready).toBe(true);
    expect(result.failing).not.toContain("slack");
  });

  it("returns ready=true when no channels are configured", () => {
    const startedAt = Date.now() - 200_000;
    const checker = createReadinessChecker({
      channelManager: makeChannelManager({}) as ChannelManager,
      startedAt,
    });

    const result = checker();

    expect(result.ready).toBe(true);
    expect(result.failing).toEqual([]);
  });

  it("excludes stale-socket channels from failing — idle but connected is still ready", () => {
    const startedAt = Date.now() - 200_000;
    // Channel started and had its last event 31 minutes ago — past the 30-minute stale threshold.
    // Stale-socket is a liveness/zombie concern, not a readiness concern; a quiet overnight
    // gateway should remain in K8s load-balancer rotation.
    const staleAt = Date.now() - 31 * 60_000;
    const checker = createReadinessChecker({
      channelManager: makeChannelManager({
        slack: {
          default: {
            running: true,
            connected: true,
            enabled: true,
            configured: true,
            lastStartAt: staleAt,
            lastEventAt: staleAt,
          },
        },
      }) as ChannelManager,
      startedAt,
    });

    const result = checker();

    expect(result.ready).toBe(true);
    expect(result.failing).not.toContain("slack");
  });
});
