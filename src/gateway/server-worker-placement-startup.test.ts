import { setImmediate as nextTurn } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getWorkerPlacementStartupMocks } from "./server-worker-placement-startup.test-harness.js";

// Install the shared module mocks before any source imports can load the runtime.
const { runtimeFactoryMocks } = getWorkerPlacementStartupMocks();

import { getRuntimeConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { createGatewayStartupTrace } from "./server-startup-trace.js";
import { createGatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";
import {
  createEnvironments,
  createIdleDiskSpace,
  createRuntimeFactory,
  placementStoreDefaults,
  setDispatchMock,
  startRuntime,
} from "./server-worker-placement.test-support.js";
import * as workspaceRetention from "./worker-environments/node-workspace-retain-coordinator.js";
import type { WorkerPlacementDispatchService } from "./worker-environments/placement-dispatch.js";

const createRuntime = createRuntimeFactory(createGatewayWorkerPlacementRuntime, getRuntimeConfig);
function mockDispatch(overrides: Partial<WorkerPlacementDispatchService> = {}) {
  setDispatchMock(runtimeFactoryMocks.createDispatch, overrides);
}

function placementRuntime(
  placement: { sessionId: string; environmentId?: string | null },
  environments: ReturnType<typeof createEnvironments> = createEnvironments(),
  overrides: Partial<ReturnType<typeof placementStoreDefaults>> = {},
) {
  return createRuntime({
    placements: {
      ...placementStoreDefaults(() => [placement]),
      get: () => placement,
      ...overrides,
    } as never,
    environments: environments as never,
  });
}

function startupPlacement(state: "local" | "provisioning" | "active") {
  return {
    sessionId: "session-startup",
    sessionKey: "agent:main:startup",
    agentId: "main",
    state,
    generation: 1,
    environmentId: state === "local" ? null : "worker-startup",
    activeOwnerEpoch: state === "active" ? 1 : null,
    turnClaim: null,
  };
}

beforeEach(() => {
  runtimeFactoryMocks.createDiskSpace.mockReturnValue(createIdleDiskSpace());
});

describe("worker placement startup health lifetime", () => {
  it("admits startup while publication recovery waits and drains that recovery on stop", async () => {
    const publicationStarted = createDeferredCore();
    const releasePublication = createDeferredCore();
    mockDispatch();
    const environments = createEnvironments();
    const runtime = createRuntime({ environments: environments as never });
    vi.spyOn(runtime.githubPublication, "resumeSessionRequests").mockImplementationOnce(
      async () => {
        publicationStarted.resolve();
        await releasePublication.promise;
      },
    );
    let ready = false;
    const starting = startRuntime(runtime).then((sidecar) => {
      ready = true;
      return sidecar;
    });
    try {
      await publicationStarted.promise;
      await nextTurn();
      expect(ready).toBe(true);
      const sidecar = await starting;
      expect(sidecar).not.toBeNull();
      expect(environments.start).toHaveBeenCalledOnce();

      let stopped = false;
      const stopping = sidecar!.stop().then(() => {
        stopped = true;
      });
      await nextTurn();
      expect(stopped).toBe(false);
      expect(environments.stop).not.toHaveBeenCalled();
      releasePublication.resolve();
      await stopping;
      expect(environments.stop).toHaveBeenCalledOnce();
    } finally {
      releasePublication.resolve();
      await (await starting)?.stop();
    }
  });

  it("samples disk on schedule while reconciliation is stuck and drains both on stop", async () => {
    const time = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(time.clock);
    const releaseReconcile = createDeferredCore();
    const releaseScheduledHealth = createDeferredCore();
    const releaseScheduledCleanup = createDeferredCore();
    const retentionStopped = createDeferredCore();
    const reconcileStarted = createDeferredCore();
    const scheduledHealthStarted = createDeferredCore();
    const healthError = new Error("probe transport failed");
    const createRetention = workspaceRetention.createNodeWorkspaceRetainCoordinator;
    const retentionFactory = vi
      .spyOn(workspaceRetention, "createNodeWorkspaceRetainCoordinator")
      .mockImplementationOnce((options) => {
        const retention = createRetention(options);
        return {
          ...retention,
          async stop() {
            await retention.stop();
            retentionStopped.resolve();
          },
        };
      });
    let holdScheduledWork = false;
    const diskSpace = {
      ...createIdleDiskSpace(),
      nextSweepAtMs: () => time.clock.now() + 60_000,
      sweep: vi.fn(async () => {
        if (holdScheduledWork) {
          scheduledHealthStarted.resolve();
          await releaseScheduledHealth.promise;
        }
      }),
    };
    const reconcile = vi.fn().mockResolvedValue(undefined);
    const reconcileActive = vi.fn(async () => {
      if (holdScheduledWork) {
        void trackAsyncWork(() => releaseScheduledCleanup.promise);
        reconcileStarted.resolve();
        await releaseReconcile.promise;
      }
    });
    runtimeFactoryMocks.createDiskSpace.mockReturnValue(diskSpace);
    mockDispatch({ reconcile, reconcileActive });
    const environments = createEnvironments();
    const warn = vi.fn();
    const runtime = createRuntime({
      scheduler,
      environments: environments as never,
      warn,
    });
    const log = createSubsystemLogger("worker-startup-test");
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    const startupTrace = createGatewayStartupTrace(log);
    let sidecar: Awaited<ReturnType<typeof runtime.startRuntime>> | undefined;
    let scheduledWake: void | Promise<void> = undefined;

    try {
      sidecar = await startRuntime(runtime, { startupTrace });
      const completedPhases = info.mock.calls.flatMap(([line]) => {
        const match = /sidecars\.worker-environments\.([\w-]+) [\d.]+ms/.exec(line);
        return match ? [match[1]] : [];
      });
      expect(completedPhases.slice(0, 3)).toEqual(["github-ready", "workspaces", "active"]);
      expect(reconcileActive).not.toHaveBeenCalled();
      expect(diskSpace.sweep).toHaveBeenCalledOnce();
      // Settle the background startup sweep before advancing its next deadline.
      await nextTurn();
      await time.advanceBy(60_000);
      reconcileActive.mockClear();
      diskSpace.sweep.mockClear();
      holdScheduledWork = true;
      scheduledWake = time.advanceBy(180_000);
      await Promise.all([reconcileStarted.promise, scheduledHealthStarted.promise]);
      expect(reconcileActive).toHaveBeenCalledOnce();
      expect(diskSpace.sweep).toHaveBeenCalledOnce();

      let stopSettled = false;
      const stopping = sidecar!.stop().then(() => {
        stopSettled = true;
      });
      releaseScheduledHealth.reject(healthError);
      await Promise.resolve();
      expect(stopSettled).toBe(false);
      expect(environments.stop).not.toHaveBeenCalled();

      releaseReconcile.resolve();
      await retentionStopped.promise;
      await Promise.resolve();
      expect(environments.stop).not.toHaveBeenCalled();
      releaseScheduledCleanup.resolve();
      await stopping;

      expect(warn).toHaveBeenCalledWith("Worker disk-space sweep failed: probe transport failed");
      expect(environments.stop).toHaveBeenCalledOnce();
    } finally {
      releaseReconcile.resolve();
      releaseScheduledHealth.resolve();
      releaseScheduledCleanup.resolve();
      await sidecar?.stop();
      await scheduledWake;
      startupTrace.close();
      info.mockRestore();
      retentionFactory.mockRestore();
    }
  });

  it.each(["provisioning", "active"] as const)(
    "waits for %s placement resource settlement before exposing readiness",
    async (state) => {
      const releaseRecovery = createDeferredCore();
      const reconcile = vi.fn(async () => await releaseRecovery.promise);
      mockDispatch({ reconcile });
      runtimeFactoryMocks.createSessionEvidenceResolver.mockResolvedValue(async () => "current");
      const environments = createEnvironments();
      const runtime = placementRuntime(startupPlacement(state), environments);
      const starting = startRuntime(runtime);

      try {
        await vi.waitFor(() =>
          expect(reconcile).toHaveBeenCalledWith("startup", expect.any(Function)),
        );
        expect(environments.start).not.toHaveBeenCalled();

        let ready = false;
        void starting.then(() => {
          ready = true;
        });
        await Promise.resolve();
        expect(ready).toBe(false);

        releaseRecovery.resolve();
        const sidecar = await starting;
        expect(sidecar).not.toBeNull();
        expect(environments.start).toHaveBeenCalledOnce();
        await sidecar?.stop();
      } finally {
        releaseRecovery.resolve();
        await starting.catch(() => undefined);
      }
    },
  );

  it("defers unaccepted retirement when shutdown begins during its evidence read", async () => {
    const evidence = createDeferredCore<"absent">();
    const reconcileActive = vi.fn().mockResolvedValue(undefined);
    const retireSessionPlacementAsync = vi.fn(async () => {});
    runtimeFactoryMocks.resolveSessionEvidence.mockImplementationOnce(async () => evidence.promise);
    runtimeFactoryMocks.createSessionEvidenceResolver.mockResolvedValueOnce(
      runtimeFactoryMocks.resolveSessionEvidence,
    );
    mockDispatch({ reconcileActive });
    const environments = createEnvironments();
    const runtime = placementRuntime(startupPlacement("local"), environments, {
      retireSessionPlacementAsync,
    });
    let sidecar: { stop: () => Promise<void> } | undefined;
    const unregisterSidecar = vi.fn();
    try {
      const starting = startRuntime(runtime, {
        registerSidecar: (registered) => {
          sidecar = registered;
        },
        unregisterSidecar,
      });
      await expect(starting).resolves.toBe(sidecar);
      expect(runtimeFactoryMocks.resolveSessionEvidence).toHaveBeenCalledOnce();
      expect(reconcileActive).not.toHaveBeenCalled();
      expect(retireSessionPlacementAsync).not.toHaveBeenCalled();

      const stopping = sidecar?.stop();
      const repeatedStop = sidecar?.stop();
      if (!stopping || !repeatedStop) {
        throw new Error("startup did not register its placement sidecar");
      }

      await Promise.resolve();
      expect(repeatedStop).toBe(stopping);
      expect(environments.beginClose).toHaveBeenCalledOnce();
      expect(environments.stop).not.toHaveBeenCalled();
      evidence.resolve("absent");
      await Promise.all([stopping, repeatedStop]);
      expect(retireSessionPlacementAsync).not.toHaveBeenCalled();
      expect(environments.stop).toHaveBeenCalledOnce();
      expect(unregisterSidecar).not.toHaveBeenCalled();
    } finally {
      evidence.resolve("absent");
      await sidecar?.stop();
    }
  });

  it("retries worker environment cleanup after a failed stop attempt", async () => {
    const stopError = new Error("tunnel cleanup failed");
    const unsubscribeOrphans = vi.fn();
    const subscribeOrphanWorkspaceChanges = vi.fn(() => unsubscribeOrphans);
    const reconcile = vi.fn(async () => {
      expect(subscribeOrphanWorkspaceChanges).toHaveBeenCalledOnce();
    });
    mockDispatch({ subscribeOrphanWorkspaceChanges, reconcile });
    const environments = {
      ...createEnvironments(),
      stop: vi.fn().mockRejectedValueOnce(stopError).mockResolvedValueOnce(undefined),
    };
    const runtime = createRuntime({ environments: environments as never });
    const sidecar = await startRuntime(runtime);
    if (!sidecar) {
      throw new Error("worker placement runtime did not start");
    }

    expect(reconcile).toHaveBeenCalledOnce();
    const firstStop = sidecar.stop();
    expect(unsubscribeOrphans).toHaveBeenCalledOnce();
    expect(sidecar.stop()).toBe(firstStop);
    await expect(firstStop).rejects.toBe(stopError);
    await expect(sidecar.stop()).resolves.toBeUndefined();

    expect(unsubscribeOrphans).toHaveBeenCalledOnce();
    expect(environments.stop).toHaveBeenCalledTimes(2);
  });
});
