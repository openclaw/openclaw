import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import * as gatewayWork from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { createTaskMaintenanceScheduler } from "./task-registry-maintenance-scheduler.js";

let clock: ReturnType<typeof createGatewaySchedulerClock>;
let gatewayScheduler: GatewayScheduler;
beforeEach(() => {
  gatewayWork.resetGatewayWorkAdmission();
  clock = createGatewaySchedulerClock();
  gatewayScheduler = createTestGatewayScheduler(clock.clock);
});

afterEach(async () => {
  await gatewayScheduler.stop();
  vi.restoreAllMocks();
  gatewayWork.resetGatewayWorkAdmission();
});

describe("task maintenance admission diagnostics", () => {
  it("joins scheduler shutdown while maintenance is still waiting behind suspension", async () => {
    const run = vi.fn(async () => {});
    const onError = vi.fn();
    const scheduler = createTaskMaintenanceScheduler(run, onError);
    const suspension = gatewayWork.tryBeginGatewaySuspendAdmission(() => {});
    if (!suspension?.commit()) {
      throw new Error("Expected to suspend task admission");
    }
    try {
      scheduler.start(gatewayScheduler);
      const tick = clock.advanceBy(5_000);
      await gatewayScheduler.stop();
      await tick;
      expect(run).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(gatewayWork.getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      await scheduler.stop();
      suspension.release();
    }
  });

  it.each([false, true])(
    "does not report a refused sweep when restart begins after suspension=%s",
    async (suspended) => {
      const run = vi.fn(async () => {});
      const onError = vi.fn();
      const scheduler = createTaskMaintenanceScheduler(run, onError);
      const suspension = suspended ? gatewayWork.tryBeginGatewaySuspendAdmission(() => {}) : null;
      if (suspended && (!suspension || !suspension.commit())) {
        throw new Error("Expected to suspend task admission");
      }
      try {
        scheduler.start(gatewayScheduler);
        const pending = suspended ? clock.advanceBy(5_000) : undefined;
        gatewayWork.markGatewayRestartDraining();
        await pending;
        await clock.advanceBy(60_000);
        expect(run).not.toHaveBeenCalled();
        expect(onError).not.toHaveBeenCalled();
        expect(gatewayWork.getActiveGatewayRootWorkCount()).toBe(0);
      } finally {
        await scheduler.stop();
        suspension?.release();
      }
    },
  );

  it("reports an unexpected admission failure even during restart drain", async () => {
    const failure = new Error("synthetic admission failure");
    vi.spyOn(gatewayWork, "runWithGatewayIndependentRootWorkAdmission").mockRejectedValueOnce(
      failure,
    );
    const run = vi.fn(async () => {});
    const onError = vi.fn();
    const scheduler = createTaskMaintenanceScheduler(run, onError);
    try {
      gatewayWork.markGatewayRestartDraining();
      scheduler.start(gatewayScheduler);
      await clock.advanceBy(5_000);
      expect(run).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    } finally {
      await scheduler.stop();
    }
  });

  it.each([
    {
      kind: "disk-full",
      failure: new Error("Task registry restore failed: database or disk is full"),
    },
    { kind: "drain", failure: new gatewayWork.GatewayDrainingError() },
  ])("reports an admitted $kind failure while stop joins its sweep", async ({ failure }) => {
    const sweep = createDeferredCore();
    const run = vi.fn(() => sweep.promise);
    const onError = vi.fn();
    const scheduler = createTaskMaintenanceScheduler(run, onError);
    try {
      scheduler.start(gatewayScheduler);
      const tick = clock.advanceBy(5_000);
      expect(run).toHaveBeenCalledOnce();
      gatewayWork.markGatewayRestartDraining();
      const gatewayStopping = gatewayScheduler.stop();
      let stopped = false;
      const stopping = scheduler.stop().then(() => {
        stopped = true;
      });
      expect(stopped).toBe(false);
      sweep.reject(failure);
      await stopping;
      await gatewayStopping;
      await tick;
      expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
      expect(gatewayWork.getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      sweep.resolve();
      await scheduler.stop();
    }
  });
});
