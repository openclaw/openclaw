import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelId } from "../channels/plugins/types.js";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.js";
import { startChannelHealthMonitor } from "./channel-health-monitor.js";
import type { ChannelManager, ChannelRuntimeSnapshot } from "./server-channels.js";

function createMockChannelManager(overrides?: Partial<ChannelManager>): ChannelManager {
  return {
    getRuntimeSnapshot: vi.fn(() => ({ channels: {}, channelAccounts: {} })),
    startChannels: vi.fn(async () => {}),
    startChannel: vi.fn(async () => {}),
    stopChannel: vi.fn(async () => {}),
    markChannelLoggedOut: vi.fn(),
    isManuallyStopped: vi.fn(() => false),
    resetRestartAttempts: vi.fn(),
    ...overrides,
  };
}

function snapshotWith(
  accounts: Record<string, Record<string, Partial<ChannelAccountSnapshot>>>,
): ChannelRuntimeSnapshot {
  const channels: ChannelRuntimeSnapshot["channels"] = {};
  const channelAccounts: ChannelRuntimeSnapshot["channelAccounts"] = {};
  for (const [channelId, accts] of Object.entries(accounts)) {
    const resolved: Record<string, ChannelAccountSnapshot> = {};
    for (const [accountId, partial] of Object.entries(accts)) {
      resolved[accountId] = { accountId, ...partial };
    }
    channelAccounts[channelId as ChannelId] = resolved;
    const firstId = Object.keys(accts)[0];
    if (firstId) {
      channels[channelId as ChannelId] = resolved[firstId];
    }
  }
  return { channels, channelAccounts };
}

