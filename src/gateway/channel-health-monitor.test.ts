import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ChannelId, ChannelAccountSnapshot } from "../channels/plugins/types.public.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { startChannelHealthMonitor } from "./channel-health-monitor.js";
import {
  createMockChannelManager,
  createSnapshotManager,
  snapshotWith,
} from "./channel-health-monitor.test-support.js";
import type { ChannelManager } from "./server-channels.js";

const CHECK_INTERVAL_MS = 5 * 60_000;
const STARTUP_GRACE_MS = 60_000;
let clock: ReturnType<typeof createGatewaySchedulerClock>;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;

function startDefaultMonitor(manager: ChannelManager) {
  return startChannelHealthMonitor({ scheduler, channelManager: manager });
}

function markRestartPending(account: Partial<ChannelAccountSnapshot>) {
  account.running = false;
  account.connected = false;
  account.restartPending = true;
  account.reconnectAttempts = 0;
  return new Map();
}

async function startAndRunCheck(manager: ChannelManager) {
  const monitor = startDefaultMonitor(manager);
  await clock.advanceBy(STARTUP_GRACE_MS + 1);
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

function disconnectedAccount(
  lastStartAt: number,
  overrides: Partial<ChannelAccountSnapshot> = {},
): Partial<ChannelAccountSnapshot> {
  return {
    running: true,
    connected: false,
    enabled: true,
    configured: true,
    lastStartAt,
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
        ...disconnectedAccount(now - 300_000),
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
  expect(manager.stopChannel).toHaveBeenCalledWith(channel, accountId, { manual: false });
  expect(manager.startChannel).toHaveBeenCalledWith(channel, accountId, {
    reason: "health-monitor",
  });
  monitor.stop();
}

async function expectNoRestart(manager: ChannelManager) {
  const monitor = await startAndRunCheck(manager);
  await advanceHealthCheck();
  await advanceHealthCheck();
  expect(manager.stopChannel).not.toHaveBeenCalled();
  expect(manager.startChannel).not.toHaveBeenCalled();
  expect(manager.resetRestartAttempts).not.toHaveBeenCalled();
  monitor.stop();
}

async function advanceHealthCheck() {
  await clock.advanceBy(CHECK_INTERVAL_MS);
}

describe("channel-health-monitor", () => {
  beforeEach(() => {
    clock = createGatewaySchedulerClock(Date.now());
    scheduler = createTestGatewayScheduler(clock.clock);
    vi.spyOn(Date, "now").mockImplementation(clock.clock.now);
  });
  afterEach(async () => {
    await scheduler.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps running after a runtime snapshot failure", async () => {
    const manager = createMockChannelManager({
      getRuntimeSnapshot: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("snapshot failed");
        })
        .mockReturnValue({ channels: {}, channelAccounts: {} }),
    });
    const monitor = startDefaultMonitor(manager);

    await clock.advanceBy(STARTUP_GRACE_MS + 1);
    expect(manager.getRuntimeSnapshot).toHaveBeenCalledTimes(1);

    await clock.advanceBy(CHECK_INTERVAL_MS + 1);

    expect(manager.getRuntimeSnapshot).toHaveBeenCalledTimes(2);
    expect(manager.startChannel).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("preserves the restart budget during plugin reload and recovers when its pause clears", async () => {
    const snapshot = snapshotWith({
      discord: { default: managedStoppedAccount("Plugin replacement pending") },
    });
    const reloadingChannels = new Map<ChannelId, string | undefined>([["discord", "default"]]);
    snapshot.reloadingChannels = reloadingChannels;
    const manager = createMockChannelManager({ getRuntimeSnapshot: vi.fn(() => snapshot) });
    const monitor = startDefaultMonitor(manager);
    try {
      await clock.advanceBy(STARTUP_GRACE_MS + 2 * CHECK_INTERVAL_MS + 1);
      expect(manager.startChannel).not.toHaveBeenCalled();
      expect(manager.resetRestartAttempts).not.toHaveBeenCalled();

      reloadingChannels.clear();
      await clock.advanceBy(CHECK_INTERVAL_MS);
      expect(manager.startChannel).toHaveBeenCalledExactlyOnceWith("discord", "default", {
        reason: "health-monitor",
      });
      expect(manager.resetRestartAttempts).toHaveBeenCalledExactlyOnceWith("discord", "default");
    } finally {
      monitor.stop();
    }
  });

  it("does not start a replacement when channel teardown fails", async () => {
    const manager = createSlackSnapshotManager(disconnectedAccount(Date.now() - 300_000), {
      stopChannel: vi.fn(async () => {
        throw new Error("stop failed");
      }),
    });

    const monitor = await startAndRunCheck(manager);

    expect(manager.stopChannel).toHaveBeenCalledWith("slack", "default", { manual: false });
    expect(manager.resetRestartAttempts).not.toHaveBeenCalled();
    expect(manager.startChannel).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("treats crash-loop suppressed accounts as expected stopped", async () => {
    let suppressed = true;
    let allowRecovery = false;
    const suppression = { reason: "crash-loop-breaker" as const, message: "safe mode" };
    const recoverAutostartSuppression = vi.fn(async () => {
      suppressed = !allowRecovery;
      return allowRecovery ? undefined : Date.now() + 300_000;
    });
    const manager = createSnapshotManager(
      {
        discord: {
          default: managedStoppedAccount("safe mode"),
        },
      },
      {
        getAutostartSuppression: vi.fn(() => (suppressed ? suppression : null)),
        recoverAutostartSuppression,
      },
    );
    const monitor = await startAndRunCheck(manager);

    expect(manager.resetRestartAttempts).not.toHaveBeenCalled();
    expect(manager.startChannel).not.toHaveBeenCalled();

    allowRecovery = true;
    await advanceHealthCheck();

    expect(recoverAutostartSuppression).toHaveBeenCalled();
    expect(manager.resetRestartAttempts).toHaveBeenCalledWith("discord", "default");
    expect(manager.startChannel).toHaveBeenCalledWith("discord", "default", {
      reason: "health-monitor",
    });
    monitor.stop();
  });

  it("does not restart an ambient-suppressed dev channel", async () => {
    const manager = createSnapshotManager(
      {
        discord: {
          default: managedStoppedAccount("ambient credentials suppressed"),
        },
      },
      {
        isAmbientAutostartSuppressed: vi.fn((channelId) => channelId === "discord"),
      },
    );

    await expectNoRestart(manager);
  });

  it("does not restart an unlinked channel with terminalDisconnect set across checks", async () => {
    const manager = createSnapshotManager({
      whatsapp: {
        default: {
          running: false,
          enabled: true,
          configured: true,
          linked: false,
          terminalDisconnect: true,
        },
      },
    });
    await expectNoRestart(manager);
  });

  it("does not restart a channel with blocked lifecycle", async () => {
    const manager = createSlackSnapshotManager({
      running: true,
      connected: true,
      enabled: true,
      configured: true,
      lifecycle: "blocked",
      linked: false,
      ingressUnavailable: true,
      lastError: "Slack identity unavailable",
    });
    await expectNoRestart(manager);
  });

  it("restarts a running channel with a live socket but dead ingress", async () => {
    // A restart is the only way to re-prove ingress, so recovery from a transient
    // queue-open failure must stay automatic. Without the ingress dimension this
    // account evaluated as healthy and was never touched at all.
    const manager = createSnapshotManager({
      slack: {
        default: {
          running: true,
          connected: true,
          enabled: true,
          configured: true,
          ingressUnavailable: true,
        },
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.stopChannel).toHaveBeenCalledWith("slack", "default", { manual: false });
    expect(manager.startChannel).toHaveBeenCalledWith("slack", "default", {
      reason: "health-monitor",
    });
    monitor.stop();
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
    await expectNoRestart(manager);
  });

  it("still restarts enabled accounts when another account on the same channel is disabled", async () => {
    const now = Date.now();
    const manager = createSnapshotManager(
      {
        discord: {
          default: disconnectedAccount(now - 300_000),
          quiet: disconnectedAccount(now - 300_000),
        },
      },
      {
        isHealthMonitorEnabled: vi.fn((channelId: ChannelId, accountId: string) => {
          return !(channelId === "discord" && accountId === "quiet");
        }),
      },
    );
    const monitor = await startAndRunCheck(manager);
    expect(manager.stopChannel).toHaveBeenCalledWith("discord", "default", { manual: false });
    expect(manager.startChannel).toHaveBeenCalledWith("discord", "default", {
      reason: "health-monitor",
    });
    expect(manager.stopChannel).not.toHaveBeenCalledWith("discord", "quiet", { manual: false });
    expect(manager.startChannel).not.toHaveBeenCalledWith("discord", "quiet", expect.anything());
    monitor.stop();
  });

  it("restarts busy channels when run activity is stale", async () => {
    const now = Date.now();
    const manager = createBusyDisconnectedManager(now - 26 * 60_000);
    await expectRestartedChannel(manager, "discord");
  });

  it("throttles an account stuck in pending restart at the production cadence", async () => {
    const account: Partial<ChannelAccountSnapshot> = disconnectedAccount(Date.now() - 300_000);
    const manager = createSnapshotManager(
      {
        discord: {
          default: account,
        },
      },
      {
        // Every start attempt leaves the account stuck in pending restart.
        startChannel: vi.fn(async () => markRestartPending(account)),
      },
    );
    const monitor = await startAndRunCheck(manager);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    await advanceHealthCheck();
    expect(manager.startChannel).toHaveBeenCalledTimes(2);
    await advanceHealthCheck();
    expect(manager.startChannel).toHaveBeenCalledTimes(2);
    // With exact virtual wakes, one free continuation is followed by one
    // cooldown-limited restart every three checks. Real wakes can arrive late.
    for (let check = 2; check < 12; check += 1) {
      await advanceHealthCheck();
    }
    expect(manager.startChannel).toHaveBeenCalledTimes(6);
    monitor.stop();
  });

  it("runs one free continuation inside the production cooldown", async () => {
    const account: Partial<ChannelAccountSnapshot> = disconnectedAccount(Date.now() - 300_000);
    const manager = createSnapshotManager(
      {
        discord: {
          default: account,
        },
      },
      {
        startChannel: vi.fn(async () => markRestartPending(account)),
      },
    );
    const monitor = await startAndRunCheck(manager);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    await advanceHealthCheck();
    expect(manager.startChannel).toHaveBeenCalledTimes(2);
    monitor.stop();
  });

  it("does not re-arm the free continuation on a transient reconnect-attempt bump", async () => {
    const account: Partial<ChannelAccountSnapshot> = disconnectedAccount(Date.now() - 300_000);
    const manager = createSnapshotManager(
      {
        discord: {
          default: account,
        },
      },
      {
        startChannel: vi.fn(async () => markRestartPending(account)),
      },
    );
    const monitor = await startAndRunCheck(manager);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    await advanceHealthCheck();
    expect(manager.startChannel).toHaveBeenCalledTimes(2);

    // Supervisor retry bumps attempts while the account stays stuck pending…
    account.reconnectAttempts = 2;
    await advanceHealthCheck();
    // …and returning to zero must not grant another unmetered continuation.
    account.reconnectAttempts = 0;
    await advanceHealthCheck();
    await advanceHealthCheck();
    // A normal budgeted restart at the expired cooldown does not re-arm the pass.
    expect(manager.startChannel).toHaveBeenCalledTimes(3);
    monitor.stop();
  });

  it("grants a fresh pending continuation after the account recovers", async () => {
    const account: Partial<ChannelAccountSnapshot> = disconnectedAccount(Date.now() - 300_000);
    let startBehavior: "pending" | "healthy" = "pending";
    const manager = createSnapshotManager(
      {
        discord: {
          default: account,
        },
      },
      {
        startChannel: vi.fn(async () => {
          if (startBehavior === "pending") {
            account.running = false;
            account.connected = false;
            account.restartPending = true;
            account.reconnectAttempts = 0;
          } else {
            account.running = true;
            account.connected = true;
            account.restartPending = false;
          }
          return new Map();
        }),
      },
    );
    const monitor = await startAndRunCheck(manager);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);

    startBehavior = "healthy";
    await advanceHealthCheck();
    expect(manager.startChannel).toHaveBeenCalledTimes(2);

    // Healthy pass clears the used continuation.
    await advanceHealthCheck();
    expect(manager.startChannel).toHaveBeenCalledTimes(2);

    // A new timed-out recovery earns a free continuation, without advancing the
    // last budgeted restart: the following check can use the expired cooldown.
    startBehavior = "pending";
    account.running = false;
    account.connected = false;
    account.restartPending = true;
    account.reconnectAttempts = 0;
    await advanceHealthCheck();
    expect(manager.startChannel).toHaveBeenCalledTimes(3);
    await advanceHealthCheck();
    expect(manager.startChannel).toHaveBeenCalledTimes(4);
    monitor.stop();
  });

  it("defers to the channel supervisor while its own auto-restart is scheduled", async () => {
    let autoRestartScheduled = true;
    const manager = createSnapshotManager(
      {
        whatsapp: {
          default: {
            ...managedStoppedAccount("Another process owns this WhatsApp connection."),
            linked: true,
            restartPending: true,
            reconnectAttempts: 5,
          },
        },
      },
      { isAutoRestartScheduled: vi.fn(() => autoRestartScheduled) },
    );

    const monitor = await startAndRunCheck(manager);
    expect(manager.startChannel).not.toHaveBeenCalled();
    // Deferring must not burn the attempt ladder the supervisor is still walking.
    expect(manager.resetRestartAttempts).not.toHaveBeenCalled();

    await advanceHealthCheck();
    expect(manager.startChannel).not.toHaveBeenCalled();

    // Once the supervisor gives up it no longer owns recovery, so the monitor
    // becomes the account's last restart owner again.
    autoRestartScheduled = false;
    await advanceHealthCheck();
    expect(manager.startChannel).toHaveBeenCalledWith("whatsapp", "default", {
      reason: "health-monitor",
    });
    monitor.stop();
  });

  it("counts failed restart attempts toward the production cooldown", async () => {
    const manager = createSnapshotManager(
      {
        discord: {
          default: managedStoppedAccount("keeps crashing"),
        },
      },
      {
        startChannel: vi.fn(async () => {
          throw new Error("startup failed");
        }),
      },
    );
    const monitor = await startAndRunCheck(manager);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    await advanceHealthCheck();
    await advanceHealthCheck();
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    await advanceHealthCheck();
    expect(manager.startChannel).toHaveBeenCalledTimes(2);
    monitor.stop();
  });

  it("retries after the production cooldown when scheduler wakes arrive slightly late", async () => {
    const manager = createSlackSnapshotManager(managedStoppedAccount("stopped"));
    const monitor = await startAndRunCheck(manager);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    for (let starts = 2; starts <= 6; starts += 1) {
      await clock.advanceBy(CHECK_INTERVAL_MS + 1);
      expect(manager.startChannel).toHaveBeenCalledTimes(starts - 1);
      await clock.advanceBy(CHECK_INTERVAL_MS + 1);
      expect(manager.startChannel).toHaveBeenCalledTimes(starts);
    }
    monitor.stop();
  });

  it("runs checks single-flight when restart work is still in progress", async () => {
    const { promise: startGate, resolve: releaseStart } = createDeferred();
    const manager = createSnapshotManager(
      {
        telegram: {
          default: managedStoppedAccount("stopped"),
        },
      },
      {
        startChannel: vi.fn(async () => {
          await startGate;
          return new Map();
        }),
      },
    );
    const monitor = startDefaultMonitor(manager);
    const check = clock.advanceBy(STARTUP_GRACE_MS + 1);
    try {
      expect(manager.startChannel).toHaveBeenCalledTimes(1);
      await clock.advanceBy(2 * CHECK_INTERVAL_MS);
      expect(manager.startChannel).toHaveBeenCalledTimes(1);
    } finally {
      releaseStart();
      monitor.stop();
      await check;
    }
  });

  it("does not resume an in-flight restart after shutdown", async () => {
    const { promise: stopGate, resolve: releaseStop } = createDeferred();
    const manager = createSlackSnapshotManager(disconnectedAccount(Date.now() - 300_000), {
      stopChannel: vi.fn(async () => {
        await stopGate;
      }),
    });
    const monitor = startDefaultMonitor(manager);

    const check = clock.advanceBy(STARTUP_GRACE_MS + 1);
    try {
      expect(manager.stopChannel).toHaveBeenCalledTimes(1);

      monitor.shutdown();
      releaseStop();
      await monitor.waitForIdle();

      expect(manager.resetRestartAttempts).not.toHaveBeenCalled();
      expect(manager.startChannel).not.toHaveBeenCalled();
    } finally {
      releaseStop();
      monitor.shutdown();
      await check;
    }
  });

  it("does not process later accounts after a retired monitor's stop rejects", async () => {
    const { promise: stopGate, reject: rejectStop } = createDeferred();
    const staleAccount = disconnectedAccount(Date.now() - 300_000);
    const manager = createSnapshotManager(
      { slack: { first: staleAccount, second: staleAccount } },
      {
        stopChannel: vi.fn(async () => {
          await stopGate;
        }),
      },
    );
    const monitor = startDefaultMonitor(manager);

    const check = clock.advanceBy(STARTUP_GRACE_MS + 1);
    try {
      expect(manager.stopChannel).toHaveBeenCalledTimes(1);

      monitor.shutdown();
      rejectStop(new Error("stop failed"));
      await monitor.waitForIdle();

      expect(manager.stopChannel).toHaveBeenCalledTimes(1);
      expect(manager.resetRestartAttempts).not.toHaveBeenCalled();
      expect(manager.startChannel).not.toHaveBeenCalled();
    } finally {
      rejectStop(new Error("stop failed"));
      monitor.shutdown();
      await check;
    }
  });

  it.each([
    { label: "replacement", shutdownAfterRetire: false, expectedStarts: 1 },
    { label: "replacement followed by shutdown", shutdownAfterRetire: true, expectedStarts: 0 },
  ])("coordinates the in-flight restart during $label", async (testCase) => {
    const { promise: stopGate, resolve: releaseStop } = createDeferred();
    const staleAccount = disconnectedAccount(Date.now() - 300_000);
    const manager = createSnapshotManager(
      { slack: { first: staleAccount, second: staleAccount } },
      {
        stopChannel: vi.fn(async () => {
          await stopGate;
        }),
      },
    );
    const monitor = startDefaultMonitor(manager);

    const check = clock.advanceBy(STARTUP_GRACE_MS + 1);
    try {
      expect(manager.stopChannel).toHaveBeenCalledTimes(1);

      monitor.stop();
      const idle = monitor.waitForIdle();
      if (testCase.shutdownAfterRetire) {
        monitor.shutdown();
      }
      releaseStop();
      await idle;

      expect(manager.stopChannel).toHaveBeenCalledTimes(1);
      expect(manager.resetRestartAttempts).toHaveBeenCalledTimes(testCase.expectedStarts);
      expect(manager.startChannel).toHaveBeenCalledTimes(testCase.expectedStarts);
    } finally {
      releaseStop();
      monitor.shutdown();
      await check;
    }
  });

  it("bounds replacement handoff and abandons a late restart", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { promise: stopGate, resolve: releaseStop } = createDeferred();
    const manager = createSlackSnapshotManager(disconnectedAccount(Date.now() - 300_000), {
      stopChannel: vi.fn(async () => {
        await stopGate;
      }),
    });
    const monitor = startDefaultMonitor(manager);

    const check = clock.advanceBy(STARTUP_GRACE_MS + 1);
    try {
      monitor.stop();
      const handoff = monitor.waitForIdle();
      await vi.advanceTimersByTimeAsync(5_001);
      await handoff;

      releaseStop();
      await monitor.waitForIdle();

      expect(manager.resetRestartAttempts).not.toHaveBeenCalled();
      expect(manager.startChannel).not.toHaveBeenCalled();
    } finally {
      releaseStop();
      monitor.shutdown();
      await check;
    }
  });

  describe("stale socket detection", () => {
    const STALE_THRESHOLD = 30 * 60_000;

    it("skips channels with recent transport activity", async () => {
      const now = Date.now();
      const manager = createSlackSnapshotManager(
        runningConnectedSlackAccount({
          lastStartAt: now - STALE_THRESHOLD - 60_000,
          lastTransportActivityAt: now - 5_000,
        }),
      );
      await expectNoRestart(manager);
    });

    it("restarts channels past the production stale transport threshold", async () => {
      const now = Date.now();
      const manager = createSlackSnapshotManager(
        runningConnectedSlackAccount({
          lastStartAt: now - STALE_THRESHOLD - 60_000,
          lastTransportActivityAt: now - STALE_THRESHOLD - 30_000,
        }),
      );
      const monitor = await startAndRunCheck(manager);
      expect(manager.stopChannel).toHaveBeenCalledWith("slack", "default", { manual: false });
      expect(manager.startChannel).toHaveBeenCalledWith("slack", "default", {
        reason: "health-monitor",
      });
      monitor.stop();
    });
  });
});
