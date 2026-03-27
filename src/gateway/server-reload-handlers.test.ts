import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __testing as restartTesting } from "../infra/restart.js";

const hoisted = vi.hoisted(() => {
  const countsState = {
    current: {
      queueSize: 0,
      pendingReplies: 0,
      embeddedRuns: 0,
      acpActiveTurns: 0,
      acpQueueDepth: 0,
      acpTurns: 0,
      totalActive: 0,
    },
  };

  const formatDetails = (counts: typeof countsState.current) => {
    const details: string[] = [];
    if (counts.queueSize > 0) {
      details.push(`${counts.queueSize} operation(s)`);
    }
    if (counts.pendingReplies > 0) {
      details.push(`${counts.pendingReplies} reply(ies)`);
    }
    if (counts.embeddedRuns > 0) {
      details.push(`${counts.embeddedRuns} embedded run(s)`);
    }
    if (counts.acpTurns > 0) {
      details.push(`${counts.acpTurns} ACP turn(s)`);
    }
    return details;
  };

  return {
    countsState,
    getGatewayRestartDeferralCountsMock: vi.fn(() => countsState.current),
    formatGatewayRestartDeferralDetailsMock: vi.fn((counts: typeof countsState.current) =>
      formatDetails(counts),
    ),
  };
});

vi.mock("./restart-deferral.js", () => ({
  getGatewayRestartDeferralCounts: hoisted.getGatewayRestartDeferralCountsMock,
  formatGatewayRestartDeferralDetails: hoisted.formatGatewayRestartDeferralDetailsMock,
}));

const { createGatewayReloadHandlers } = await import("./server-reload-handlers.js");

function createHandlers(logReload: Parameters<typeof createGatewayReloadHandlers>[0]["logReload"]) {
  return createGatewayReloadHandlers({
    deps: {} as never,
    broadcast: () => {},
    getState: () =>
      ({
        hooksConfig: {},
        hookClientIpConfig: {},
        heartbeatRunner: { updateConfig: () => {} },
        cronState: { cron: { stop: () => {} } },
        channelHealthMonitor: null,
      }) as never,
    setState: () => {},
    startChannel: async () => {},
    stopChannel: async () => {},
    logHooks: { info: () => {}, warn: () => {}, error: () => {} },
    logChannels: { info: () => {}, error: () => {} },
    logCron: { error: () => {} },
    logReload,
    createHealthMonitor: () => null as never,
  });
}

describe("gateway reload restart deferral", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    restartTesting.resetSigusr1State();
    hoisted.countsState.current = {
      queueSize: 0,
      pendingReplies: 0,
      embeddedRuns: 0,
      acpActiveTurns: 0,
      acpQueueDepth: 0,
      acpTurns: 0,
      totalActive: 0,
    };
  });

  afterEach(() => {
    restartTesting.resetSigusr1State();
    vi.useRealTimers();
  });

  it("defers config-triggered restart while ACP turns are still active", async () => {
    hoisted.countsState.current = {
      queueSize: 0,
      pendingReplies: 0,
      embeddedRuns: 0,
      acpActiveTurns: 1,
      acpQueueDepth: 1,
      acpTurns: 1,
      totalActive: 1,
    };
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const handlers = createHandlers(logReload);
    const signalSpy = vi.fn();
    const handler = () => signalSpy();
    process.once("SIGUSR1", handler);

    handlers.requestGatewayRestart(
      {
        changedPaths: ["gateway.port"],
        restartGateway: true,
        restartReasons: ["gateway.port"],
        hotReasons: [],
        reloadHooks: false,
        restartGmailWatcher: false,
        restartCron: false,
        restartHeartbeat: false,
        restartHealthMonitor: false,
        restartChannels: new Set(),
        noopPaths: [],
      },
      {},
    );

    expect(signalSpy).not.toHaveBeenCalled();
    expect(logReload.warn).toHaveBeenCalledWith(
      expect.stringContaining("deferring until 1 ACP turn(s) complete"),
    );

    hoisted.countsState.current = {
      queueSize: 0,
      pendingReplies: 0,
      embeddedRuns: 0,
      acpActiveTurns: 0,
      acpQueueDepth: 0,
      acpTurns: 0,
      totalActive: 0,
    };

    await vi.advanceTimersByTimeAsync(500);

    expect(signalSpy).toHaveBeenCalledTimes(1);
    expect(logReload.info).toHaveBeenCalledWith(
      "all active work completed; restarting gateway now",
    );
  });
});
