import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as devicePairing from "../infra/device-pairing.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { ScopeUpgradeCoordinator } from "./device-scope-upgrade.js";

const pairing = vi.hoisted(() => ({ pending: true }));
vi.mock("../infra/device-pairing.js", () => ({
  getPendingDevicePairing: async () => (pairing.pending ? { requestId: "upgrade" } : null),
  getPairedDevice: async () => null,
}));

const owner = { deviceId: "device", publicKey: "public-key" };
beforeEach(() => {
  pairing.pending = true;
});
afterEach(() => vi.useRealTimers());

function registeredCoordinator(
  scheduler: ReturnType<typeof createTestGatewayScheduler>,
  expiresAtMs = Date.now() + 60_000,
) {
  const coordinator = new ScopeUpgradeCoordinator(scheduler);
  coordinator.register({
    requestId: "upgrade",
    expiresAtMs,
    requestedScopes: ["operator.write"],
    owner,
  });
  return coordinator;
}

describe("scope upgrade observations", () => {
  it("cancels one observer without losing the shared upgrade result", async () => {
    vi.useFakeTimers();
    const scheduler = createTestGatewayScheduler();
    const coordinator = registeredCoordinator(scheduler);
    const observer = new AsyncWorkScope();
    let firstSettled = false;
    const first = observer
      .run(() => coordinator.wait("upgrade", owner))
      .then(
        (value) => {
          firstSettled = true;
          return { value };
        },
        (error: unknown) => {
          firstSettled = true;
          return { error };
        },
      );
    let secondSettled = false;
    const second = coordinator.wait("upgrade", owner).then((value) => {
      secondSettled = true;
      return value;
    });
    try {
      observer.beginClose();
      await vi.advanceTimersByTimeAsync(0);
      expect(firstSettled).toBe(true);
      expect(await first).toEqual({ error: expect.objectContaining({ name: "AbortError" }) });
      expect(secondSettled).toBe(false);
      pairing.pending = false;
      coordinator.notify("upgrade", "rejected");
      expect(await second).toEqual({ status: "rejected", requestId: "upgrade" });
    } finally {
      await coordinator.close();
      await Promise.all([first, second]);
      await observer.drain();
    }
    expect(vi.getTimerCount()).toBe(0);
    expect(scheduler.nextWakeAtMs).toBeNull();
  });

  it("retires queued observations at the scheduler fence before received work closes", async () => {
    vi.useFakeTimers();
    const scheduler = createTestGatewayScheduler();
    const coordinator = registeredCoordinator(scheduler);
    const observer = new AsyncWorkScope();
    const pendingRead = vi.spyOn(devicePairing, "getPendingDevicePairing");
    const observation = observer
      .run(() => coordinator.wait("upgrade", owner))
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(pendingRead).toHaveBeenCalledTimes(1);
      coordinator.notify("upgrade", "rejected");
      scheduler.beginClose();
      await vi.advanceTimersByTimeAsync(0);
      expect(observer.signal.aborted).toBe(false);
      expect(pendingRead).toHaveBeenCalledTimes(1);
      await expect(observation).resolves.toEqual({
        error: expect.objectContaining({ name: "AbortError" }),
      });
    } finally {
      observer.beginClose();
      await coordinator.close();
      await observation;
      await observer.drain();
      await scheduler.stop();
      pendingRead.mockRestore();
    }
    expect(vi.getTimerCount()).toBe(0);
    expect(scheduler.nextWakeAtMs).toBeNull();
  });

  it.each(["pending", "terminal"] as const)(
    "expires retained %s results once after a late Gateway wake",
    async (state) => {
      const time = createGatewaySchedulerClock(1_000);
      const scheduler = createTestGatewayScheduler(time.clock);
      pairing.pending = state === "pending";
      const coordinator = registeredCoordinator(scheduler, 61_000);
      try {
        if (state === "terminal") {
          expect(await coordinator.wait("upgrade", owner)).toEqual({
            status: "rejected",
            requestId: "upgrade",
          });
          await time.advanceTo(15_999);
          expect(await coordinator.wait("upgrade", owner)).toEqual({
            status: "rejected",
            requestId: "upgrade",
          });
        }
        time.setTime(state === "pending" ? 90_000 : 30_000);
        await time.wake();
        expect(await coordinator.wait("upgrade", owner)).toBeNull();
        expect(scheduler.nextWakeAtMs).toBeNull();
      } finally {
        await coordinator.close();
        await scheduler.stop();
      }
    },
  );
});
