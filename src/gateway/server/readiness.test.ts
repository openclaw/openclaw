import { describe, expect, it, vi } from "vitest";
import type { ChannelId } from "../../channels/plugins/index.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.js";
import type { ChannelManager, ChannelRuntimeSnapshot } from "../server-channels.js";
import { createReadinessChecker } from "./readiness.js";

function snapshotWith(
  accounts: Record<string, Partial<ChannelAccountSnapshot>>,
): ChannelRuntimeSnapshot {
  const channels: ChannelRuntimeSnapshot["channels"] = {};
  const channelAccounts: ChannelRuntimeSnapshot["channelAccounts"] = {};

  for (const [channelId, accountSnapshot] of Object.entries(accounts)) {
    const resolved = { accountId: "default", ...accountSnapshot } as ChannelAccountSnapshot;
    channels[channelId as ChannelId] = resolved;
    channelAccounts[channelId as ChannelId] = { default: resolved };
  }

  return { channels, channelAccounts };
}

function createManager(snapshot: ChannelRuntimeSnapshot): ChannelManager {
  return {
    getRuntimeSnapshot: vi.fn(() => snapshot),
    startChannels: vi.fn(),
    startChannel: vi.fn(),
    stopChannel: vi.fn(),
    markChannelLoggedOut: vi.fn(),
    isManuallyStopped: vi.fn(() => false),
    resetRestartAttempts: vi.fn(),
  };
}

describe("createReadinessChecker", () => {
  it("reports ready when all managed channels are healthy", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
    const startedAt = Date.now() - 5 * 60_000;
    const manager = createManager(
      snapshotWith({
        discord: {
          running: true,
          connected: true,
          enabled: true,
          configured: true,
          lastStartAt: startedAt,
          lastEventAt: Date.now() - 1_000,
        },
      }),
    );

    const readiness = createReadinessChecker({ channelManager: manager, startedAt });
    expect(readiness()).toEqual({ ready: true, failing: [], uptimeMs: 300_000 });
    vi.useRealTimers();
  });

  it("ignores disabled and unconfigured channels", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
    const startedAt = Date.now() - 5 * 60_000;
    const manager = createManager(
      snapshotWith({
        discord: {
          running: false,
          enabled: false,
          configured: true,
          lastStartAt: startedAt,
        },
        telegram: {
          running: false,
          enabled: true,
          configured: false,
          lastStartAt: startedAt,
        },
      }),
    );

    const readiness = createReadinessChecker({ channelManager: manager, startedAt });
    expect(readiness()).toEqual({ ready: true, failing: [], uptimeMs: 300_000 });
    vi.useRealTimers();
  });

  it("uses startup grace before marking disconnected channels not ready", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
    const startedAt = Date.now() - 30_000;
    const manager = createManager(
      snapshotWith({
        discord: {
          running: true,
          connected: false,
          enabled: true,
          configured: true,
          lastStartAt: startedAt,
        },
      }),
    );

    const readiness = createReadinessChecker({ channelManager: manager, startedAt });
    expect(readiness()).toEqual({ ready: true, failing: [], uptimeMs: 30_000 });
    vi.useRealTimers();
  });

  it("reports disconnected managed channels after startup grace", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
    const startedAt = Date.now() - 5 * 60_000;
    const manager = createManager(
      snapshotWith({
        discord: {
          running: true,
          connected: false,
          enabled: true,
          configured: true,
          lastStartAt: startedAt,
        },
      }),
    );

    const readiness = createReadinessChecker({ channelManager: manager, startedAt });
    expect(readiness()).toEqual({ ready: false, failing: ["discord"], uptimeMs: 300_000 });
    vi.useRealTimers();
  });

  it("keeps restart-pending channels ready during reconnect backoff", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
    const startedAt = Date.now() - 5 * 60_000;
    const manager = createManager(
      snapshotWith({
        discord: {
          running: false,
          restartPending: true,
          reconnectAttempts: 3,
          enabled: true,
          configured: true,
          lastStartAt: startedAt - 30_000,
          lastStopAt: Date.now() - 5_000,
        },
      }),
    );

    const readiness = createReadinessChecker({ channelManager: manager, startedAt });
    expect(readiness()).toEqual({ ready: true, failing: [], uptimeMs: 300_000 });
    vi.useRealTimers();
  });

  it("treats stale-socket channels as ready to avoid pulling healthy idle pods", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
    const startedAt = Date.now() - 31 * 60_000;
    const manager = createManager(
      snapshotWith({
        discord: {
          running: true,
          connected: true,
          enabled: true,
          configured: true,
          lastStartAt: startedAt,
          lastEventAt: Date.now() - 31 * 60_000,
        },
      }),
    );

    const readiness = createReadinessChecker({ channelManager: manager, startedAt });
    expect(readiness()).toEqual({ ready: true, failing: [], uptimeMs: 1_860_000 });
    vi.useRealTimers();
  });

  it("caches readiness snapshots briefly to keep repeated probes cheap", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
    const startedAt = Date.now() - 5 * 60_000;
    const manager = createManager(
      snapshotWith({
        discord: {
          running: true,
          connected: true,
          enabled: true,
          configured: true,
          lastStartAt: startedAt,
          lastEventAt: Date.now() - 1_000,
        },
      }),
    );

    const readiness = createReadinessChecker({
      channelManager: manager,
      startedAt,
      cacheTtlMs: 1_000,
    });
    expect(readiness()).toEqual({ ready: true, failing: [], uptimeMs: 300_000 });
    vi.advanceTimersByTime(500);
    expect(readiness()).toEqual({ ready: true, failing: [], uptimeMs: 300_500 });
    expect(manager.getRuntimeSnapshot).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(600);
    expect(readiness()).toEqual({ ready: true, failing: [], uptimeMs: 301_100 });
    expect(manager.getRuntimeSnapshot).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
