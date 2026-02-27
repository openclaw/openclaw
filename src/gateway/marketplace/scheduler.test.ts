import { describe, it, expect, beforeEach, vi } from "vitest";
import { MarketplaceScheduler } from "./scheduler.js";

describe("MarketplaceScheduler", () => {
  let scheduler: MarketplaceScheduler;

  beforeEach(() => {
    scheduler = new MarketplaceScheduler();
  });

  describe("updateSellerStatus", () => {
    it("creates a new seller with default values", () => {
      scheduler.updateSellerStatus("node-1", "idle");
      const sellers = scheduler.listSellers();
      expect(sellers).toHaveLength(1);
      expect(sellers[0].nodeId).toBe("node-1");
      expect(sellers[0].status).toBe("idle");
      expect(sellers[0].maxConcurrent).toBe(1);
      expect(sellers[0].performanceScore).toBe(50);
      expect(sellers[0].activeRequests).toBe(0);
    });

    it("updates existing seller status", () => {
      scheduler.updateSellerStatus("node-1", "idle");
      scheduler.updateSellerStatus("node-1", "active");
      const sellers = scheduler.listSellers();
      expect(sellers).toHaveLength(1);
      expect(sellers[0].status).toBe("active");
    });

    it("respects maxConcurrent from meta", () => {
      scheduler.updateSellerStatus("node-1", "idle", { maxConcurrent: 3 });
      const sellers = scheduler.listSellers();
      expect(sellers[0].maxConcurrent).toBe(3);
    });

    it("sets lastIdleAtMs when status becomes idle", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      scheduler.updateSellerStatus("node-1", "idle");
      const sellers = scheduler.listSellers();
      expect(sellers[0].lastIdleAtMs).toBe(new Date("2026-01-01T00:00:00Z").getTime());
      vi.useRealTimers();
    });
  });

  describe("removeSeller", () => {
    it("removes a seller from the pool", () => {
      scheduler.updateSellerStatus("node-1", "idle");
      scheduler.updateSellerStatus("node-2", "idle");
      scheduler.removeSeller("node-1");
      const sellers = scheduler.listSellers();
      expect(sellers).toHaveLength(1);
      expect(sellers[0].nodeId).toBe("node-2");
    });

    it("is a no-op for unknown node", () => {
      scheduler.removeSeller("unknown");
      expect(scheduler.listSellers()).toHaveLength(0);
    });
  });

  describe("pickSeller", () => {
    it("returns null when no sellers available", () => {
      expect(scheduler.pickSeller()).toBeNull();
    });

    it("returns null when all sellers are active", () => {
      scheduler.updateSellerStatus("node-1", "active");
      scheduler.updateSellerStatus("node-2", "active");
      expect(scheduler.pickSeller()).toBeNull();
    });

    it("picks an idle seller", () => {
      scheduler.updateSellerStatus("node-1", "active");
      scheduler.updateSellerStatus("node-2", "idle");
      const picked = scheduler.pickSeller();
      expect(picked).not.toBeNull();
      expect(picked!.nodeId).toBe("node-2");
    });

    it("prefers higher performance score", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

      scheduler.updateSellerStatus("node-low", "idle");
      scheduler.updateSellerStatus("node-high", "idle");

      // Boost node-high's score via successful completions.
      for (let i = 0; i < 10; i++) {
        scheduler.releaseSeller("node-high", true, 2000);
        // Re-idle it after each release.
        scheduler.updateSellerStatus("node-high", "idle");
      }

      const picked = scheduler.pickSeller();
      expect(picked).not.toBeNull();
      expect(picked!.nodeId).toBe("node-high");
      vi.useRealTimers();
    });

    it("prefers longest-idle when scores are equal", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      scheduler.updateSellerStatus("node-first", "idle");

      vi.setSystemTime(new Date("2026-01-01T01:00:00Z"));
      scheduler.updateSellerStatus("node-second", "idle");

      const picked = scheduler.pickSeller();
      expect(picked).not.toBeNull();
      expect(picked!.nodeId).toBe("node-first");
      vi.useRealTimers();
    });

    it("skips sellers at max concurrent", () => {
      scheduler.updateSellerStatus("node-1", "idle", { maxConcurrent: 1 });
      scheduler.reserveSeller("node-1");
      scheduler.updateSellerStatus("node-2", "idle");

      const picked = scheduler.pickSeller();
      expect(picked).not.toBeNull();
      expect(picked!.nodeId).toBe("node-2");
    });
  });

  describe("reserveSeller", () => {
    it("increments active request count", () => {
      scheduler.updateSellerStatus("node-1", "idle", { maxConcurrent: 2 });
      expect(scheduler.reserveSeller("node-1")).toBe(true);
      const sellers = scheduler.listSellers();
      expect(sellers[0].activeRequests).toBe(1);
    });

    it("transitions to sharing when at max concurrent", () => {
      scheduler.updateSellerStatus("node-1", "idle", { maxConcurrent: 1 });
      scheduler.reserveSeller("node-1");
      const sellers = scheduler.listSellers();
      expect(sellers[0].status).toBe("sharing");
    });

    it("returns false when at max concurrent", () => {
      scheduler.updateSellerStatus("node-1", "idle", { maxConcurrent: 1 });
      scheduler.reserveSeller("node-1");
      expect(scheduler.reserveSeller("node-1")).toBe(false);
    });

    it("returns false for unknown node", () => {
      expect(scheduler.reserveSeller("unknown")).toBe(false);
    });
  });

  describe("releaseSeller", () => {
    it("decrements active request count", () => {
      scheduler.updateSellerStatus("node-1", "idle", { maxConcurrent: 2 });
      scheduler.reserveSeller("node-1");
      scheduler.releaseSeller("node-1", true, 3000);
      const sellers = scheduler.listSellers();
      expect(sellers[0].activeRequests).toBe(0);
    });

    it("boosts score on success", () => {
      scheduler.updateSellerStatus("node-1", "idle");
      const initialScore = scheduler.listSellers()[0].performanceScore;
      scheduler.reserveSeller("node-1");
      scheduler.releaseSeller("node-1", true, 3000);
      expect(scheduler.listSellers()[0].performanceScore).toBeGreaterThan(initialScore);
    });

    it("gives speed bonus for fast responses", () => {
      scheduler.updateSellerStatus("node-fast", "idle");
      scheduler.updateSellerStatus("node-slow", "idle");

      scheduler.reserveSeller("node-fast");
      scheduler.releaseSeller("node-fast", true, 2000);

      scheduler.reserveSeller("node-slow");
      scheduler.releaseSeller("node-slow", true, 10000);

      const fast = scheduler.listSellers().find((s) => s.nodeId === "node-fast")!;
      const slow = scheduler.listSellers().find((s) => s.nodeId === "node-slow")!;
      expect(fast.performanceScore).toBeGreaterThan(slow.performanceScore);
    });

    it("reduces score on failure", () => {
      scheduler.updateSellerStatus("node-1", "idle");
      const initialScore = scheduler.listSellers()[0].performanceScore;
      scheduler.reserveSeller("node-1");
      scheduler.releaseSeller("node-1", false);
      expect(scheduler.listSellers()[0].performanceScore).toBeLessThan(initialScore);
    });

    it("transitions from sharing back to idle when all requests complete", () => {
      scheduler.updateSellerStatus("node-1", "idle", { maxConcurrent: 1 });
      scheduler.reserveSeller("node-1");
      expect(scheduler.listSellers()[0].status).toBe("sharing");
      scheduler.releaseSeller("node-1", true, 5000);
      expect(scheduler.listSellers()[0].status).toBe("idle");
    });

    it("is a no-op for unknown node", () => {
      scheduler.releaseSeller("unknown", true); // Should not throw.
    });

    it("does not go below zero active requests", () => {
      scheduler.updateSellerStatus("node-1", "idle");
      scheduler.releaseSeller("node-1", true);
      expect(scheduler.listSellers()[0].activeRequests).toBe(0);
    });
  });

  describe("handleSellerBecameActive", () => {
    it("sets status to active", () => {
      scheduler.updateSellerStatus("node-1", "idle");
      scheduler.handleSellerBecameActive("node-1");
      expect(scheduler.listSellers()[0].status).toBe("active");
    });

    it("is a no-op for unknown node", () => {
      scheduler.handleSellerBecameActive("unknown"); // Should not throw.
    });
  });

  describe("availableCount", () => {
    it("returns zero when no sellers", () => {
      expect(scheduler.availableCount()).toBe(0);
    });

    it("counts only idle sellers with capacity", () => {
      scheduler.updateSellerStatus("node-idle", "idle");
      scheduler.updateSellerStatus("node-active", "active");
      scheduler.updateSellerStatus("node-full", "idle", { maxConcurrent: 1 });
      scheduler.reserveSeller("node-full");
      expect(scheduler.availableCount()).toBe(1);
    });
  });

  describe("syncFromNodeSession", () => {
    it("registers a marketplace-enabled session", () => {
      scheduler.syncFromNodeSession({
        nodeId: "node-1",
        marketplaceEnabled: true,
        marketplaceStatus: "idle",
        marketplaceMaxConcurrent: 2,
      } as Parameters<MarketplaceScheduler["syncFromNodeSession"]>[0]);
      const sellers = scheduler.listSellers();
      expect(sellers).toHaveLength(1);
      expect(sellers[0].maxConcurrent).toBe(2);
    });

    it("skips non-marketplace sessions", () => {
      scheduler.syncFromNodeSession({
        nodeId: "node-1",
        marketplaceEnabled: false,
      } as Parameters<MarketplaceScheduler["syncFromNodeSession"]>[0]);
      expect(scheduler.listSellers()).toHaveLength(0);
    });
  });
});
