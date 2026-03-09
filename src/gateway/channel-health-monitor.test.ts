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
    isHealthMonitorEnabled: vi.fn(() => true),
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

const DEFAULT_CHECK_INTERVAL_MS = 5_000;

function createSnapshotManager(
  accounts: Record<string, Record<string, Partial<ChannelAccountSnapshot>>>,
  overrides?: Partial<ChannelManager>,
): ChannelManager {
  return createMockChannelManager({
    getRuntimeSnapshot: vi.fn(() => snapshotWith(accounts)),
    ...overrides,
  });
}

function startDefaultMonitor(
  manager: ChannelManager,
  overrides: Partial<Omit<Parameters<typeof startChannelHealthMonitor>[0], "channelManager">> = {},
) {
  return startChannelHealthMonitor({
    channelManager: manager,
    checkIntervalMs: DEFAULT_CHECK_INTERVAL_MS,
    startupGraceMs: 0,
    ...overrides,
  });
}

async function startAndRunCheck(
  manager: ChannelManager,
  overrides: Partial<Omit<Parameters<typeof startChannelHealthMonitor>[0], "channelManager">> = {},
) {
  const monitor = startDefaultMonitor(manager, overrides);
  const startupGraceMs = overrides.timing?.monitorStartupGraceMs ?? overrides.startupGraceMs ?? 0;
  const checkIntervalMs = overrides.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  await vi.advanceTimersByTimeAsync(startupGraceMs + checkIntervalMs + 1);
  return monitor;
}

function managedStoppedAccount(lastError: string): Partial<ChannelAccountSnapshot> {
  return {
    running: false,
    enabled: true,
    configured: true,
    lastError,
  };
}

function runningConnectedSlackAccount(
  overrides: Partial<ChannelAccountSnapshot>,
): Partial<ChannelAccountSnapshot> {
  return {
    running: true,
    connected: true,
    enabled: true,
    configured: true,
    ...overrides,
  };
}

function createSlackSnapshotManager(
  account: Partial<ChannelAccountSnapshot>,
  overrides?: Partial<ChannelManager>,
): ChannelManager {
  return createSnapshotManager(
    {
      slack: {
        default: account,
      },
    },
    overrides,
  );
}

function createBusyDisconnectedManager(lastRunActivityAt: number): ChannelManager {
  const now = Date.now();
  return createSnapshotManager({
    discord: {
      default: {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
        lastStartAt: now - 300_000,
        activeRuns: 1,
        busy: true,
        lastRunActivityAt,
      },
    },
  });
}

async function expectRestartedChannel(
  manager: ChannelManager,
  channel: ChannelId,
  accountId = "default",
) {
  const monitor = await startAndRunCheck(manager);
  expect(manager.stopChannel).toHaveBeenCalledWith(channel, accountId);
  expect(manager.startChannel).toHaveBeenCalledWith(channel, accountId);
  monitor.stop();
}

async function expectNoRestart(manager: ChannelManager) {
  const monitor = await startAndRunCheck(manager);
  expect(manager.stopChannel).not.toHaveBeenCalled();
  expect(manager.startChannel).not.toHaveBeenCalled();
  monitor.stop();
}

