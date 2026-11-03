import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ChannelGatewayContextV2 } from "../channels/plugins/types.adapters.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
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
  type TestAccount,
} from "./server-channels.test-support.js";

describe("health monitor account admission", () => {
  beforeEach(() => resetGatewayWorkAdmission());
  afterEach(() => {
    vi.restoreAllMocks();
    resetGatewayWorkAdmission();
  });

  it.each([
    "replacement ready",
    "same lifetime ready",
    "still unhealthy",
    "reconnect grace expires",
    "reload paused",
    "global suppression",
    "ambient suppression",
    "manually stopped",
    "unlisted",
  ] as const)("refreshes later-account admission after an earlier stop: %s", async (change) => {
    const clock = createGatewaySchedulerClock(Date.now());
    const scheduler = createTestGatewayScheduler(clock.clock);
    vi.spyOn(Date, "now").mockImplementation(clock.clock.now);
    const entered = createDeferred();
    const release = createDeferred();
    const contexts = new Map<string, ChannelGatewayContextV2<TestAccount>>();
    const starts: string[] = [];
    const stops: string[] = [];
    let listed = ["first", "second"];
    const plugin = createTestPlugin({
      listAccountIds: () => listed,
      startAccount: async (context) => {
        contexts.set(context.accountId, context);
        starts.push(context.accountId);
        context.setStatus({
          accountId: context.accountId,
          lifecycle: "ready",
          connected: false,
          lastStartAt: Date.now() - 300_000,
          ...(change === "reconnect grace expires" && context.accountId === "second"
            ? { lastDisconnect: { at: Date.now() } }
            : {}),
        });
        await waitForAbort(context.abortSignal);
      },
      stopAccount: async ({ accountId }) => {
        stops.push(accountId);
        if (accountId === "first") {
          entered.resolve();
          await release.promise;
        }
      },
    });
    const registry = createTestChannelRegistry(plugin);
    const manager = createTestChannelManager({ scheduler, getPluginRegistry: () => registry });
    const reset = vi.spyOn(manager, "resetRestartAttempts");
    let resumeReload: ReturnType<typeof manager.pauseChannelStarts> | undefined;
    await manager.startChannels();
    starts.length = 0;
    const monitor = startChannelHealthMonitor({ scheduler, channelManager: manager });
    const check = clock.advanceBy(60_001);
    try {
      await entered.promise;
      expect(stops).toEqual(["first"]);
      const oldSecond = contexts.get("second")!;
      if (change === "replacement ready") {
        await manager.stopChannel("discord", "second", { manual: false });
        await manager.startChannel("discord", "second");
      }
      if (change === "replacement ready" || change === "same lifetime ready") {
        contexts.get("second")!.setStatus({ accountId: "second", connected: true });
      } else if (change === "reconnect grace expires") {
        clock.setTime(Date.now() + 120_000);
      } else if (change === "reload paused") {
        resumeReload = manager.pauseChannelStarts(["discord"]);
      } else if (change === "global suppression") {
        manager.setAutostartSuppression({ reason: "crash-loop-breaker", message: "safe mode" });
      } else if (change === "ambient suppression") {
        manager.setAmbientAutostartSuppressedChannelIds(new Set(["discord"]));
      } else if (change === "manually stopped") {
        await manager.stopChannel("discord", "second");
      } else if (change === "unlisted") {
        listed = ["first"];
      }
      const stopsBeforeRelease = stops.length;
      const startsBeforeRelease = starts.length;
      const second = contexts.get("second")!;
      release.resolve();
      await check;
      const shouldRestart = change === "still unhealthy" || change === "reconnect grace expires";
      expect(stops.slice(stopsBeforeRelease)).toEqual(shouldRestart ? ["second"] : []);
      expect(starts.slice(startsBeforeRelease).filter((id) => id === "second")).toEqual(
        shouldRestart ? ["second"] : [],
      );
      expect(reset.mock.calls.filter(([, id]) => id === "second")).toEqual(
        shouldRestart ? [["discord", "second"]] : [],
      );
      if (change === "replacement ready" || change === "same lifetime ready") {
        expect(second.abortSignal.aborted).toBe(false);
        expect(second === oldSecond).toBe(change === "same lifetime ready");
      }
    } finally {
      release.resolve();
      monitor.shutdown();
      await check;
      resumeReload?.("rollback");
      await manager.stopChannel("discord");
      await scheduler.stop();
    }
  });

  it("resets before failed start preparation after the captured stop", async () => {
    const clock = createGatewaySchedulerClock(Date.now());
    const scheduler = createTestGatewayScheduler(clock.clock);
    vi.spyOn(Date, "now").mockImplementation(clock.clock.now);
    const events: string[] = [];
    let failPreparation = false;
    const plugin = createTestPlugin({
      resolveAccount: () => {
        if (failPreparation) {
          events.push("prepare");
          throw new Error("account preparation failed");
        }
        return { enabled: true, configured: true };
      },
      startAccount: async (context) => {
        context.setStatus({
          accountId: context.accountId,
          lifecycle: "ready",
          connected: false,
          lastStartAt: Date.now() - 300_000,
        });
        await waitForAbort(context.abortSignal);
      },
      stopAccount: async () => {
        events.push("stop");
        failPreparation = true;
      },
    });
    const registry = createTestChannelRegistry(plugin);
    const manager = createTestChannelManager({ scheduler, getPluginRegistry: () => registry });
    const reset = manager.resetRestartAttempts;
    vi.spyOn(manager, "resetRestartAttempts").mockImplementation((...args) => {
      events.push("reset");
      reset(...args);
    });
    await manager.startChannels();
    const monitor = startChannelHealthMonitor({ scheduler, channelManager: manager });
    try {
      await clock.advanceBy(60_001);
      expect(events.slice(0, 3)).toEqual(["stop", "reset", "prepare"]);
    } finally {
      failPreparation = false;
      monitor.shutdown();
      await manager.stopChannel("discord");
      await scheduler.stop();
    }
  });

  it.each(["replacement", "manual stop", "unlisted"] as const)(
    "preserves the attempt budget when %s overtakes captured recovery",
    async (change) => {
      const scheduler = createTestGatewayScheduler();
      let listed = ["default"];
      const plugin = createTestPlugin({
        listAccountIds: () => listed,
        startAccount: ({ abortSignal }) => waitForAbort(abortSignal),
      });
      const registry = createTestChannelRegistry(plugin);
      const manager = createTestChannelManager({ scheduler, getPluginRegistry: () => registry });
      await manager.startChannels();
      const restart = manager.captureAccountRestart("discord", "default", "health-monitor", {
        resetRestartAttempts: true,
      })!;
      const reset = vi.spyOn(manager, "resetRestartAttempts");
      const stop = manager.stopChannel;
      const interceptedStop = vi
        .spyOn(manager, "stopChannel")
        .mockImplementation(async (...args) => {
          await stop(...args);
          if (change === "replacement") {
            await manager.startChannel("discord", "default");
          } else if (change === "manual stop") {
            await stop("discord", "default");
          } else {
            listed = [];
          }
        });
      try {
        expect(await restart(() => true)).toBe(true);
        expect(reset).not.toHaveBeenCalled();
      } finally {
        interceptedStop.mockRestore();
        await manager.stopChannel("discord");
        await scheduler.stop();
      }
    },
  );
});
