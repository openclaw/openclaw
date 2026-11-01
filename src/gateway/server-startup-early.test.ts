import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
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
  refreshSkillsDiscovery: vi.fn(),
  registerSkillsChangeListener: vi.fn(),
  closeSkillsWatchers: vi.fn(),
  detachSkillsWatchers: vi.fn(),
  startCronMaintenance: vi.fn(),
  skillsChangeUnsub: vi.fn(),
  startGatewayMaintenanceTimers: vi.fn(() => ({})),
}));

vi.mock("./server-maintenance.js", () => ({
  startGatewayMaintenanceTimers: mocks.startGatewayMaintenanceTimers,
}));

// mock-isolation: Startup uses a fixed machine name without reading host identity.
vi.mock("../infra/machine-name.js", () => ({ getMachineDisplayName: mocks.getMachineDisplayName }));

vi.mock("./server-discovery-runtime.js", () => ({
  startGatewayDiscovery: mocks.startGatewayDiscovery,
}));

vi.mock("../skills/runtime/remote.js", () => ({
  setSkillsRemoteRegistry: mocks.setSkillsRemoteRegistry,
  primeRemoteSkillsCache: mocks.primeRemoteSkillsCache,
  refreshRemoteBinsForConnectedNodes: mocks.refreshRemoteBinsForConnectedNodes,
}));

// mock-isolation: Startup owns discovery ordering; real worker publication is covered by discovery.integration.test.ts.
vi.mock("../skills/runtime/refresh.js", () => ({
  refreshSkillsDiscovery: mocks.refreshSkillsDiscovery,
  registerSkillsChangeListener: mocks.registerSkillsChangeListener,
  closeSkillsWatchers: mocks.closeSkillsWatchers,
  detachSkillsWatchers: mocks.detachSkillsWatchers,
}));

// mock-isolation: Startup tests observe scheduling without starting real cron maintenance.
vi.mock("../cron/maintenance.js", () => ({ startCronMaintenance: mocks.startCronMaintenance }));

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
    maintenance: maintenanceState,
    broadcast: maintenanceState.broadcast,
    scheduler,
    getCronStorePath: () => "/synthetic/cron/jobs.json",
    getRuntimeConfig: () => ({}) as never,
    ...overrides,
  };
}

async function startRuntime(overrides: Partial<StartGatewayEarlyRuntimeInput> = {}) {
  const runtime = await startGatewayEarlyRuntime(
    earlyRuntimeInput({ minimalTestGateway: false, ...overrides }),
  );
  onTestFinished(() => runtime.skillsChangeUnsub());
  return runtime;
}

async function startSkillEvents(overrides: Partial<StartGatewayEarlyRuntimeInput> = {}) {
  const time = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(time.clock);
  const broadcast = vi.fn();
  const warn = vi.fn();
  await startRuntime({ scheduler, broadcast, log: { ...log, warn }, ...overrides });
  return {
    time,
    scheduler,
    broadcast,
    warn,
    listener: mocks.registerSkillsChangeListener.mock.lastCall![0],
  };
}