async function expectNoStart(manager: ChannelManager) {
  const monitor = await startAndRunCheck(manager);
  expect(manager.startChannel).not.toHaveBeenCalled();
  monitor.stop();
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
    const monitor = startDefaultMonitor(manager, { startupGraceMs: 60_000 });
    await vi.advanceTimersByTimeAsync(5_001);
    expect(manager.getRuntimeSnapshot).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("runs health check after grace period", async () => {
    const manager = createMockChannelManager();
    const monitor = await startAndRunCheck(manager, { startupGraceMs: 1_000 });
    expect(manager.getRuntimeSnapshot).toHaveBeenCalled();
    monitor.stop();
  });

  it("accepts timing.monitorStartupGraceMs", async () => {
    const manager = createMockChannelManager();
    const monitor = startDefaultMonitor(manager, { timing: { monitorStartupGraceMs: 60_000 } });
    await vi.advanceTimersByTimeAsync(5_001);
    expect(manager.getRuntimeSnapshot).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("skips healthy channels (running + connected)", async () => {
    const manager = createSnapshotManager({
      discord: {
        default: { running: true, connected: true, enabled: true, configured: true },
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.stopChannel).not.toHaveBeenCalled();
    expect(manager.startChannel).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("skips disabled channels", async () => {
    const manager = createSnapshotManager({
      imessage: {
        default: {
          running: false,
          enabled: false,
          configured: true,
          lastError: "disabled",
        },
      },
    });
    await expectNoStart(manager);
  });

  it("skips unconfigured channels", async () => {
    const manager = createSnapshotManager({
      discord: {
        default: { running: false, enabled: true, configured: false },
      },
    });
    await expectNoStart(manager);
  });

  it("skips manually stopped channels", async () => {
    const manager = createSnapshotManager(
      {
        discord: {
          default: { running: false, enabled: true, configured: true },
        },
      },
      { isManuallyStopped: vi.fn(() => true) },
    );
    await expectNoStart(manager);
  });

  it("skips channels with health monitor disabled globally for that account", async () => {
    const manager = createSnapshotManager(
      {
        discord: {
          default: { running: false, enabled: true, configured: true },
        },
      },
      { isHealthMonitorEnabled: vi.fn(() => false) },
    );
    await expectNoStart(manager);
  });

  it("still restarts enabled accounts when another account on the same channel is disabled", async () => {
    const now = Date.now();
    const manager = createSnapshotManager(
      {
        discord: {
          default: {
            running: true,
            connected: false,
            enabled: true,
            configured: true,
            lastStartAt: now - 300_000,
          },
          quiet: {
            running: true,
            connected: false,
            enabled: true,
            configured: true,
            lastStartAt: now - 300_000,
          },
        },
      },
      {
        isHealthMonitorEnabled: vi.fn((channelId: ChannelId, accountId: string) => {
          return !(channelId === "discord" && accountId === "quiet");
        }),
      },
    );
    const monitor = await startAndRunCheck(manager);
    expect(manager.stopChannel).toHaveBeenCalledWith("discord", "default");
    expect(manager.startChannel).toHaveBeenCalledWith("discord", "default");
    expect(manager.stopChannel).not.toHaveBeenCalledWith("discord", "quiet");
    expect(manager.startChannel).not.toHaveBeenCalledWith("discord", "quiet");
    monitor.stop();
  });

  it("restarts a stuck channel (running but not connected)", async () => {
    const now = Date.now();
    const manager = createSnapshotManager({
      whatsapp: {
        default: {
          running: true,
          connected: false,
          enabled: true,
          configured: true,
          linked: true,
          lastStartAt: now - 300_000,
        },
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.stopChannel).toHaveBeenCalledWith("whatsapp", "default");
    expect(manager.resetRestartAttempts).toHaveBeenCalledWith("whatsapp", "default");
    expect(manager.startChannel).toHaveBeenCalledWith("whatsapp", "default");
    monitor.stop();
  });

  it("skips restart when channel is busy with active runs", async () => {
    const now = Date.now();
    const manager = createSnapshotManager({
      discord: {
        default: {
          running: true,
          connected: false,
          enabled: true,
          configured: true,
          lastStartAt: now - 300_000,
          activeRuns: 2,
          busy: true,
          lastRunActivityAt: now - 30_000,
        },
      },
    });
    await expectNoRestart(manager);
  });

  it("restarts busy channels when run activity is stale", async () => {
    const now = Date.now();
    const manager = createBusyDisconnectedManager(now - 26 * 60_000);
    await expectRestartedChannel(manager, "discord");
  });

  it("restarts disconnected channels when busy flags are inherited from a prior lifecycle", async () => {
    const now = Date.now();
    const manager = createBusyDisconnectedManager(now - 301_000);
    await expectRestartedChannel(manager, "discord");
  });

  it("skips recently-started channels while they are still connecting", async () => {
    const now = Date.now();
    const manager = createSnapshotManager({
      discord: {
        default: {
          running: true,
          connected: false,
          enabled: true,
          configured: true,
          lastStartAt: now - 5_000,
        },
      },
    });
    await expectNoRestart(manager);
  });

  it("respects custom per-channel startup grace", async () => {
    const now = Date.now();
    const manager = createSnapshotManager({
      discord: {
        default: {
          running: true,
          connected: false,
          enabled: true,
          configured: true,
          lastStartAt: now - 30_000,
        },
      },
    });
    const monitor = await startAndRunCheck(manager, { channelStartupGraceMs: 60_000 });
    expect(manager.stopChannel).not.toHaveBeenCalled();
    expect(manager.startChannel).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("restarts a stopped channel that gave up (reconnectAttempts >= 10)", async () => {
    const manager = createSnapshotManager({
      discord: {
        default: {
          ...managedStoppedAccount("Failed to resolve Discord application id"),
          reconnectAttempts: 10,
        },
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.resetRestartAttempts).toHaveBeenCalledWith("discord", "default");
    expect(manager.startChannel).toHaveBeenCalledWith("discord", "default");
    monitor.stop();
  });

  it("restarts a channel that stopped unexpectedly (not running, not manual)", async () => {
    const manager = createSnapshotManager({
      telegram: {
        default: managedStoppedAccount("polling stopped unexpectedly"),
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.resetRestartAttempts).toHaveBeenCalledWith("telegram", "default");
    expect(manager.startChannel).toHaveBeenCalledWith("telegram", "default");
    monitor.stop();
  });

  it("treats missing enabled/configured flags as managed accounts", async () => {
    const manager = createSnapshotManager({
      telegram: {
        default: {
          running: false,
          lastError: "polling stopped unexpectedly",
        },
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.startChannel).toHaveBeenCalledWith("telegram", "default");
    monitor.stop();
  });

  it("applies cooldown — skips recently restarted channels for 2 cycles", async () => {
    const manager = createSnapshotManager({
      discord: {
        default: managedStoppedAccount("crashed"),
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    // Base cooldown = 2 × 5000 = 10000ms. After 1st restart (consecutive=1),
    // exponential backoff doubles it to 20000ms = 4 check intervals.
    await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS);
    expect(manager.startChannel).toHaveBeenCalledTimes(2);
    monitor.stop();
  });

  it("caps at 3 health-monitor restarts per channel per hour", async () => {
    const manager = createSnapshotManager({
      discord: {
        default: managedStoppedAccount("keeps crashing"),
      },
    });
    const monitor = startDefaultMonitor(manager, {
      checkIntervalMs: 1_000,
      cooldownCycles: 1,
      maxRestartsPerHour: 3,
    });
    // With exponential backoff (cooldownCycles=1, base=1000ms):
    // 1st: at ~1000ms (base cooldown, consecutive 0→1)
    // 2nd: ~1000 + 2000 backoff → ~4000ms (consecutive 1→2)
    // 3rd: ~4000 + 4000 backoff → ~9000ms (consecutive 2→3)
    await vi.advanceTimersByTimeAsync(10_001);
    expect(manager.startChannel).toHaveBeenCalledTimes(3);
    // Subsequent restarts should be blocked by the per-hour limit
    await vi.advanceTimersByTimeAsync(20_001);
    expect(manager.startChannel).toHaveBeenCalledTimes(3);
    monitor.stop();
  });

  it("runs checks single-flight when restart work is still in progress", async () => {
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = () => resolve();
    });
    const manager = createSnapshotManager(
      {
        telegram: {
          default: managedStoppedAccount("stopped"),
        },
      },
      {
        startChannel: vi.fn(async () => {
          await startGate;
        }),
      },
    );
    const monitor = startDefaultMonitor(manager, { checkIntervalMs: 100, cooldownCycles: 0 });
    await vi.advanceTimersByTimeAsync(120);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    releaseStart?.();
    await Promise.resolve();
    monitor.stop();
  });

  it("stops cleanly", async () => {
    const manager = createMockChannelManager();
    const monitor = startDefaultMonitor(manager);
    monitor.stop();
    await vi.advanceTimersByTimeAsync(5_001);
    expect(manager.getRuntimeSnapshot).not.toHaveBeenCalled();
  });

  it("stops via abort signal", async () => {
    const manager = createMockChannelManager();
    const abort = new AbortController();
    const monitor = startDefaultMonitor(manager, { abortSignal: abort.signal });
    abort.abort();
    await vi.advanceTimersByTimeAsync(5_001);
    expect(manager.getRuntimeSnapshot).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("treats running channels without a connected field as healthy", async () => {
    const manager = createSnapshotManager({
      slack: {
        default: { running: true, enabled: true, configured: true },
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.stopChannel).not.toHaveBeenCalled();
    monitor.stop();
  });

  describe("stale socket detection", () => {
    const STALE_THRESHOLD = 30 * 60_000;

    it("restarts a channel with no events past the stale threshold", async () => {
      const now = Date.now();
      const manager = createSlackSnapshotManager(
        runningConnectedSlackAccount({
          lastStartAt: now - STALE_THRESHOLD - 60_000,
          lastEventAt: now - STALE_THRESHOLD - 30_000,
        }),
      );
      await expectRestartedChannel(manager, "slack");
    });

    it("skips channels with recent events", async () => {
      const now = Date.now();
      const manager = createSlackSnapshotManager(
        runningConnectedSlackAccount({
          lastStartAt: now - STALE_THRESHOLD - 60_000,
          lastEventAt: now - 5_000,
        }),
      );
      await expectNoRestart(manager);
    });

    it("skips channels still within the startup grace window for stale detection", async () => {
      const now = Date.now();
      const manager = createSlackSnapshotManager(
        runningConnectedSlackAccount({
          lastStartAt: now - 5_000,
          lastEventAt: null,
        }),
      );
      await expectNoRestart(manager);
    });

    it("restarts a channel that has seen no events since connect past the stale threshold", async () => {
      const now = Date.now();
      const manager = createSlackSnapshotManager(
        runningConnectedSlackAccount({
          lastStartAt: now - STALE_THRESHOLD - 60_000,
          lastEventAt: now - STALE_THRESHOLD - 60_000,
        }),
      );
      await expectRestartedChannel(manager, "slack");
    });

    it("skips connected channels that do not report event liveness", async () => {
      const now = Date.now();
      const manager = createSnapshotManager({
        telegram: {
          default: {
            running: true,
            connected: true,
            enabled: true,
            configured: true,
            lastStartAt: now - STALE_THRESHOLD - 60_000,
            lastEventAt: null,
          },
        },
      });
      await expectNoRestart(manager);
    });

    it("respects custom staleEventThresholdMs", async () => {
      const customThreshold = 10 * 60_000;
      const now = Date.now();
      const manager = createSlackSnapshotManager(
        runningConnectedSlackAccount({
          lastStartAt: now - customThreshold - 60_000,
          lastEventAt: now - customThreshold - 30_000,
        }),
      );
      const monitor = await startAndRunCheck(manager, {
        staleEventThresholdMs: customThreshold,
      });
      expect(manager.stopChannel).toHaveBeenCalledWith("slack", "default");
      expect(manager.startChannel).toHaveBeenCalledWith("slack", "default");
      monitor.stop();
    });
  });

  describe("consecutive restart tracking and escalation", () => {
    it("tracks consecutive restarts and calls onBeforeRestart after threshold", async () => {
      const onBeforeRestart = vi.fn();
      const manager = createSnapshotManager({
        discord: {
          default: managedStoppedAccount("keeps crashing"),
        },
      });
      // Use short intervals; cooldownCycles=1 means base cooldown=1000ms
      const monitor = startDefaultMonitor(manager, {
        checkIntervalMs: 1_000,
        cooldownCycles: 1,
        maxRestartsPerHour: 10,
        onBeforeRestart,
      });

      // 1st restart: at ~1001ms (base cooldown 1000ms, backoff=2^0=1x)
      await vi.advanceTimersByTimeAsync(1_001);
      expect(manager.startChannel).toHaveBeenCalledTimes(1);
      expect(onBeforeRestart).not.toHaveBeenCalled();

      // 2nd restart: consecutive=1 → backoff=2^1=2x → cooldown=2000ms
      await vi.advanceTimersByTimeAsync(3_001);
      expect(manager.startChannel).toHaveBeenCalledTimes(2);
      expect(onBeforeRestart).not.toHaveBeenCalled();

      // 3rd restart: consecutive=2 → backoff=2^2=4x → cooldown=4000ms
      await vi.advanceTimersByTimeAsync(5_001);
      expect(manager.startChannel).toHaveBeenCalledTimes(3);
      expect(onBeforeRestart).toHaveBeenCalledTimes(1);
      expect(onBeforeRestart).toHaveBeenCalledWith({
        channelId: "discord",
        accountId: "default",
        consecutiveRestarts: 3,
      });

      monitor.stop();
    });

    it("resets consecutive restart counter when channel becomes stable", async () => {
      const onChannelStable = vi.fn();
      let currentStatus: Partial<ChannelAccountSnapshot> = managedStoppedAccount("crashed");

      const manager = createMockChannelManager({
        getRuntimeSnapshot: vi.fn(() => snapshotWith({ discord: { default: currentStatus } })),
      });

      const monitor = startDefaultMonitor(manager, {
        checkIntervalMs: 1_000,
        cooldownCycles: 1,
        onChannelStable,
      });

      // Trigger a restart
      await vi.advanceTimersByTimeAsync(2_001);
      expect(manager.startChannel).toHaveBeenCalledTimes(1);

      // Channel comes back healthy
      currentStatus = {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
      };

      // After 5+ minutes of stability, counter should reset
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_001);
      expect(onChannelStable).toHaveBeenCalledWith({
        channelId: "discord",
        accountId: "default",
      });

      monitor.stop();
    });

    it("applies exponential backoff to cooldown after consecutive restarts", async () => {
      const manager = createSnapshotManager({
        discord: {
          default: managedStoppedAccount("keeps crashing"),
        },
      });

      // Base cooldown = 2 cycles × 5000ms = 10000ms
      const monitor = startDefaultMonitor(manager, {
        checkIntervalMs: DEFAULT_CHECK_INTERVAL_MS,
        cooldownCycles: 2,
        maxRestartsPerHour: 20,
      });

      // 1st restart: backoff=2^0=1x, effectiveCooldown=10000ms
      await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS + 1);
      expect(manager.startChannel).toHaveBeenCalledTimes(1);

      // After 1st: consecutive=1, backoff=2^1=2x, effectiveCooldown=20000ms
      // 2 intervals = 10000ms: still in cooldown
      await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS * 2);
      expect(manager.startChannel).toHaveBeenCalledTimes(1);

      // 3 intervals = 15000ms: still in cooldown (need >20000ms)
      await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS);
      expect(manager.startChannel).toHaveBeenCalledTimes(1);

      // 5 intervals = 25000ms total from 1st restart: past 20000ms backoff
      await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS * 2 + 1);
      expect(manager.startChannel).toHaveBeenCalledTimes(2);

      monitor.stop();
    });
  });
});
