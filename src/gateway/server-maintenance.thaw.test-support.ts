import { vi } from "vitest";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { startChannelHealthMonitor } from "./channel-health-monitor.js";
import {
  createTestChannelManager,
  createTestChannelRegistry,
  createTestPlugin,
  waitForAbort,
} from "./server-channels.test-support.js";
import { startGatewayMaintenanceTimers } from "./server-maintenance.js";

export async function createChannelThawScenario(
  deps: Parameters<typeof startGatewayMaintenanceTimers>[0],
  healthFirst = false,
) {
  vi.spyOn(process, "cpuUsage").mockReturnValue({ user: 0, system: 0 });
  let now = 1_000_000;
  const wallClock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const clock = createGatewaySchedulerClock(now);
  const scheduler = createTestGatewayScheduler({ ...clock.clock, monotonicNow: () => now });
  const starts: string[] = [];
  const stops: string[] = [];
  const signals = new Map<string, AbortSignal>();
  const failedStops = new Set<string>();
  const state = { busy: true };
  const plugin = createTestPlugin({
    listAccountIds: () => ["first", "second"],
    startAccount: async ({ accountId, abortSignal, setStatus }) => {
      starts.push(accountId);
      signals.set(accountId, abortSignal);
      setStatus({
        accountId,
        connected: accountId !== "first" || starts.filter((id) => id === accountId).length > 1,
        lastTransportActivityAt: now,
      });
      await waitForAbort(abortSignal);
    },
    stopAccount: async ({ accountId }) => {
      stops.push(accountId);
      if (failedStops.has(accountId)) {
        throw new Error("stop failed");
      }
    },
  });
  const registry = createTestChannelRegistry(plugin);
  const manager = createTestChannelManager({ scheduler, getPluginRegistry: () => registry });
  await manager.startChannels();
  const monitor = healthFirst
    ? startChannelHealthMonitor({ scheduler, channelManager: manager })
    : undefined;
  if (healthFirst) {
    // Make the health sweep the oldest due job when the shared scheduler wakes.
    now += 60_000;
    clock.setTime(now);
  }
  const timers = startGatewayMaintenanceTimers({
    ...deps,
    scheduler,
    channelManager: manager,
    isNixMode: true,
    activeWorkInspectors: { getChatRuns: () => (state.busy ? 1 : 0) },
  });
  return {
    manager,
    starts,
    stops,
    signals,
    failedStops,
    state,
    wallClock,
    advance: async (gap: number) => {
      now += gap;
      clock.setTime(now);
      await clock.wake();
    },
    stop: async () => {
      failedStops.clear();
      monitor?.shutdown();
      await timers.stopPeriodicTasks();
      await timers.skillUsageCleanup();
      await manager.stopChannel("discord");
      await scheduler.stop();
    },
  };
}
