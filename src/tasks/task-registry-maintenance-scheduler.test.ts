import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as gatewayWork from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createTaskMaintenanceScheduler } from "./task-registry-maintenance-scheduler.js";

beforeEach(() => {
  gatewayWork.resetGatewayWorkAdmission();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  gatewayWork.resetGatewayWorkAdmission();
  vi.useRealTimers();
});

describe("task maintenance admission diagnostics", () => {
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
        scheduler.start();
        if (suspended) {
          await vi.advanceTimersByTimeAsync(5_000);
        }
        gatewayWork.markGatewayRestartDraining();
        await vi.advanceTimersByTimeAsync(60_000);
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
      scheduler.start();
      await vi.advanceTimersByTimeAsync(5_000);
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
      scheduler.start();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(run).toHaveBeenCalledOnce();
      gatewayWork.markGatewayRestartDraining();
      let stopped = false;
      const stopping = scheduler.stop().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);
      sweep.reject(failure);
      await stopping;
      expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
      expect(gatewayWork.getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      sweep.resolve();
      await scheduler.stop();
    }
  });
});
