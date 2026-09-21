import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as gatewayWork from "../process/gateway-work-admission.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createManagedTaskFlow, getTaskFlowById } from "./task-flow-registry.js";
import * as flowMaintenance from "./task-flow-registry.maintenance.js";
import {
  resetTaskRegistryMaintenanceRuntimeForTests,
  setTaskRegistryMaintenanceRuntimeForTests,
  startTaskRegistryMaintenance,
  stopTaskRegistryMaintenance,
} from "./task-registry.maintenance.js";
import {
  configureTaskRegistryMaintenanceRuntimeForTest,
  createPreparedMaintenanceRead,
} from "./task-registry.maintenance.test-support.js";
import { flushAsyncWork, withTaskRegistryTempDir } from "./task-registry.test-support.js";

beforeEach(() => {
  resetGatewayWorkAdmission();
});

afterEach(async () => {
  await stopTaskRegistryMaintenance();
  resetTaskRegistryMaintenanceRuntimeForTests();
  resetGatewayWorkAdmission();
  vi.useRealTimers();
});

describe("task-registry maintenance scheduling", () => {
  it("stops a suspended admission without reopening or running maintenance", async () => {
    await withTaskRegistryTempDir(async () => {
      vi.useFakeTimers();
      const loadCloseAcpSession = vi.fn(async () => undefined);
      configureTaskRegistryMaintenanceRuntimeForTest({
        currentTasks: new Map(),
        snapshotTasks: [],
        loadCloseAcpSession,
      });
      const suspension = gatewayWork.tryBeginGatewaySuspendAdmission(() => {});
      if (!suspension || !suspension.commit()) {
        throw new Error("Expected to suspend task admission");
      }
      let stopped: Promise<void> | undefined;
      try {
        startTaskRegistryMaintenance();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(loadCloseAcpSession).not.toHaveBeenCalled();
        let settled = false;
        stopped = stopTaskRegistryMaintenance().then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(true);
        expect(gatewayWork.getGatewaySuspendAdmissionPhase()).toBe("prepared");
        expect(gatewayWork.getActiveGatewayRootWorkCount()).toBe(0);
        suspension.release();
        await vi.advanceTimersByTimeAsync(0);
        expect(loadCloseAcpSession).not.toHaveBeenCalled();
      } finally {
        suspension.release();
        await stopped;
        await stopTaskRegistryMaintenance();
      }
    });
  });

  it("joins task cleanup and flow retention before stopping scheduled maintenance", async () => {
    await withTaskRegistryTempDir(
      async () => {
        vi.useFakeTimers();
        const loader = createDeferredCore();
        const flowEntered = createDeferredCore();
        const flowRelease = createDeferredCore();
        const scheduled: Promise<unknown>[] = [];
        const runRootWork = gatewayWork.runWithGatewayIndependentRootWorkAdmission;
        const rootWork = vi
          .spyOn(gatewayWork, "runWithGatewayIndependentRootWorkAdmission")
          .mockImplementation((run, origin, signal) => {
            const pending = runRootWork(run, origin, signal);
            scheduled.push(pending);
            return pending;
          });
        const runFlowMaintenance = flowMaintenance.runTaskFlowRegistryMaintenance;
        const flowWork = vi
          .spyOn(flowMaintenance, "runTaskFlowRegistryMaintenance")
          .mockImplementation(async () => {
            flowEntered.resolve();
            await flowRelease.promise;
            return await runFlowMaintenance();
          });
        const loadCloseAcpSession = vi.fn(async () => {
          await loader.promise;
          return undefined;
        });
        configureTaskRegistryMaintenanceRuntimeForTest({
          currentTasks: new Map(),
          snapshotTasks: [],
          loadCloseAcpSession,
        });
        const endedAt = Date.now() - 8 * 24 * 60 * 60_000;
        const flow = createManagedTaskFlow({
          ownerKey: "agent:main:main",
          controllerId: "tests/maintenance-stop",
          goal: "Completed flow awaiting retention",
          status: "succeeded",
          createdAt: endedAt,
          updatedAt: endedAt,
          endedAt,
        });
        if (!flow) {
          throw new Error("Expected the completed task flow fixture");
        }
        let completedStops = 0;
        try {
          startTaskRegistryMaintenance();
          await vi.advanceTimersByTimeAsync(5_000);
          await vi.advanceTimersByTimeAsync(60_000);
          expect(loadCloseAcpSession).toHaveBeenCalledOnce();
          const stop = () =>
            Promise.resolve(stopTaskRegistryMaintenance()).then(() => {
              completedStops += 1;
            });
          const stops = [stop(), stop()];
          await flushAsyncWork();
          expect(completedStops).toBe(0);
          expect(getTaskFlowById(flow.flowId)).toBeDefined();

          loader.resolve();
          await flowEntered.promise;
          expect(completedStops).toBe(0);
          await vi.advanceTimersByTimeAsync(60_000);
          expect(loadCloseAcpSession).toHaveBeenCalledOnce();

          flowRelease.resolve();
          await Promise.all(stops);
          expect(completedStops).toBe(2);
          expect(getTaskFlowById(flow.flowId)).toBeUndefined();
          expect(gatewayWork.getActiveGatewayRootWorkCount()).toBe(0);
        } finally {
          loader.resolve();
          flowRelease.resolve();
          await stopTaskRegistryMaintenance();
          // Join the real scheduled work even when checking the pre-fix stop behavior.
          await Promise.allSettled(scheduled);
          rootWork.mockRestore();
          flowWork.mockRestore();
        }
      },
      { durableStore: true },
    );
  });

  it("keeps repeated starts owned by stop and supports a later restart", async () => {
    await withTaskRegistryTempDir(async () => {
      vi.useFakeTimers();
      const scheduled: Promise<unknown>[] = [];
      const runRootWork = gatewayWork.runWithGatewayIndependentRootWorkAdmission;
      const rootWork = vi
        .spyOn(gatewayWork, "runWithGatewayIndependentRootWorkAdmission")
        .mockImplementation((run, origin, signal) => {
          const pending = runRootWork(run, origin, signal);
          scheduled.push(pending);
          return pending;
        });
      const loadCloseAcpSession = vi.fn(async () => undefined);
      configureTaskRegistryMaintenanceRuntimeForTest({
        currentTasks: new Map(),
        snapshotTasks: [],
        loadCloseAcpSession,
      });
      try {
        startTaskRegistryMaintenance();
        startTaskRegistryMaintenance();
        await stopTaskRegistryMaintenance();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(loadCloseAcpSession).not.toHaveBeenCalled();

        startTaskRegistryMaintenance();
        await vi.advanceTimersByTimeAsync(5_000);
        await stopTaskRegistryMaintenance();
        expect(loadCloseAcpSession).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(loadCloseAcpSession).toHaveBeenCalledOnce();
      } finally {
        await stopTaskRegistryMaintenance();
        await Promise.allSettled(scheduled);
        rootWork.mockRestore();
      }
    });
  });

  it("does not leak unhandled rejections when the scheduled maintenance sweep fails", async () => {
    await withTaskRegistryTempDir(async () => {
      vi.useFakeTimers();

      const unhandled: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandledRejection);

      setTaskRegistryMaintenanceRuntimeForTests({
        listAcpSessionEntries: async () => [],
        readAcpSessionEntry: () => ({
          cfg: {},
          storePath: "",
          sessionKey: "",
          storeSessionKey: "",
          entry: undefined,
          storeReadFailed: false,
        }),
        readSessionBackingFacts: () => [],
        readSessionBackingFactsInWorker: async (scopes) => scopes.map(() => []),
        resolveStorePath: () => "",
        parseAgentSessionKey: () => null,
        isCronJobActive: () => false,
        getAgentRunContext: () => undefined,
        hasActiveAcpTurn: () => false,
        hasActiveTaskForChildSessionKey: () => false,
        deleteTaskRecordById: () => false,
        ensureTaskRegistryReady: () => {},
        getTaskById: () => undefined,
        getTaskRegistryMaintenanceTask: () => undefined,
        prepareTaskRegistryRead: async () => createPreparedMaintenanceRead(),
        getTaskRegistryMaintenanceSnapshot: () => {
          throw new Error("maintenance boom");
        },
        listTaskRecords: () => [],
        markTaskLostById: () => null,
        markTaskTerminalById: () => null,
        maybeDeliverTaskTerminalUpdate: async () => null,
        resolveTaskForLookupToken: () => undefined,
        setTaskCleanupAfterById: () => null,
        isRuntimeAuthoritative: () => true,
        listTaskRegistryRecordsByRuntimeSourceIdFromSqlite: () => [],
      });

      try {
        startTaskRegistryMaintenance();
        await vi.advanceTimersByTimeAsync(5_000);
        await flushAsyncWork();
        expect(unhandled).toStrictEqual([]);
      } finally {
        await stopTaskRegistryMaintenance();
        process.off("unhandledRejection", onUnhandledRejection);
      }
    });
  });
});