describe("startGatewayEarlyRuntime", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.getMachineDisplayName.mockResolvedValue("Test Machine");
    mocks.startGatewayDiscovery.mockResolvedValue({ update: async () => {}, stop: async () => {} });
    mocks.refreshSkillsDiscovery.mockResolvedValue(undefined);
    mocks.registerSkillsChangeListener.mockReturnValue(mocks.skillsChangeUnsub);
    mocks.startGatewayMaintenanceTimers.mockReturnValue({});
  });

  it.each([
    { minimalTestGateway: true, updateCanary: false },
    { minimalTestGateway: false, updateCanary: true },
  ])("skips side runtimes for $minimalTestGateway minimal / $updateCanary canary", async (mode) => {
    const earlyRuntime = await startRuntime(mode);

    expect(mocks.startGatewayDiscovery).not.toHaveBeenCalled();
    expect(mocks.setSkillsRemoteRegistry).not.toHaveBeenCalled();
    expect(mocks.primeRemoteSkillsCache).not.toHaveBeenCalled();
    expect(mocks.startCronMaintenance).not.toHaveBeenCalled();
    expect(mocks.registerSkillsChangeListener).not.toHaveBeenCalled();
    expect(mocks.refreshSkillsDiscovery).not.toHaveBeenCalled();
    expect(await earlyRuntime.startMaintenance({})).toBeNull();
    expect(mocks.startGatewayMaintenanceTimers).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "starts maintenance only while its Gateway is open (closesDuringImport=%s)",
    async (closesDuringImport) => {
      let closing = false;
      const earlyRuntime = await startRuntime({ isClosing: () => closing });
      const starting = earlyRuntime.startMaintenance({});
      closing = closesDuringImport;
      const maintenance = await starting;

      expect(mocks.startGatewayMaintenanceTimers).toHaveBeenCalledTimes(closesDuringImport ? 0 : 1);
      expect(mocks.refreshSkillsDiscovery).toHaveBeenCalledTimes(closesDuringImport ? 0 : 1);
      if (closesDuringImport) {
        expect(maintenance).toBeNull();
      } else {
        expect(maintenance).toBe(mocks.startGatewayMaintenanceTimers.mock.results[0]?.value);
      }
    },
  );

  it("registers skills changes before readiness and joins discovery during maintenance", async () => {
    const config = { skills: { load: { watch: false } } };
    const scanStarted = createDeferredCore();
    const scanFinished = createDeferredCore();
    mocks.refreshSkillsDiscovery.mockImplementationOnce(async () => {
      scanStarted.resolve();
      await scanFinished.promise;
    });

    const earlyRuntime = await startRuntime({ getRuntimeConfig: () => config });
    expect(mocks.refreshSkillsDiscovery).not.toHaveBeenCalled();
    expect(mocks.registerSkillsChangeListener).toHaveBeenCalledOnce();
    const starting = earlyRuntime.startMaintenance({});
    await scanStarted.promise;
    expect(mocks.startGatewayMaintenanceTimers).not.toHaveBeenCalled();
    scanFinished.resolve();
    await starting;

    expect(mocks.refreshSkillsDiscovery).toHaveBeenCalledExactlyOnceWith({ config });
    expect(mocks.startGatewayDiscovery.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
      mocks.setSkillsRemoteRegistry.mock.invocationCallOrder[0] ?? -Infinity,
    );

    await earlyRuntime.skillsChangeUnsub();
    expect(mocks.skillsChangeUnsub).toHaveBeenCalledTimes(1);
    expect(mocks.closeSkillsWatchers).toHaveBeenCalledTimes(1);
    expect(mocks.detachSkillsWatchers).not.toHaveBeenCalled();
  });

  it("continues startup with a warning after an initial skills scan fails", async () => {
    mocks.refreshSkillsDiscovery.mockRejectedValueOnce(new Error("skills scan failed"));
    const warn = vi.fn();
    const earlyRuntime = await startRuntime({ log: { ...log, warn } });
    await earlyRuntime.startMaintenance({});
    expect(warn).toHaveBeenCalledWith(
      "failed to refresh skills during startup: Error: skills scan failed",
    );
    await earlyRuntime.skillsChangeUnsub();
    expect(mocks.closeSkillsWatchers).toHaveBeenCalledOnce();
  });

  it("publishes acquired discovery before a later startup failure", async () => {
    const startupError = new Error("remote skills registry failed");
    const discovery = { update: async () => {}, stop: vi.fn() };
    const swapDiscovery = vi.fn(() => null);
    mocks.startGatewayDiscovery.mockResolvedValueOnce(discovery);
    mocks.setSkillsRemoteRegistry.mockImplementationOnce(() => {
      expect(swapDiscovery).toHaveBeenCalledExactlyOnceWith(discovery);
      throw startupError;
    });
    await expect(
      startGatewayEarlyRuntime(earlyRuntimeInput({ minimalTestGateway: false, swapDiscovery })),
    ).rejects.toBe(startupError);
  });

  it.each(["remote-node", "watch-available"] as const)(
    "handles %s without probing remote bins",
    async (reason) => {
      const { time, broadcast, listener } = await startSkillEvents();
      listener({ reason });
      await time.advanceBy(30_000);
      expect(mocks.refreshRemoteBinsForConnectedNodes).not.toHaveBeenCalled();
      if (reason === "remote-node") {
        expect(broadcast).toHaveBeenCalledWith("skills.changed", { reason });
      } else {
        expect(broadcast).not.toHaveBeenCalled();
      }
    },
  );

  it.each([false, true])(
    "broadcasts local skill changes immediately while coalescing remote-bin refresh (fails: %s)",
    async (fails) => {
      const refresh = createDeferredCore();
      mocks.refreshRemoteBinsForConnectedNodes.mockReturnValueOnce(refresh.promise);
      let config = { cron: { enabled: false } };
      const { time, broadcast, warn, listener } = await startSkillEvents({
        getRuntimeConfig: () => config,
      });
      try {
        listener({ reason: "watch" });
        expect(broadcast).toHaveBeenCalledExactlyOnceWith("skills.changed", { reason: "watch" });
        await time.advanceBy(15_000);
        listener({ reason: "config-change" });
        expect(broadcast).toHaveBeenLastCalledWith("skills.changed", { reason: "config-change" });
        config = { cron: { enabled: true } };
        await time.advanceBy(15_000);
        expect(mocks.refreshRemoteBinsForConnectedNodes).not.toHaveBeenCalled();

        const running = time.advanceBy(15_000);
        expect(mocks.refreshRemoteBinsForConnectedNodes).toHaveBeenCalledExactlyOnceWith(config);
        expect(broadcast).toHaveBeenCalledTimes(2);

        if (fails) {
          refresh.reject(new Error("probe failed"));
        } else {
          refresh.resolve();
        }
        await running;
        expect(broadcast).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledTimes(fails ? 1 : 0);
      } finally {
        refresh.resolve();
      }
    },
  );

  it.each([false, true])(
    "cancels pending refreshes and joins started refreshes at shutdown (started: %s)",
    async (started) => {
      const refresh = createDeferredCore();
      mocks.refreshRemoteBinsForConnectedNodes.mockReturnValueOnce(refresh.promise);
      let closing = false;
      const { time, scheduler, broadcast, listener } = await startSkillEvents({
        isClosing: () => closing,
      });
      try {
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
        expect(broadcast).toHaveBeenCalledExactlyOnceWith("skills.changed", { reason: "watch" });
      } finally {
        refresh.resolve();
      }
    },
  );

  it("starts discovery with the current plugin registry services", async () => {
    const service = {
      pluginId: "bonjour",
      service: { id: "bonjour", advertise: vi.fn() },
    };

    await startRuntime({
      gatewayTls: { enabled: true, fingerprintSha256: "abc123" },
      pluginRegistry: {
        gatewayDiscoveryServices: [service],
      } as never,
    });
    expect(mocks.startGatewayDiscovery).toHaveBeenLastCalledWith(
      expect.objectContaining({
        gatewayTls: { enabled: true, fingerprintSha256: "abc123" },
        gatewayDiscoveryServices: [service],
      }),
    );
  });
});
