import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
/**
 * Channel health monitor regression tests.
 */
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

const DEFAULT_CHECK_INTERVAL_MS = 5_000;
let clock: ReturnType<typeof createGatewaySchedulerClock>;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;

function startDefaultMonitor(
  manager: ChannelManager,
  overrides: Partial<Omit<Parameters<typeof startChannelHealthMonitor>[0], "channelManager">> = {},
) {
  return startChannelHealthMonitor({
    scheduler,
    channelManager: manager,
    checkIntervalMs: DEFAULT_CHECK_INTERVAL_MS,
    ...overrides,
    timing: { monitorStartupGraceMs: 0, ...overrides.timing },
  });
}

function markRestartPending(account: Partial<ChannelAccountSnapshot>) {
  account.running = false;
  account.connected = false;
  account.restartPending = true;
  account.reconnectAttempts = 0;
  return new Map();
}

async function startAndRunCheck(
  manager: ChannelManager,
  overrides: Partial<Omit<Parameters<typeof startChannelHealthMonitor>[0], "channelManager">> = {},
) {
  const monitor = startDefaultMonitor(manager, overrides);
  const startupGraceMs = overrides.timing?.monitorStartupGraceMs ?? 0;
  await clock.advanceBy(startupGraceMs + 1);
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
  expect(manager.startChannel).toHaveBeenCalledWith(channel, accountId);
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
  await clock.advanceBy(DEFAULT_CHECK_INTERVAL_MS);
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

  it("normalizes oversized check intervals before rearming timers", async () => {
    const monitor = startDefaultMonitor(createMockChannelManager(), {
      checkIntervalMs: Number.MAX_SAFE_INTEGER,
    });

    await clock.advanceBy(1);

    expect(clock.wakes.at(-1)?.delayMs).toBe(MAX_TIMER_TIMEOUT_MS);
    monitor.stop();
  });

  it("runs health check after grace period", async () => {
    const manager = createMockChannelManager();
    const monitor = startDefaultMonitor(manager, {
      checkIntervalMs: 60_000,
      timing: { monitorStartupGraceMs: 1_000 },
    });

    await clock.advanceBy(1_001);

    expect(manager.getRuntimeSnapshot).toHaveBeenCalled();
    monitor.stop();
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

    await clock.advanceBy(1);
    expect(manager.getRuntimeSnapshot).toHaveBeenCalledTimes(1);

    await clock.advanceBy(DEFAULT_CHECK_INTERVAL_MS + 1);

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
    const monitor = startDefaultMonitor(manager, {
      cooldownCycles: 0,
      maxRestartsPerHour: 1,
    });
    try {
      await clock.advanceBy(2 * DEFAULT_CHECK_INTERVAL_MS + 1);
      expect(manager.startChannel).not.toHaveBeenCalled();
      expect(manager.resetRestartAttempts).not.toHaveBeenCalled();

      reloadingChannels.clear();
      await clock.advanceBy(DEFAULT_CHECK_INTERVAL_MS);
      expect(manager.startChannel).toHaveBeenCalledExactlyOnceWith("discord", "default");
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

    const monitor = await startAndRunCheck(manager, { cooldownCycles: 0 });

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
    const monitor = startDefaultMonitor(manager, {
      checkIntervalMs: 100,
      cooldownCycles: 0,
      maxRestartsPerHour: 1,
    });

    await clock.advanceBy(350);

    expect(manager.resetRestartAttempts).not.toHaveBeenCalled();
    expect(manager.startChannel).not.toHaveBeenCalled();

    allowRecovery = true;
    await clock.advanceBy(101);

    expect(recoverAutostartSuppression).toHaveBeenCalled();
    expect(manager.resetRestartAttempts).toHaveBeenCalledWith("discord", "default");
    expect(manager.startChannel).toHaveBeenCalledWith("discord", "default");
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
    expect(manager.startChannel).toHaveBeenCalledWith("slack", "default");
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
    expect(manager.startChannel).toHaveBeenCalledWith("discord", "default");
    expect(manager.stopChannel).not.toHaveBeenCalledWith("discord", "quiet", { manual: false });
    expect(manager.startChannel).not.toHaveBeenCalledWith("discord", "quiet");
    monitor.stop();
  });

  it("restarts busy channels when run activity is stale", async () => {
    const now = Date.now();
    const manager = createBusyDisconnectedManager(now - 26 * 60_000);
    await expectRestartedChannel(manager, "discord");
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
    const monitor = await startAndRunCheck(manager, {
      timing: { channelConnectGraceMs: 60_000 },
    });
    expect(manager.stopChannel).not.toHaveBeenCalled();
    expect(manager.startChannel).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("caps an account stuck in pending restart instead of thrashing forever", async () => {
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
    const monitor = startDefaultMonitor(manager, {
      checkIntervalMs: 1_000,
      cooldownCycles: 1,
      maxRestartsPerHour: 3,
    });
    for (let check = 0; check < 20; check += 1) {
      await clock.advanceBy(1_000);
    }
    // Budgeted restart, one free continuation, then two more budgeted restarts
    // before the hourly cap closes; a stuck account must not restart per check.
    expect(manager.startChannel).toHaveBeenCalledTimes(4);
    for (let check = 0; check < 10; check += 1) {
      await clock.advanceBy(1_000);
    }
    expect(manager.startChannel).toHaveBeenCalledTimes(4);
    monitor.stop();
  });

  it("runs the free continuation even when the hourly budget is exhausted", async () => {
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
    // The budgeted restart consumes the only hourly slot; the continuation that
    // finishes that same recovery must still run.
    const monitor = await startAndRunCheck(manager, { maxRestartsPerHour: 1 });
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
    const monitor = await startAndRunCheck(manager, { cooldownCycles: 10 });
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
    expect(manager.startChannel).toHaveBeenCalledTimes(2);
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
    // Long cooldown proves later continuations run on the free pass, not on an
    // expired cooldown window.
    const monitor = await startAndRunCheck(manager, { cooldownCycles: 10 });
    expect(manager.startChannel).toHaveBeenCalledTimes(1);

    startBehavior = "healthy";
    await advanceHealthCheck();
    expect(manager.startChannel).toHaveBeenCalledTimes(2);

    // Healthy pass clears the used continuation.
    await advanceHealthCheck();
    expect(manager.startChannel).toHaveBeenCalledTimes(2);

    // A new timed-out recovery marks pending again; its continuation must not
    // wait behind the still-active cooldown.
    account.running = false;
    account.connected = false;
    account.restartPending = true;
    account.reconnectAttempts = 0;
    await advanceHealthCheck();
    expect(manager.startChannel).toHaveBeenCalledTimes(3);
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
    expect(manager.startChannel).toHaveBeenCalledWith("whatsapp", "default");
    monitor.stop();
  });

  it("counts failed restart attempts toward cooldown and hourly caps", async () => {
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
    const monitor = startDefaultMonitor(manager, {
      checkIntervalMs: 1_000,
      cooldownCycles: 1,
      maxRestartsPerHour: 1,
    });

    for (let check = 0; check < 6; check += 1) {
      await clock.advanceBy(1_000);
    }

    expect(manager.startChannel).toHaveBeenCalledTimes(1);
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
    const monitor = startDefaultMonitor(manager, { checkIntervalMs: 100, cooldownCycles: 0 });
    const check = clock.advanceBy(120);
    try {
      expect(manager.startChannel).toHaveBeenCalledTimes(1);
      await clock.advanceBy(500);
      expect(manager.startChannel).toHaveBeenCalledTimes(1);
    } finally {
      releaseStart();
      monitor.stop();
      await check;
    }
  });

  it("does not resume an in-flight restart after abort signal", async () => {
    const { promise: stopGate, resolve: releaseStop } = createDeferred();
    const abort = new AbortController();
    const manager = createSlackSnapshotManager(disconnectedAccount(Date.now() - 300_000), {
      stopChannel: vi.fn(async () => {
        await stopGate;
      }),
    });
    const monitor = startDefaultMonitor(manager, {
      abortSignal: abort.signal,
      checkIntervalMs: 100,
      cooldownCycles: 0,
    });

    const check = clock.advanceBy(101);
    try {
      expect(manager.stopChannel).toHaveBeenCalledTimes(1);

      abort.abort();
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
    const monitor = startDefaultMonitor(manager, { checkIntervalMs: 100, cooldownCycles: 0 });

    const check = clock.advanceBy(101);
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
    const monitor = startDefaultMonitor(manager, { checkIntervalMs: 100, cooldownCycles: 0 });

    const check = clock.advanceBy(101);
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
    const monitor = startDefaultMonitor(manager, { checkIntervalMs: 100, cooldownCycles: 0 });

    const check = clock.advanceBy(101);
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

    it("respects custom staleEventThresholdMs", async () => {
      const customThreshold = 10 * 60_000;
      const now = Date.now();
      const manager = createSlackSnapshotManager(
        runningConnectedSlackAccount({
          lastStartAt: now - customThreshold - 60_000,
          lastTransportActivityAt: now - customThreshold - 30_000,
        }),
      );
      const monitor = await startAndRunCheck(manager, {
        timing: { staleEventThresholdMs: customThreshold },
      });
      expect(manager.stopChannel).toHaveBeenCalledWith("slack", "default", { manual: false });
      expect(manager.startChannel).toHaveBeenCalledWith("slack", "default");
      monitor.stop();
    });
  });
});
