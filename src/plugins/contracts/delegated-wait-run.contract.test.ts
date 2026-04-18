import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWaitRunHandleRegistry,
  type DelegatedWaitRunResolution,
  type WaitRunHandle,
  type WaitRunHandleRegistry,
} from "../../plugin-sdk/delegated-wait-run.js";

describe("delegated-wait-run seam", () => {
  let registry: WaitRunHandleRegistry;

  afterEach(() => {
    vi.useRealTimers();
  });

  function fresh(): void {
    registry = createWaitRunHandleRegistry();
  }

  // ---- Register -----------------------------------------------------------

  describe("register", () => {
    it("creates a handle in pending state", () => {
      fresh();
      const h = registry.register("t-1");
      expect(h.id).toBe("t-1");
      expect(h.status).toBe("pending");
      expect(h.createdAt).toBeTruthy();
      expect(h.resolution).toBeUndefined();
      expect(h.cancelReason).toBeUndefined();
    });

    it("stores ttl and meta when provided", () => {
      fresh();
      const h = registry.register("t-2", { ttlMs: 60_000, meta: { foo: 1 } });
      expect(h.expiresAt).toBeTruthy();
      expect(h.meta).toEqual({ foo: 1 });
    });

    it("throws on duplicate id", () => {
      fresh();
      registry.register("t-3");
      expect(() => registry.register("t-3")).toThrow("already registered");
    });

    it("omits expiresAt when no ttl is configured", () => {
      fresh();
      const h = registry.register("t-4");
      expect(h.expiresAt).toBeUndefined();
    });
  });

  // ---- Resolve ------------------------------------------------------------

  describe("resolve", () => {
    it("transitions to resolved with payload", () => {
      fresh();
      const h = registry.register("r-1");
      const resolution: DelegatedWaitRunResolution = {
        outcome: "success",
        output: { result: 42 },
      };
      h.resolve(resolution);
      expect(h.status).toBe("resolved");
      expect(h.resolution).toEqual(resolution);
    });

    it("is idempotent — second resolve is no-op", () => {
      fresh();
      const h = registry.register("r-2");
      h.resolve({ outcome: "success" });
      h.resolve({ outcome: "failure", error: "late" });
      expect(h.status).toBe("resolved");
      expect(h.resolution?.outcome).toBe("success");
    });

    it("resolve via registry id also works", () => {
      fresh();
      registry.register("r-3");
      registry.resolve("r-3", { outcome: "failure", error: "boom" });
      expect(registry.get("r-3")?.status).toBe("resolved");
    });

    it("registry.resolve on unknown id is no-op", () => {
      fresh();
      expect(() => registry.resolve("nope", { outcome: "success" })).not.toThrow();
    });
  });

  // ---- Cancel -------------------------------------------------------------

  describe("cancel", () => {
    it("transitions to cancelled with reason", () => {
      fresh();
      const h = registry.register("c-1");
      h.cancel("user request");
      expect(h.status).toBe("cancelled");
      expect(h.cancelReason).toBe("user request");
    });

    it("is idempotent", () => {
      fresh();
      const h = registry.register("c-2");
      h.cancel("first");
      h.cancel("second");
      expect(h.cancelReason).toBe("first");
    });

    it("cancel via registry id also works", () => {
      fresh();
      registry.register("c-3");
      registry.cancel("c-3", "timeout");
      expect(registry.get("c-3")?.status).toBe("cancelled");
    });

    it("registry.cancel on unknown id is no-op", () => {
      fresh();
      expect(() => registry.cancel("nope")).not.toThrow();
    });

    it("cannot cancel a resolved handle", () => {
      fresh();
      const h = registry.register("c-4");
      h.resolve({ outcome: "success" });
      h.cancel("too late");
      expect(h.status).toBe("resolved");
    });
  });

  // ---- Late / illegal transitions -----------------------------------------

  describe("illegal transitions", () => {
    it("resolve after cancel is no-op", () => {
      fresh();
      const h = registry.register("x-1");
      h.cancel("stopped");
      h.resolve({ outcome: "success" });
      expect(h.status).toBe("cancelled");
      expect(h.resolution).toBeUndefined();
    });
  });

  // ---- TTL expiry ---------------------------------------------------------

  describe("ttl expiry", () => {
    it("handle transitions to expired after ttl elapses", () => {
      vi.useFakeTimers();
      fresh();
      const h = registry.register("ttl-1", { ttlMs: 5_000 });
      expect(h.status).toBe("pending");

      vi.advanceTimersByTime(5_000);
      // Accessing .status triggers lazy check
      expect(h.status).toBe("expired");
    });

    it("handle with long ttl stays pending", () => {
      vi.useFakeTimers();
      fresh();
      const h = registry.register("ttl-2", { ttlMs: 60_000 });
      vi.advanceTimersByTime(1_000);
      expect(h.status).toBe("pending");
    });

    it("resolved handle is not affected by ttl", () => {
      vi.useFakeTimers();
      fresh();
      const h = registry.register("ttl-3", { ttlMs: 1_000 });
      h.resolve({ outcome: "success" });
      vi.advanceTimersByTime(10_000);
      expect(h.status).toBe("resolved");
    });
  });

  // ---- Cleanup ------------------------------------------------------------

  describe("cleanup", () => {
    it("removes expired handles and returns count", () => {
      vi.useFakeTimers();
      fresh();
      registry.register("cu-1", { ttlMs: 1_000 });
      registry.register("cu-2", { ttlMs: 10_000 });

      vi.advanceTimersByTime(5_000);
      const removed = registry.cleanup();
      expect(removed).toBe(1);
      expect(registry.get("cu-1")).toBeUndefined();
      expect(registry.get("cu-2")).toBeDefined();
    });

    it("returns 0 when nothing is expired", () => {
      fresh();
      registry.register("cu-3");
      expect(registry.cleanup()).toBe(0);
    });
  });

  // ---- wait() promise -----------------------------------------------------

  describe("wait", () => {
    it("settles on resolve", async () => {
      fresh();
      const h = registry.register("w-1");
      const p = h.wait();
      h.resolve({ outcome: "success", output: 123 });
      const settled = await p;
      expect(settled.status).toBe("resolved");
      expect(settled.resolution?.output).toBe(123);
    });

    it("settles on cancel", async () => {
      fresh();
      const h = registry.register("w-2");
      const p = h.wait();
      h.cancel("aborted");
      const settled = await p;
      expect(settled.status).toBe("cancelled");
    });

    it("resolves immediately if already terminal", async () => {
      fresh();
      const h = registry.register("w-3");
      h.resolve({ outcome: "success" });
      const settled = await h.wait();
      expect(settled.status).toBe("resolved");
    });

    it("multiple waiters all settle", async () => {
      fresh();
      const h = registry.register("w-4");
      const p1 = h.wait();
      const p2 = h.wait();
      h.resolve({ outcome: "failure", error: "err" });
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.status).toBe("resolved");
      expect(r2.status).toBe("resolved");
    });
  });

  // ---- onTerminal listener ------------------------------------------------

  describe("onTerminal", () => {
    it("fires on resolve", () => {
      fresh();
      const cb = vi.fn<(h: WaitRunHandle) => void>();
      registry.onTerminal(cb);
      const h = registry.register("ev-1");
      h.resolve({ outcome: "success" });
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0].status).toBe("resolved");
    });

    it("fires on cancel", () => {
      fresh();
      const cb = vi.fn<(h: WaitRunHandle) => void>();
      registry.onTerminal(cb);
      const h = registry.register("ev-2");
      h.cancel("reason");
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0].status).toBe("cancelled");
    });

    it("fires on expiry", () => {
      vi.useFakeTimers();
      fresh();
      const cb = vi.fn<(h: WaitRunHandle) => void>();
      registry.onTerminal(cb);
      registry.register("ev-3", { ttlMs: 1_000 });
      vi.advanceTimersByTime(2_000);
      // Trigger lazy check
      registry.list();
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0].status).toBe("expired");
    });

    it("unsubscribe stops future notifications", () => {
      fresh();
      const cb = vi.fn<(h: WaitRunHandle) => void>();
      const unsub = registry.onTerminal(cb);
      unsub();
      registry.register("ev-4").resolve({ outcome: "success" });
      expect(cb).not.toHaveBeenCalled();
    });

    it("listener errors are swallowed", () => {
      fresh();
      const bad = vi.fn<(h: WaitRunHandle) => void>().mockImplementation(() => {
        throw new Error("boom");
      });
      registry.onTerminal(bad);
      // Should not throw
      registry.register("ev-5").resolve({ outcome: "success" });
      expect(bad).toHaveBeenCalled();
    });
  });

  // ---- list ---------------------------------------------------------------

  describe("list", () => {
    it("returns all registered handles", () => {
      fresh();
      registry.register("l-1");
      registry.register("l-2");
      expect(registry.list()).toHaveLength(2);
    });
  });

  // ---- get ----------------------------------------------------------------

  describe("get", () => {
    it("returns the handle if registered", () => {
      fresh();
      const h = registry.register("g-1");
      expect(registry.get("g-1")).toBe(h);
    });

    it("returns undefined for unknown id", () => {
      fresh();
      expect(registry.get("missing")).toBeUndefined();
    });
  });
});
