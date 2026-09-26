import { describe, expect, it, vi } from "vitest";
import { getWorkerPlacementStartupMocks } from "./server-worker-placement-startup.test-harness.js";

const { runtimeFactoryMocks } = getWorkerPlacementStartupMocks();

import { getRuntimeConfig } from "../config/config.js";
import { emitSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { createGatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";

describe("worker placement session events", () => {
  it("reports a failed reconciliation queued by a session change without leaking rejection", async () => {
    const time = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(time.clock);
    const databaseIdentity = Symbol("worker-placement-database");
    const releaseReconcile = createDeferredCore();
    const reconcileStarted = createDeferredCore();
    const failureReported = createDeferredCore();
    const reconcileActive = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    runtimeFactoryMocks.createDiskSpace.mockReturnValue({
      read: vi.fn(),
      version: () => 0,
      sweep: vi.fn().mockResolvedValue(undefined),
    });
    runtimeFactoryMocks.createDispatch.mockReturnValue({
      dispatch: vi.fn(),
      forceDestroyEnvironment: vi.fn(),
      reclaim: vi.fn(),
      reconcile: vi.fn().mockResolvedValue(undefined),
      reconcileActive,
    });
    const warn = vi.fn(() => failureReported.resolve());
    const runtime = createGatewayWorkerPlacementRuntime({
      scheduler,
      getCommittedRuntimeConfig: getRuntimeConfig,
      cancelSessionWork: vi.fn(async () => {}),
      placements: {
        workspaceResultInstanceId: () => "gateway-test",
        get: () => undefined,
        list: () => [],
        retireSessionPlacement: vi.fn(),
        pruneOrphanedWorkspaceReconciliations: () => [],
        listWorkspaceReconciliationOwners: () => [],
        listPendingWorkspaceResults: () => [],
      } as never,
      environments: {
        subscribeMachineShapeChanged: vi.fn(() => vi.fn()),
        installReconcileEnvironmentGuard: vi.fn(() => vi.fn()),
        start: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      } as never,
      gatewayNamespace: "gateway-test",
      revokeSessionAuthority: vi.fn(),
      warn,
    });
    const sidecar = await runtime.startRuntime({
      isClosePreludeStarted: () => false,
      registerSidecar: vi.fn(),
      unregisterSidecar: vi.fn(),
    });
    let scheduledWake: void | Promise<void> = undefined;
    try {
      await time.advanceBy(60_000);
      reconcileActive.mockClear();
      reconcileActive
        .mockImplementationOnce(() => {
          reconcileStarted.resolve();
          return releaseReconcile.promise;
        })
        .mockRejectedValue(new Error("Worker environment inventory has closed"));
      scheduledWake = time.advanceBy(60_000);
      await reconcileStarted.promise;
      expect(reconcileActive).toHaveBeenCalledOnce();
      emitSessionIdentityMutation({
        kind: "delete",
        agentId: "main",
        databaseIdentity,
        previous: { sessionId: "retired-session", sessionKeys: ["agent:main:retired"] },
      });
      releaseReconcile.resolve();
      await failureReported.promise;
      expect(reconcileActive).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(
        "Worker placement reconcile sweep failed: Worker environment inventory has closed",
      );
    } finally {
      releaseReconcile.resolve();
      await sidecar?.stop();
      await scheduledWake;
    }
  });
});
