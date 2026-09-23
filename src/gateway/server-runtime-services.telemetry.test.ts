import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { clearGatewayMaintenanceHandles } from "./server-maintenance-lifecycle.js";
import { createMaintenanceHandles } from "./server-runtime-services.test-harness.js";

afterEach(() => {
  vi.useRealTimers();
});

it.each(["stopPeriodicTasks", "skillUsageCleanup"] as const)(
  "joins %s admitted before post-ready maintenance cleanup",
  async (owner) => {
    vi.useFakeTimers();
    const maintenance = createMaintenanceHandles();
    const stopped = createDeferredCore();
    maintenance[owner].mockImplementation(() => stopped.promise);
    let cleared = false;
    const clearing = clearGatewayMaintenanceHandles(maintenance).then(() => {
      cleared = true;
    });
    try {
      expect(maintenance[owner]).toHaveBeenCalledOnce();
      await Promise.resolve();
      expect(cleared).toBe(false);
    } finally {
      stopped.resolve();
      await clearing;
    }
    expect(cleared).toBe(true);
  },
);

it.each(["stopPeriodicTasks", "skillUsageCleanup"] as const)(
  "joins %s before reporting another maintenance owner's cleanup failure",
  async (heldOwner) => {
    vi.useFakeTimers();
    const maintenance = createMaintenanceHandles();
    const held = createDeferredCore();
    const earlyFailure = new Error("first owner failed");
    const lateFailure = new Error("held owner failed");
    const failingOwner =
      heldOwner === "stopPeriodicTasks" ? "skillUsageCleanup" : "stopPeriodicTasks";
    maintenance[heldOwner].mockReturnValue(held.promise);
    maintenance[failingOwner].mockRejectedValue(earlyFailure);
    let settled = false;
    const clearing = clearGatewayMaintenanceHandles(maintenance).then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      held.reject(lateFailure);

      const error = await clearing;
      expect(error).toBeInstanceOf(AggregateError);
      expect(error).toMatchObject({ errors: expect.arrayContaining([earlyFailure, lateFailure]) });
    } finally {
      held.resolve();
      await clearing;
    }
  },
);
