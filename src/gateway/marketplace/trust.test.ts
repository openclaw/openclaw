import { describe, it, expect, beforeEach } from "vitest";
import { TrustManager } from "./trust.js";

describe("TrustManager", () => {
  let trust: TrustManager;

  beforeEach(() => {
    trust = new TrustManager();
  });

  describe("getScore", () => {
    it("returns initial score of 50 for new node", () => {
      const score = trust.getScore("node-1");
      expect(score.score).toBe(50);
      expect(score.successCount).toBe(0);
      expect(score.failureCount).toBe(0);
      expect(score.flags).toEqual([]);
    });

    it("returns same object on subsequent calls", () => {
      const first = trust.getScore("node-1");
      first.successCount = 5;
      const second = trust.getScore("node-1");
      expect(second.successCount).toBe(5);
    });
  });

  describe("recordSuccess", () => {
    it("increments success count", () => {
      trust.recordSuccess("node-1", 3000, 1000, 500);
      expect(trust.getScore("node-1").successCount).toBe(1);
    });

    it("increases score via EMA toward 90", () => {
      const initial = trust.getScore("node-1").score;
      trust.recordSuccess("node-1", 3000, 1000, 500);
      expect(trust.getScore("node-1").score).toBeGreaterThan(initial);
    });

    it("gives speed bonus for fast responses under 5s", () => {
      trust.recordSuccess("node-fast", 2000, 1000, 500);
      trust.recordSuccess("node-slow", 10000, 1000, 500);
      expect(trust.getScore("node-fast").score).toBeGreaterThan(trust.getScore("node-slow").score);
    });

    it("updates average response time", () => {
      trust.recordSuccess("node-1", 5000, 1000, 500);
      expect(trust.getScore("node-1").avgResponseMs).toBe(5000);

      trust.recordSuccess("node-1", 3000, 1000, 500);
      // Average of 5000 and 3000 weighted by request count
      expect(trust.getScore("node-1").avgResponseMs).toBeCloseTo(4000, 0);
    });

    it("flags token_count_anomaly for extreme output/input ratio", () => {
      trust.recordSuccess("node-1", 3000, 10, 1000);
      // ratio = 1000/10 = 100 > 50 threshold
      expect(trust.getScore("node-1").flags).toContain("token_count_anomaly");
    });

    it("clears token_count_anomaly when ratio normalizes", () => {
      trust.recordSuccess("node-1", 3000, 10, 1000);
      expect(trust.getScore("node-1").flags).toContain("token_count_anomaly");
      trust.recordSuccess("node-1", 3000, 1000, 500);
      expect(trust.getScore("node-1").flags).not.toContain("token_count_anomaly");
    });
  });

  describe("recordFailure", () => {
    it("increments failure count", () => {
      trust.recordFailure("node-1");
      expect(trust.getScore("node-1").failureCount).toBe(1);
    });

    it("decreases score via EMA toward 10", () => {
      // First raise the score above initial.
      for (let i = 0; i < 5; i++) {
        trust.recordSuccess("node-1", 3000, 1000, 500);
      }
      const before = trust.getScore("node-1").score;
      trust.recordFailure("node-1");
      expect(trust.getScore("node-1").score).toBeLessThan(before);
    });

    it("flags high_failure_rate after enough failures", () => {
      // Need at least 5 total requests for flags to update.
      for (let i = 0; i < 2; i++) {
        trust.recordSuccess("node-1", 3000, 1000, 500);
      }
      for (let i = 0; i < 4; i++) {
        trust.recordFailure("node-1");
      }
      // 4 failures out of 6 total = 66% > 30% threshold
      expect(trust.getScore("node-1").flags).toContain("high_failure_rate");
    });
  });

  describe("isEligible", () => {
    it("returns true for unknown nodes (new sellers)", () => {
      expect(trust.isEligible("new-node")).toBe(true);
    });

    it("returns true when score is above threshold", () => {
      trust.recordSuccess("node-1", 3000, 1000, 500);
      expect(trust.isEligible("node-1")).toBe(true);
    });

    it("returns false when score drops below 20", () => {
      // Drive score down with many failures.
      for (let i = 0; i < 50; i++) {
        trust.recordFailure("node-bad");
      }
      expect(trust.getScore("node-bad").score).toBeLessThan(20);
      expect(trust.isEligible("node-bad")).toBe(false);
    });

    it("returns false for suspended nodes", () => {
      trust.suspend("node-1");
      expect(trust.isEligible("node-1")).toBe(false);
    });
  });

  describe("validateNodeVersion", () => {
    it("accepts compatible version", () => {
      expect(trust.validateNodeVersion("node-1", "2.1.0", "2.0.0")).toBe(true);
      expect(trust.getScore("node-1").flags).not.toContain("version_mismatch");
    });

    it("accepts equal version", () => {
      expect(trust.validateNodeVersion("node-1", "2.0.0", "2.0.0")).toBe(true);
    });

    it("rejects older version", () => {
      expect(trust.validateNodeVersion("node-1", "1.9.0", "2.0.0")).toBe(false);
      expect(trust.getScore("node-1").flags).toContain("version_mismatch");
    });

    it("rejects undefined version", () => {
      expect(trust.validateNodeVersion("node-1", undefined, "2.0.0")).toBe(false);
      expect(trust.getScore("node-1").flags).toContain("version_mismatch");
    });

    it("clears version_mismatch flag when updated to compatible", () => {
      trust.validateNodeVersion("node-1", "1.0.0", "2.0.0");
      expect(trust.getScore("node-1").flags).toContain("version_mismatch");
      trust.validateNodeVersion("node-1", "2.0.0", "2.0.0");
      expect(trust.getScore("node-1").flags).not.toContain("version_mismatch");
    });

    it("handles v-prefixed versions", () => {
      expect(trust.validateNodeVersion("node-1", "v2.1.0", "v2.0.0")).toBe(true);
    });
  });

  describe("suspend / unsuspend", () => {
    it("suspend adds flag and blocks eligibility", () => {
      trust.suspend("node-1");
      expect(trust.getScore("node-1").flags).toContain("suspended");
      expect(trust.isEligible("node-1")).toBe(false);
    });

    it("unsuspend removes flag and restores eligibility", () => {
      trust.suspend("node-1");
      trust.unsuspend("node-1");
      expect(trust.getScore("node-1").flags).not.toContain("suspended");
      expect(trust.isEligible("node-1")).toBe(true);
    });
  });

  describe("removeNode", () => {
    it("deletes all trust data for a node", () => {
      trust.recordSuccess("node-1", 3000, 1000, 500);
      trust.removeNode("node-1");
      // After removal, getScore creates a fresh entry.
      expect(trust.getScore("node-1").successCount).toBe(0);
    });
  });

  describe("listScores", () => {
    it("returns all known nodes", () => {
      trust.getScore("node-1");
      trust.getScore("node-2");
      trust.getScore("node-3");
      expect(trust.listScores()).toHaveLength(3);
    });
  });
});
