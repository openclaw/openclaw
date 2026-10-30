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
const rejected = { status: "rejected", requestId: "upgrade" };
beforeEach(() => {
  pairing.pending = true;
});
afterEach(() => vi.useRealTimers());

const rejection = (error: unknown) => ({ error });

function fixture(scheduler = createTestGatewayScheduler(), expiresAtMs = Date.now() + 60_000) {
  const coordinator = new ScopeUpgradeCoordinator(scheduler);
  coordinator.register({
    requestId: "upgrade",
    expiresAtMs,
    requestedScopes: ["operator.write"],
    owner,
  });
  const observer = new AsyncWorkScope();
  const pending: Promise<unknown>[] = [];
  return {
    coordinator,
    scheduler,
    observer,
    track<T>(work: Promise<T>) {
      pending.push(work);
      return work;
    },
    async [Symbol.asyncDispose]() {
      observer.beginClose();
      try {
        await coordinator.close();
        await Promise.all(pending);
        await observer.drain();
        if (vi.isFakeTimers()) {
          expect(vi.getTimerCount()).toBe(0);
        }
        expect(scheduler.nextWakeAtMs).toBeNull();
      } finally {
        await scheduler.stop();
      }
    },
  };
}

describe("scope upgrade observations", () => {
  it("cancels one observer without losing the shared upgrade result", async () => {
    vi.useFakeTimers();
    await using f = fixture();
    const { coordinator, observer } = f;
    const secondSettled = vi.fn();
    const first = f.track(observer.run(() => coordinator.wait("upgrade", owner)).catch(rejection));
    const second = f.track(coordinator.wait("upgrade", owner).finally(secondSettled));
    observer.beginClose();
    await vi.advanceTimersByTimeAsync(0);
    expect(await first).toEqual({ error: expect.objectContaining({ name: "AbortError" }) });
    expect(secondSettled).not.toHaveBeenCalled();
    pairing.pending = false;
    coordinator.notify("upgrade", "rejected");
    expect(await second).toEqual(rejected);
  });

  it("retires queued observations at the scheduler fence before received work closes", async () => {
    vi.useFakeTimers();
    using pendingRead = vi.spyOn(devicePairing, "getPendingDevicePairing");
    await using f = fixture();
    const { scheduler, coordinator, observer } = f;
    const observation = f.track(
      observer.run(() => coordinator.wait("upgrade", owner)).catch(rejection),
    );
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
  });

  it.each(["pending", "terminal"] as const)(
    "expires retained %s results after a late wake",
    async (state) => {
      const time = createGatewaySchedulerClock(1_000);
      pairing.pending = state === "pending";
      await using f = fixture(createTestGatewayScheduler(time.clock), 61_000);
      const { coordinator, scheduler } = f;
      if (state === "terminal") {
        expect(await coordinator.wait("upgrade", owner)).toEqual(rejected);
        await time.advanceTo(15_999);
        expect(await coordinator.wait("upgrade", owner)).toEqual(rejected);
      }
      time.setTime(state === "pending" ? 90_000 : 30_000);
      await time.wake();
      expect(await coordinator.wait("upgrade", owner)).toBeNull();
      expect(scheduler.nextWakeAtMs).toBeNull();
    },
  );
});
