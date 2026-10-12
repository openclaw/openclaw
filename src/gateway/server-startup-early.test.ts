/**
 * Early gateway startup helper tests.
 */
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { createGatewayPluginRuntimeGeneration } from "./server-plugin-runtime-generation.js";
import { runGatewayCloseSteps } from "./server-shutdown.js";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";

type StartGatewayDiscovery = typeof import("./server-discovery-runtime.js").startGatewayDiscovery;

const mocks = vi.hoisted(() => ({
  getMachineDisplayName: vi.fn(async () => "Test Machine"),
  startGatewayDiscovery: vi.fn<StartGatewayDiscovery>(async () => ({
    update: async () => {},
    stop: async () => {},
  })),
  setSkillsRemoteRegistry: vi.fn(),
  primeRemoteSkillsCache: vi.fn(),
  refreshRemoteBinsForConnectedNodes: vi.fn(),
  registerSkillsChangeListener: vi.fn(),
  closeSkillsWatchers: vi.fn(),
  detachSkillsWatchers: vi.fn(),
  startCronMaintenance: vi.fn(),
  skillsChangeUnsub: vi.fn(),
  ensureContextWindowCacheLoaded: vi.fn(),
  startGatewayMaintenanceTimers: vi.fn(() => ({
    startMediaCleanup: vi.fn(),
    stopMediaCleanup: vi.fn(async () => "drained" as const),
    stopPeriodicTasks: vi.fn(async () => {}),
    skillUsageCleanup: vi.fn(async () => {}),
  })),
}));

vi.mock("./server-maintenance.js", () => ({
  startGatewayMaintenanceTimers: mocks.startGatewayMaintenanceTimers,
}));

vi.mock("../infra/machine-name.js", () => ({
  getMachineDisplayName: mocks.getMachineDisplayName,
}));

vi.mock("./server-discovery-runtime.js", () => ({
  startGatewayDiscovery: mocks.startGatewayDiscovery,
}));

vi.mock("../skills/runtime/remote.js", () => ({
  setSkillsRemoteRegistry: mocks.setSkillsRemoteRegistry,
  primeRemoteSkillsCache: mocks.primeRemoteSkillsCache,
  refreshRemoteBinsForConnectedNodes: mocks.refreshRemoteBinsForConnectedNodes,
}));

// mock-isolation: Real watcher lifecycle is covered in server-startup-early.skills-watchers.test.ts.
vi.mock("../skills/runtime/refresh.js", () => ({
  registerSkillsChangeListener: mocks.registerSkillsChangeListener,
  closeSkillsWatchers: mocks.closeSkillsWatchers,
  detachSkillsWatchers: mocks.detachSkillsWatchers,
}));

vi.mock("../cron/maintenance.js", () => ({
  startCronMaintenance: mocks.startCronMaintenance,
}));

vi.mock("../agents/context.js", () => ({
  ensureContextWindowCacheLoaded: mocks.ensureContextWindowCacheLoaded,
}));

import { startGatewayEarlyRuntime } from "./server-startup-early.js";

type StartGatewayEarlyRuntimeInput = Parameters<typeof startGatewayEarlyRuntime>[0];

const log = {
  info: () => {},
  warn: () => {},
};

function earlyRuntimeInput(
  overrides: Partial<StartGatewayEarlyRuntimeInput> = {},
): StartGatewayEarlyRuntimeInput {
  const { runDeliveryQueueMediaGc: _runDeliveryQueueMediaGc, ...maintenanceState } =
    createGatewayMaintenanceStateForTest({
      healthSummary: {} as never,
      healthVersion: 0,
      presenceVersion: 0,
    });
  const scheduler = overrides.scheduler ?? createTestGatewayScheduler();
  onTestFinished(() => scheduler.stop());
  return {
    minimalTestGateway: true,
    isClosing: () => false,
    cfgAtStart: {} as never,
    port: 18_789,
    gatewayTls: { enabled: false },
    gatewayDirectReachable: false,
    tailscaleMode: "off" as never,
    log,
    logDiscovery: log,
    nodeRegistry: {} as never,
    swapDiscovery: () => null,
    pluginRuntimeClaim: createGatewayPluginRuntimeGeneration({
      getServices: () => null,
      setServices: () => {},
    }).currentClaim(),
    maintenance: maintenanceState,
    broadcast: maintenanceState.broadcast,
    scheduler,
    getRuntimeConfig: () => ({}) as never,
    ...overrides,
  };
}

