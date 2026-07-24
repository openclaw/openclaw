// Real-timer integration coverage for the Gateway channel manager and health monitor.
import { afterEach, describe, expect, it } from "vitest";
import type { ChannelGatewayContext, ChannelPlugin } from "../channels/plugins/types.public.js";
import {
  createSubsystemLogger,
  runtimeForLogger,
  type SubsystemLogger,
} from "../logging/subsystem.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { startChannelHealthMonitor } from "./channel-health-monitor.js";
import { createChannelManager, type ChannelManager } from "./server-channels.js";

type ProbeAccount = {
  enabled: true;
  configured: true;
};

const CHANNEL_ID = "discord";
const STARTUP_GRACE_MS = 80;
const CHECK_INTERVAL_MS = 40;
const RECOVERY_STOP_MS = 120;

const delay = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

async function waitUntil(check: () => boolean, message: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await delay(5);
  }
  if (!check()) {
    throw new Error(message);
  }
}

function createProbePlugin(params: {
  onStart: (ctx: ChannelGatewayContext<ProbeAccount>) => Promise<void>;
}): ChannelPlugin<ProbeAccount> {
  const account: ProbeAccount = { enabled: true, configured: true };
  return {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "Health Monitor Probe",
      selectionLabel: "Health Monitor Probe",
      docsPath: "/channels/health-monitor-probe",
      blurb: "Credential-free channel lifecycle probe.",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [DEFAULT_ACCOUNT_ID],
      resolveAccount: () => account,
      isEnabled: () => true,
      isConfigured: () => true,
      describeAccount: () => ({
        accountId: DEFAULT_ACCOUNT_ID,
        enabled: true,
        configured: true,
      }),
    },
    gateway: { startAccount: params.onStart },
  };
}

describe("channel health monitor real runtime", () => {
  let previousRegistry: PluginRegistry | null = null;

  afterEach(() => {
    setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
    previousRegistry = null;
  });

  it("recovers at startup grace without overlap and stays stopped after shutdown", async () => {
    previousRegistry = getActivePluginRegistry();
    const startTimes: number[] = [];
    const stopTimes: number[] = [];
    let activeRuns = 0;
    let maxActiveRuns = 0;

    const plugin = createProbePlugin({
      onStart: async (ctx) => {
        startTimes.push(Date.now());
        activeRuns += 1;
        maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
        ctx.setStatus({ accountId: DEFAULT_ACCOUNT_ID, connected: false });
        await new Promise<void>((resolve) => {
          if (ctx.abortSignal.aborted) {
            resolve();
            return;
          }
          ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        await delay(RECOVERY_STOP_MS);
        stopTimes.push(Date.now());
        activeRuns -= 1;
      },
    });
    const registry = createEmptyPluginRegistry();
    registry.channels.push({
      pluginId: CHANNEL_ID,
      source: "health-monitor-real-runtime",
      plugin,
    });
    setActivePluginRegistry(registry);

    const log = createSubsystemLogger("gateway/health-monitor-real-runtime");
    const channelLogs = { [CHANNEL_ID]: log } as Record<string, SubsystemLogger>;
    const channelRuntimeEnvs = {
      [CHANNEL_ID]: runtimeForLogger(log),
    } as Record<string, RuntimeEnv>;
    const manager = createChannelManager({
      getRuntimeConfig: () => ({}),
      channelLogs,
      channelRuntimeEnvs,
    });
    await manager.startChannels();
    await waitUntil(() => startTimes.length === 1, "initial channel start did not begin");

    const checkTimes: number[] = [];
    const observedManager: ChannelManager = {
      ...manager,
      getRuntimeSnapshot: () => {
        checkTimes.push(Date.now());
        return manager.getRuntimeSnapshot();
      },
    };
    const monitorStartedAt = Date.now();
    const monitor = startChannelHealthMonitor({
      channelManager: observedManager,
      checkIntervalMs: CHECK_INTERVAL_MS,
      timing: {
        monitorStartupGraceMs: STARTUP_GRACE_MS,
        channelConnectGraceMs: 0,
      },
      cooldownCycles: 0,
    });

    try {
      await delay(Math.floor(STARTUP_GRACE_MS / 2));
      expect(checkTimes).toHaveLength(0);

      await waitUntil(() => checkTimes.length === 1, "grace-boundary health check did not run");
      await delay(Math.floor(RECOVERY_STOP_MS / 2));
      expect(startTimes).toHaveLength(1);
      expect(activeRuns).toBe(1);

      await waitUntil(() => startTimes.length === 2, "health recovery did not restart channel");
      expect(maxActiveRuns).toBe(1);
      expect(stopTimes).toHaveLength(1);
      expect(checkTimes[0]! - monitorStartedAt).toBeGreaterThanOrEqual(STARTUP_GRACE_MS);

      monitor.shutdown();
      await monitor.waitForIdle();
      const checksAtShutdown = checkTimes.length;
      const startsAtShutdown = startTimes.length;
      await delay(CHECK_INTERVAL_MS * 3);

      expect(checkTimes).toHaveLength(checksAtShutdown);
      expect(startTimes).toHaveLength(startsAtShutdown);
      console.info(
        "health-monitor live proof",
        JSON.stringify({
          startupGraceMs: STARTUP_GRACE_MS,
          firstCheckAtMs: checkTimes[0]! - monitorStartedAt,
          recoveryStartedAtMs: startTimes[1]! - monitorStartedAt,
          recoveryStopDurationMs: stopTimes[0]! - checkTimes[0]!,
          maxConcurrentChannelRuns: maxActiveRuns,
          checksAtShutdown,
          checksAfterThreeIntervals: checkTimes.length,
          startsAtShutdown,
          startsAfterThreeIntervals: startTimes.length,
        }),
      );
    } finally {
      monitor.shutdown();
      await monitor.waitForIdle();
      await manager.stopChannel(CHANNEL_ID, DEFAULT_ACCOUNT_ID);
    }
  });
});
