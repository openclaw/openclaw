import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
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
    const coordinator = new ScopeUpgradeCoordinator();
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
  });
});