describe("startGatewayEarlyRuntime", () => {
  beforeEach(() => {
    mocks.getMachineDisplayName.mockClear();
    mocks.startGatewayDiscovery.mockClear();
    mocks.startGatewayDiscovery.mockResolvedValue({ update: async () => {}, stop: async () => {} });
    mocks.setSkillsRemoteRegistry.mockReset();
    mocks.primeRemoteSkillsCache.mockReset();
    mocks.refreshRemoteBinsForConnectedNodes.mockReset();
    mocks.registerSkillsChangeListener.mockReset();
    mocks.closeSkillsWatchers.mockReset();
    mocks.detachSkillsWatchers.mockReset();
    mocks.startCronMaintenance.mockReset();
    mocks.registerSkillsChangeListener.mockReturnValue(mocks.skillsChangeUnsub);
    mocks.skillsChangeUnsub.mockReset();
    mocks.ensureContextWindowCacheLoaded.mockReset();
    mocks.ensureContextWindowCacheLoaded.mockResolvedValue(undefined);
    mocks.startGatewayMaintenanceTimers.mockClear();
  });

  it.each([
    { minimalTestGateway: true, updateCanary: false },
    { minimalTestGateway: false, updateCanary: true },
  ])("skips side runtimes for $minimalTestGateway minimal / $updateCanary canary", async (mode) => {
    const earlyRuntime = await startGatewayEarlyRuntime(earlyRuntimeInput(mode));

    expect(earlyRuntime).not.toHaveProperty("mcpServer");
    expect(mocks.startGatewayDiscovery).not.toHaveBeenCalled();
    expect(mocks.setSkillsRemoteRegistry).not.toHaveBeenCalled();
    expect(mocks.primeRemoteSkillsCache).not.toHaveBeenCalled();
    expect(mocks.startCronMaintenance).not.toHaveBeenCalled();
    expect(mocks.registerSkillsChangeListener).not.toHaveBeenCalled();
    expect(await earlyRuntime.startMaintenance({})).toBeNull();
    expect(mocks.startGatewayMaintenanceTimers).not.toHaveBeenCalled();
    await earlyRuntime.skillsChangeUnsub();
  });

  it.each([false, true])(
    "starts maintenance only while its Gateway is open (closesDuringImport=%s)",
    async (closesDuringImport) => {
      let closing = false;
      const earlyRuntime = await startGatewayEarlyRuntime(
        earlyRuntimeInput({ minimalTestGateway: false, isClosing: () => closing }),
      );
      try {
        const starting = earlyRuntime.startMaintenance({});
        closing = closesDuringImport;
        const maintenance = await starting;

        expect(mocks.startGatewayMaintenanceTimers).toHaveBeenCalledTimes(
          closesDuringImport ? 0 : 1,
        );
        if (closesDuringImport) {
          expect(maintenance).toBeNull();
        } else {
          expect(maintenance).toBe(mocks.startGatewayMaintenanceTimers.mock.results[0]?.value);
        }
      } finally {
        await earlyRuntime.skillsChangeUnsub();
      }
    },
  );

  it("wires non-minimal skills runtime through lazy startup imports", async () => {
    const nodeRegistry = { node: { id: "node" } };

    const input = earlyRuntimeInput({
      minimalTestGateway: false,
      cfgAtStart: { cron: { enabled: false } },
      nodeRegistry: nodeRegistry as never,
    });
    const earlyRuntime = await startGatewayEarlyRuntime(input);

    expect(mocks.setSkillsRemoteRegistry).toHaveBeenCalledWith(nodeRegistry);
    await Promise.resolve();
    expect(mocks.ensureContextWindowCacheLoaded).not.toHaveBeenCalled();
    expect(mocks.primeRemoteSkillsCache).toHaveBeenCalledTimes(1);
    expect(mocks.startCronMaintenance).toHaveBeenCalledExactlyOnceWith(input.scheduler);
    expect(mocks.startGatewayDiscovery).toHaveBeenCalledOnce();
    expect(mocks.startGatewayDiscovery.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
      mocks.setSkillsRemoteRegistry.mock.invocationCallOrder[0] ?? -Infinity,
    );
    expect(mocks.registerSkillsChangeListener).toHaveBeenCalledTimes(1);

    await earlyRuntime.skillsChangeUnsub();
    expect(mocks.skillsChangeUnsub).toHaveBeenCalledTimes(1);
    expect(mocks.closeSkillsWatchers).toHaveBeenCalledTimes(1);
    expect(mocks.detachSkillsWatchers).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "stops acquired discovery exactly once after later startup failure (cleanup rejects: %s)",
    async (cleanupRejects) => {
      const startupError = new Error("remote skills registry failed");
      const cleanupError = new Error("discovery cleanup failed");
      const stopDiscovery = vi.fn(async () => {
        if (cleanupRejects) {
          throw cleanupError;
        }
      });
      const owner: { current: Awaited<ReturnType<StartGatewayDiscovery>> | null } = {
        current: null,
      };
      const swapDiscovery = (next: typeof owner.current) => {
        const previous = owner.current;
        owner.current = next;
        return previous;
      };
      mocks.startGatewayDiscovery.mockResolvedValueOnce({
        update: async () => {},
        stop: stopDiscovery,
      });
      mocks.setSkillsRemoteRegistry.mockImplementationOnce(() => {
        throw startupError;
      });
      const onCleanupError = vi.fn();

      const startup = startGatewayEarlyRuntime(
        earlyRuntimeInput({ minimalTestGateway: false, swapDiscovery }),
      ).catch(async (error: unknown) => {
        await runGatewayCloseSteps({
          owner: {
            connectionWork: { drain: async () => {} },
            stopConnectionDependentSidecars: () => {},
            stopRegisteredGatewayLifetimeSidecars: async () => await swapDiscovery(null)?.stop(),
            stopRegisteredPostReadySidecars: () => {},
            runClosePrelude: () => {},
            sealAndJoinRegisteredSidecarStops: () => {},
          },
          close: async () => await swapDiscovery(null)?.stop(),
          onError: onCleanupError,
        });
        throw error;
      });

      if (cleanupRejects) {
        await expect(startup).rejects.toMatchObject({
          name: "AggregateError",
          errors: [expect.objectContaining({ cause: cleanupError })],
        });
      } else {
        await expect(startup).rejects.toBe(startupError);
      }
      expect(stopDiscovery).toHaveBeenCalledOnce();
      expect(owner.current).toBeNull();
      expect(onCleanupError).toHaveBeenCalledTimes(cleanupRejects ? 1 : 0);
    },
  );

  it("broadcasts remote-node skill invalidations to operator clients", async () => {
    const broadcast = vi.fn();

    await startGatewayEarlyRuntime(
      earlyRuntimeInput({
        minimalTestGateway: false,
        broadcast,
      }),
    );

    const listener = mocks.registerSkillsChangeListener.mock.calls.at(-1)?.[0] as
      | ((event: { reason: "remote-node" }) => void)
      | undefined;
    expect(listener).toBeDefined();

    listener?.({ reason: "remote-node" });

    expect(broadcast).toHaveBeenCalledWith("skills.changed", { reason: "remote-node" });
    expect(mocks.refreshRemoteBinsForConnectedNodes).not.toHaveBeenCalled();
  });

  it("does not probe remote bins or broadcast for restored watch coverage", async () => {
    const broadcast = vi.fn();
    const time = createGatewaySchedulerClock();
    const earlyRuntime = await startGatewayEarlyRuntime(
      earlyRuntimeInput({
        minimalTestGateway: false,
        broadcast,
        scheduler: createTestGatewayScheduler(time.clock),
      }),
    );
    try {
      const listener = mocks.registerSkillsChangeListener.mock.calls.at(-1)?.[0];
      expect(listener).toEqual(expect.any(Function));
      listener({ reason: "watch-available" });
      await time.advanceBy(30_000);
      expect(mocks.refreshRemoteBinsForConnectedNodes).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();
    } finally {
      await earlyRuntime.skillsChangeUnsub();
    }
  });

  it.each([false, true])(
    "broadcasts the latest coalesced skill change after remote-bin refresh (fails: %s)",
    async (fails) => {
      const time = createGatewaySchedulerClock();
      const broadcast = vi.fn();
      const warn = vi.fn();
      const refresh = createDeferredCore();
      mocks.refreshRemoteBinsForConnectedNodes.mockReturnValueOnce(refresh.promise);
      let config = { cron: { enabled: false } };
      const earlyRuntime = await startGatewayEarlyRuntime(
        earlyRuntimeInput({
          minimalTestGateway: false,
          broadcast,
          log: { ...log, warn },
          scheduler: createTestGatewayScheduler(time.clock),
          getRuntimeConfig: () => config,
        }),
      );
      try {
        const listener = mocks.registerSkillsChangeListener.mock.calls.at(-1)?.[0];
        listener({ reason: "watch" });
        await time.advanceBy(15_000);
        listener({ reason: "config-change" });
        config = { cron: { enabled: true } };
        await time.advanceBy(15_000);
        expect(mocks.refreshRemoteBinsForConnectedNodes).not.toHaveBeenCalled();

        const running = time.advanceBy(15_000);
        expect(mocks.refreshRemoteBinsForConnectedNodes).toHaveBeenCalledExactlyOnceWith(config);
        expect(broadcast).not.toHaveBeenCalled();

        if (fails) {
          refresh.reject(new Error("probe failed"));
        } else {
          refresh.resolve();
        }
        await running;
        expect(broadcast).toHaveBeenCalledExactlyOnceWith("skills.changed", {
          reason: "config-change",
        });
        expect(warn).toHaveBeenCalledTimes(fails ? 1 : 0);
      } finally {
        refresh.resolve();
        await earlyRuntime.skillsChangeUnsub();
      }
    },
  );

  it.each([false, true])(
    "cancels pending refreshes and joins started refreshes at shutdown (started: %s)",
    async (started) => {
      const time = createGatewaySchedulerClock();
      const scheduler = createTestGatewayScheduler(time.clock);
      const broadcast = vi.fn();
      const refresh = createDeferredCore();
      mocks.refreshRemoteBinsForConnectedNodes.mockReturnValueOnce(refresh.promise);
      let closing = false;
      const earlyRuntime = await startGatewayEarlyRuntime(
        earlyRuntimeInput({
          minimalTestGateway: false,
          scheduler,
          broadcast,
          isClosing: () => closing,
        }),
      );
      try {
        const listener = mocks.registerSkillsChangeListener.mock.calls.at(-1)?.[0];
        listener({ reason: "watch" });
        const running = started ? time.advanceBy(30_000) : undefined;
        closing = true;
        scheduler.beginClose();
        let stopped = false;
        const stopping = scheduler.stop().then(() => {
          stopped = true;
        });
        listener({ reason: "remote-node" });
        listener({ reason: "watch" });
        if (started) {
          await Promise.resolve();
          expect(stopped).toBe(false);
        }
        refresh.resolve();
        await running;
        await stopping;
        await time.advanceBy(60_000);
        expect(mocks.refreshRemoteBinsForConnectedNodes).toHaveBeenCalledTimes(started ? 1 : 0);
        expect(broadcast).not.toHaveBeenCalled();
      } finally {
        refresh.resolve();
        await earlyRuntime.skillsChangeUnsub();
      }
    },
  );

  it("starts discovery with the current plugin registry services", async () => {
    const stop = vi.fn(async () => {});
    const discovery = { update: async () => {}, stop };
    mocks.startGatewayDiscovery.mockResolvedValueOnce(discovery);
    const swapDiscovery = vi.fn(() => null);
    const service = {
      pluginId: "bonjour",
      service: { id: "bonjour", advertise: vi.fn() },
    };

    const input = earlyRuntimeInput({
      minimalTestGateway: false,
      swapDiscovery,
      cfgAtStart: { discovery: { mdns: { mode: "full" } } } as never,
      port: 19_001,
      gatewayTls: { enabled: true, fingerprintSha256: "abc123" },
      gatewayDirectReachable: true,
      tailscaleMode: "serve" as never,
      logDiscovery: {
        info: () => {},
        warn: () => {},
      },
      pluginRegistry: {
        gatewayDiscoveryServices: [service],
      } as never,
    });
    await startGatewayEarlyRuntime(input);
    expect(swapDiscovery).toHaveBeenCalledWith(discovery);

    const [discoveryParams] = mocks.startGatewayDiscovery.mock.calls.at(-1) ?? [];
    if (discoveryParams === undefined) {
      throw new Error("Expected gateway discovery to start");
    }
    expect(discoveryParams.machineDisplayName).toBe("Test Machine");
    expect(discoveryParams.port).toBe(19_001);
    expect(discoveryParams.gatewayTls).toEqual({ enabled: true, fingerprintSha256: "abc123" });
    expect(discoveryParams.gatewayDirectReachable).toBe(true);
    expect(discoveryParams.tailscaleMode).toBe("serve");
    expect(discoveryParams.discovery?.mdns?.mode).toBe("full");
    expect(discoveryParams.gatewayDiscoveryServices).toEqual([service]);
    expect(discoveryParams.pluginRuntimeClaim).toBe(input.pluginRuntimeClaim);
  });
});