describe("channel-health-monitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not run before the grace period", async () => {
    const manager = createMockChannelManager();
    const monitor = startChannelHealthMonitor({
      channelManager: manager,
      checkIntervalMs: 5_000,
      startupGraceMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(manager.getRuntimeSnapshot).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("runs health check after grace period", async () => {
    const manager = createMockChannelManager();
    const monitor = startChannelHealthMonitor({
      channelManager: manager,
      checkIntervalMs: 5_000,
      startupGraceMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(6_500);
    expect(manager.getRuntimeSnapshot).toHaveBeenCalled();
    monitor.stop();
  });

  it("skips healthy channels (running + connected)", async () => {
    const manager = createMockChannelManager({
      getRuntimeSnapshot: vi.fn(() =>
        snapshotWith({
          discord: {
            default: { running: true, connected: true, enabled: true, configured: true },
          },
        }),
      ),
    });
    const monitor = startChannelHealthMonitor({
      channelManager: manager,
      checkIntervalMs: 5_000,
      startupGraceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(5_500);
    expect(manager.stopChannel).not.toHaveBeenCalled();
    expect(manager.startChannel).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("skips disabled channels", async () => {
    const manager = createMockChannelManager({
      getRuntimeSnapshot: vi.fn(() =>
        snapshotWith({
          imessage: {
            default: {
              running: false,
              enabled: false,
              configured: true,
              lastError: "disabled",
            },
          },
        }),
      ),
    });
    const monitor = startChannelHealthMonitor({
      channelManager: manager,
      checkIntervalMs: 5_000,
      startupGraceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(5_500);
    expect(manager.startChannel).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("skips unconfigured channels", async () => {
    const manager = createMockChannelManager({
      getRuntimeSnapshot: vi.fn(() =>
        snapshotWith({
          discord: {
            default: { running: false, enabled: true, configured: false },
          },
        }),
      ),
    });
    const monitor = startChannelHealthMonitor({
      channelManager: manager,
      checkIntervalMs: 5_000,
      startupGraceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(5_500);
    expect(manager.startChannel).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("skips manually stopped channels", async () => {
    const manager = createMockChannelManager({
      getRuntimeSnapshot: vi.fn(() =>
        snapshotWith({
          discord: {
            default: { running: false, enabled: true, configured: true },
          },
        }),
      ),
      isManuallyStopped: vi.fn(() => true),
    });
    const monitor = startChannelHealthMonitor({
      channelManager: manager,
      checkIntervalMs: 5_000,
      startupGraceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(5_500);
    expect(manager.startChannel).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("restarts a stuck channel (running but not connected)", async () => {
    const manager = createMockChannelManager({
      getRuntimeSnapshot: vi.fn(() =>
        snapshotWith({
          whatsapp: {
            default: {
              running: true,
              connected: false,
              enabled: true,
              configured: true,
              linked: true,
            },
          },
        }),
      ),
    });
    const monitor = startChannelHealthMonitor({
      channelManager: manager,
      checkIntervalMs: 5_000,
      startupGraceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(5_500);
    expect(manager.stopChannel).toHaveBeenCalledWith("whatsapp", "default");
    expect(manager.resetRestartAttempts).toHaveBeenCalledWith("whatsapp", "default");
    expect(manager.startChannel).toHaveBeenCalledWith("whatsapp", "default");
    monitor.stop();
  });

  it("restarts a stopped channel that gave up (reconnectAttempts >= 10)", async () => {
    const manager = createMockChannelManager({
      getRuntimeSnapshot: vi.fn(() =>
        snapshotWith({
          discord: {
            default: {
              running: false,
              enabled: true,
              configured: true,
              reconnectAttempts: 10,
              lastError: "Failed to resolve Discord application id",
            },
          },
        }),
      ),
    });
    const monitor = startChannelHealthMonitor({
      channelManager: manager,
      checkIntervalMs: 5_000,
      startupGraceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(5_500);
    expect(manager.resetRestartAttempts).toHaveBeenCalledWith("discord", "default");
    expect(manager.startChannel).toHaveBeenCalledWith("discord", "default");
    monitor.stop();
  });

  it("restarts a channel that stopped unexpectedly (not running, not manual)", async () => {
    const manager = createMockChannelManager({
      getRuntimeSnapshot: vi.fn(() =>
        snapshotWith({
          telegram: {
            default: {
              running: false,
              enabled: true,
              configured: true,
              lastError: "polling stopped unexpectedly",
            },
          },
        }),
      ),
    });
    const monitor = startChannelHealthMonitor({
      channelManager: manager,
      checkIntervalMs: 5_000,
      startupGraceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(5_500);
    expect(manager.resetRestartAttempts).toHaveBeenCalledWith("telegram", "default");
    expect(manager.startChannel).toHaveBeenCalledWith("telegram", "default");
    monitor.stop();
  });

  it("treats missing enabled/configured flags as managed accounts", async () => {
    const manager = createMockChannelManager({
      getRuntimeSnapshot: vi.fn(() =>
        snapshotWith({
          telegram: {
            default: {
              running: false,
              lastError: "polling stopped unexpectedly",
            },
          },
        }),
      ),
    });
    const monitor = startChannelHealthMonitor({
      channelManager: manager,
      checkIntervalMs: 5_000,
      startupGraceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(5_500);
    expect(manager.startChannel).toHaveBeenCalledWith("telegram", "default");
    monitor.stop();
  });

  it("applies cooldown — skips recently restarted channels for 2 cycles", async () => {
    const manager = createMockChannelManager({
      getRuntimeSnapshot: vi.fn(() =>
        snapshotWith({
          discord: {
            default: {
              running: false,
              enabled: true,
              configured: true,
              lastError: "crashed",
            },
          },
        }),
      ),
    });
    const monitor = startChannelHealthMonitor({
      channelManager: manager,
      checkIntervalMs: 5_000,
      startupGraceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(5_500);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(manager.startChannel).toHaveBeenCalledTimes(2);
    monitor.stop();
  });

  it("caps at 3 health-monitor restarts per channel per hour", async () => {
    const manager = createMockChannelManager({
      getRuntimeSnapshot: vi.fn(() =>
        snapshotWith({
          discord: {
            default: {
              running: false,
              enabled: true,
              configured: true,
              lastError: "keeps crashing",
            },
          },
        }),
      ),
    });
    const monitor = startChannelHealthMonitor({
      channelManager: manager,
      checkIntervalMs: 1_000,
      startupGraceMs: 0,
      cooldownCycles: 1,
      maxRestartsPerHour: 3,
    });
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(manager.startChannel).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(manager.startChannel).toHaveBeenCalledTimes(3);
    monitor.stop();
  });

  it("stops cleanly", async () => {
    const manager = createMockChannelManager();
    const monitor = startChannelHealthMonitor({
      channelManager: manager,
      checkIntervalMs: 5_000,
      startupGraceMs: 0,
    });
    monitor.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(manager.getRuntimeSnapshot).not.toHaveBeenCalled();
  });

  it("stops via abort signal", async () => {
    const manager = createMockChannelManager();
    const abort = new AbortController();
    const monitor = startChannelHealthMonitor({
      channelManager: manager,
      checkIntervalMs: 5_000,
      startupGraceMs: 0,
      abortSignal: abort.signal,
    });
    abort.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(manager.getRuntimeSnapshot).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("treats running channels without a connected field as healthy", async () => {
    const manager = createMockChannelManager({
      getRuntimeSnapshot: vi.fn(() =>
        snapshotWith({
          slack: {
            default: { running: true, enabled: true, configured: true },
          },
        }),
      ),
    });
    const monitor = startChannelHealthMonitor({
      channelManager: manager,
      checkIntervalMs: 5_000,
      startupGraceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(5_500);
    expect(manager.stopChannel).not.toHaveBeenCalled();
    monitor.stop();
  });
});
