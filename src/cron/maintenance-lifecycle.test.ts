import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as gatewayWork from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { startCronMaintenance, stopCronMaintenance } from "./maintenance.js";

const mocks = vi.hoisted(() => ({
  history: vi.fn(async () => {}),
  registry: vi.fn(async () => ({})),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// mock-isolation: Exercise the real startup and scheduler lifetimes without SQLite workers.
vi.mock("../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: () => ({ admission: { assertCurrent() {} } }),
}));
// mock-isolation: Observe retention writes without starting database workers.
vi.mock("./store/run-history.js", () => ({ maintainCronRunHistory: mocks.history }));
// mock-isolation: Observe the session sweep without opening session stores.
vi.mock("./session-registry-maintenance.js", () => ({
  runSessionRegistryMaintenance: mocks.registry,
}));
// mock-isolation: Collect scheduler diagnostics without process-global log sinks.
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ ...mocks, debug() {}, trace() {} }),
}));

let clock: ReturnType<typeof createGatewaySchedulerClock>;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.history.mockReset().mockResolvedValue(undefined);
  clock = createGatewaySchedulerClock();
  gatewayWork.resetGatewayWorkAdmission();
  scheduler = createTestGatewayScheduler(clock.clock);
});
afterEach(async () => {
  await stopCronMaintenance();
  await scheduler.stop();
  vi.restoreAllMocks();
  gatewayWork.resetGatewayWorkAdmission();
});

it.each([false, true])("runs retention after startup preparation, pending=%s", async (pending) => {
  await withAgentDatabaseStartupAdmission(async (admission) => {
    const preparation = createDeferredCore();
    if (pending) {
      admission.track(preparation.promise);
    }
    try {
      startCronMaintenance(scheduler);
      const tick = clock.advanceBy(5_000);
      if (pending) {
        expect(mocks.history).not.toHaveBeenCalled();
        expect(mocks.registry).not.toHaveBeenCalled();
        expect(gatewayWork.getActiveGatewayRootWorkCount()).toBe(0);
        await clock.advanceBy(60_000);
        expect(mocks.info).toHaveBeenCalledExactlyOnceWith(
          "Cron maintenance deferred until agent database startup preparation completes",
        );
      }
      preparation.resolve();
      await tick;
      expect(mocks.history).toHaveBeenCalledOnce();
      expect(mocks.registry).toHaveBeenCalledOnce();
      expect(mocks.warn).not.toHaveBeenCalled();
      expect(mocks.error).not.toHaveBeenCalled();
      await clock.advanceBy(60_000);
      expect(mocks.history).toHaveBeenCalledTimes(2);
      expect(mocks.registry).toHaveBeenCalledTimes(2);
      expect(mocks.info).toHaveBeenCalledTimes(pending ? 1 : 0);
    } finally {
      preparation.resolve();
    }
  });
});

it("cancels the startup wait when the Gateway stops", async () => {
  await withAgentDatabaseStartupAdmission(async (admission) => {
    const preparation = createDeferredCore();
    admission.track(preparation.promise);
    try {
      startCronMaintenance(scheduler);
      const tick = clock.advanceBy(5_000);
      await scheduler.stop();
      await tick;
      preparation.resolve();
      expect(mocks.history).not.toHaveBeenCalled();
      expect(mocks.warn).not.toHaveBeenCalled();
      expect(mocks.error).not.toHaveBeenCalled();
    } finally {
      preparation.resolve();
    }
  });
});

describe("Cron maintenance admission diagnostics", () => {
  it("joins scheduler shutdown while maintenance is still waiting behind suspension", async () => {
    const suspension = gatewayWork.tryBeginGatewaySuspendAdmission(() => {});
    if (!suspension?.commit()) {
      throw new Error("Expected to suspend task admission");
    }
    try {
      startCronMaintenance(scheduler);
      const tick = clock.advanceBy(5_000);
      await scheduler.stop();
      await tick;
      expect(mocks.history).not.toHaveBeenCalled();
      expect(mocks.warn).not.toHaveBeenCalled();
      expect(gatewayWork.getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      await stopCronMaintenance();
      suspension.release();
    }
  });

  it.each([false, true])(
    "does not report a refused sweep when restart begins after suspension=%s",
    async (suspended) => {
      const suspension = suspended ? gatewayWork.tryBeginGatewaySuspendAdmission(() => {}) : null;
      if (suspended && (!suspension || !suspension.commit())) {
        throw new Error("Expected to suspend task admission");
      }
      try {
        startCronMaintenance(scheduler);
        const pending = suspended ? clock.advanceBy(5_000) : undefined;
        gatewayWork.markGatewayRestartDraining();
        await pending;
        await clock.advanceBy(60_000);
        expect(mocks.history).not.toHaveBeenCalled();
        expect(mocks.warn).not.toHaveBeenCalled();
        expect(gatewayWork.getActiveGatewayRootWorkCount()).toBe(0);
      } finally {
        await stopCronMaintenance();
        suspension?.release();
      }
    },
  );

  it("reports an unexpected admission failure even during restart drain", async () => {
    const failure = new Error("synthetic admission failure");
    vi.spyOn(gatewayWork, "runWithGatewayIndependentRootWorkAdmission").mockRejectedValueOnce(
      failure,
    );

    try {
      gatewayWork.markGatewayRestartDraining();
      startCronMaintenance(scheduler);
      await clock.advanceBy(5_000);
      expect(mocks.history).not.toHaveBeenCalled();
      expect(mocks.warn).toHaveBeenCalledExactlyOnceWith("Cron maintenance failed", {
        error: failure,
      });
    } finally {
      await stopCronMaintenance();
    }
  });

  it.each([
    {
      kind: "disk-full",
      failure: new Error("Cron history maintenance failed: database or disk is full"),
    },
    { kind: "drain", failure: new gatewayWork.GatewayDrainingError() },
  ])("reports an admitted $kind failure while stop joins its sweep", async ({ failure }) => {
    const sweep = createDeferredCore();
    mocks.history.mockImplementation(() => sweep.promise);

    try {
      startCronMaintenance(scheduler);
      const tick = clock.advanceBy(5_000);
      expect(mocks.history).toHaveBeenCalledOnce();
      gatewayWork.markGatewayRestartDraining();
      const gatewayStopping = scheduler.stop();
      let stopped = false;
      const stopping = stopCronMaintenance().then(() => {
        stopped = true;
      });
      expect(stopped).toBe(false);
      sweep.reject(failure);
      await stopping;
      await gatewayStopping;
      await tick;
      expect(mocks.warn).toHaveBeenCalledExactlyOnceWith("Cron maintenance failed", {
        error: failure,
      });
      expect(gatewayWork.getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      sweep.resolve();
      await stopCronMaintenance();
    }
  });
});
