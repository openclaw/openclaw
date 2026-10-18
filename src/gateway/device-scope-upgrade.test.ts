import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => vi.useRealTimers());

describe("scope upgrade observations", () => {
  it("cancels one observer without losing the shared upgrade result", async () => {
    vi.useFakeTimers();
    pairing.pending = true;
    const scheduler = createTestGatewayScheduler();
    const coordinator = new ScopeUpgradeCoordinator(scheduler);
    const observer = new AsyncWorkScope();
    const owner = { deviceId: "device", publicKey: "public-key" };
    coordinator.register({
      requestId: "upgrade",
      expiresAtMs: Date.now() + 60_000,
      requestedScopes: ["operator.write"],
      owner,
    });
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

  it.each(["pending", "terminal"] as const)(
    "expires retained %s results once after a late Gateway wake",
    async (state) => {
      const time = createGatewaySchedulerClock(1_000);
      const scheduler = createTestGatewayScheduler(time.clock);
      const coordinator = new ScopeUpgradeCoordinator(scheduler);
      const owner = { deviceId: "device", publicKey: "public-key" };
      pairing.pending = state === "pending";
      coordinator.register({
        requestId: "upgrade",
        expiresAtMs: 61_000,
        requestedScopes: ["operator.write"],
        owner,
      });
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
