import { describe, expect, it } from "vitest";
import { HealthTracker } from "../health-tracker.js";

describe("HealthTracker", () => {
  describe("recordResult", () => {
    it("records a successful call", () => {
      const tracker = new HealthTracker(20);
      tracker.recordResult("model-a", { timestamp: Date.now(), success: true, latencyMs: 500 });
      expect(tracker.getHealthScore("model-a")).toBe(1.0);
    });

    it("records a failed call and reduces health score", () => {
      const tracker = new HealthTracker(20);
      tracker.recordResult("model-a", {
        timestamp: Date.now(),
        success: false,
        latencyMs: 500,
        error: "error",
      });
      expect(tracker.getHealthScore("model-a")).toBeLessThan(1.0);
    });

    it("records a timeout call with smaller penalty than failure", () => {
      const trackerTimeout = new HealthTracker(20);
      trackerTimeout.recordResult("model-a", {
        timestamp: Date.now(),
        success: false,
        latencyMs: 500,
        error: "timeout",
      });

      const trackerError = new HealthTracker(20);
      trackerError.recordResult("model-a", {
        timestamp: Date.now(),
        success: false,
        latencyMs: 500,
        error: "error",
      });

      expect(trackerTimeout.getHealthScore("model-a")).toBeGreaterThan(
        trackerError.getHealthScore("model-a"),
      );
    });
  });

  describe("getHealthScore", () => {
    it("returns 1.0 for a model with no data", () => {
      const tracker = new HealthTracker(20);
      expect(tracker.getHealthScore("unknown-model")).toBe(1.0);
    });

    it("returns 1.0 when all results are successful", () => {
      const tracker = new HealthTracker(5);
      for (let i = 0; i < 5; i++) {
        tracker.recordResult("model-a", { timestamp: Date.now(), success: true, latencyMs: 100 });
      }
      expect(tracker.getHealthScore("model-a")).toBe(1.0);
    });

    it("returns minimum score when all results are failures (window=10)", () => {
      const windowSize = 10;
      const tracker = new HealthTracker(windowSize);
      // 10 failures × 0.3/10 = 0.30 penalty → score = 0.70
      for (let i = 0; i < windowSize; i++) {
        tracker.recordResult("model-a", {
          timestamp: Date.now(),
          success: false,
          latencyMs: 100,
          error: "error",
        });
      }
      expect(tracker.getHealthScore("model-a")).toBeCloseTo(0.7, 5);
    });

    it("calculates mixed success/failure correctly", () => {
      const windowSize = 10;
      const tracker = new HealthTracker(windowSize);
      // 5 success + 5 failures
      // penalty = 5 × 0.3/10 = 0.15 → score = 0.85
      for (let i = 0; i < 5; i++) {
        tracker.recordResult("model-a", { timestamp: Date.now(), success: true, latencyMs: 100 });
      }
      for (let i = 0; i < 5; i++) {
        tracker.recordResult("model-a", {
          timestamp: Date.now(),
          success: false,
          latencyMs: 100,
          error: "error",
        });
      }
      const score = tracker.getHealthScore("model-a");
      expect(score).toBeCloseTo(0.85, 5);
    });

    it("applies high-latency penalty for calls over 30s", () => {
      const windowSize = 10;
      const tracker = new HealthTracker(windowSize);
      // 1 successful call with 60s latency: penalty = 0.1/10 * (60000/60000) = 0.01
      tracker.recordResult("model-a", { timestamp: Date.now(), success: true, latencyMs: 60_000 });
      const score = tracker.getHealthScore("model-a");
      expect(score).toBeCloseTo(0.99, 5);
    });

    it("does not apply high-latency penalty for calls under 30s", () => {
      const tracker = new HealthTracker(20);
      tracker.recordResult("model-a", { timestamp: Date.now(), success: true, latencyMs: 29_999 });
      expect(tracker.getHealthScore("model-a")).toBe(1.0);
    });

    it("clamps score to [0, 1]", () => {
      const windowSize = 5;
      const tracker = new HealthTracker(windowSize);
      // More failures than needed to reach 0
      for (let i = 0; i < windowSize; i++) {
        tracker.recordResult("model-a", {
          timestamp: Date.now(),
          success: false,
          latencyMs: 60_000, // extra latency penalty too
          error: "error",
        });
      }
      const score = tracker.getHealthScore("model-a");
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  });

  describe("sliding window", () => {
    it("discards old data beyond windowSize", () => {
      const windowSize = 5;
      const tracker = new HealthTracker(windowSize);

      // Record 5 failures to fill window
      // 5 × 0.3/5 = 0.30 penalty → score = 0.70
      for (let i = 0; i < windowSize; i++) {
        tracker.recordResult("model-a", {
          timestamp: Date.now(),
          success: false,
          latencyMs: 100,
          error: "error",
        });
      }
      // Score should reflect full-failure penalty
      expect(tracker.getHealthScore("model-a")).toBeCloseTo(0.7, 5);

      // Now add 5 successes — they should replace the failures
      for (let i = 0; i < windowSize; i++) {
        tracker.recordResult("model-a", { timestamp: Date.now(), success: true, latencyMs: 100 });
      }
      // Score should be back to 1.0
      expect(tracker.getHealthScore("model-a")).toBe(1.0);
    });

    it("maintains exactly windowSize records", () => {
      const windowSize = 3;
      const tracker = new HealthTracker(windowSize);
      // Record more than windowSize entries
      for (let i = 0; i < 10; i++) {
        tracker.recordResult("model-a", { timestamp: Date.now(), success: true, latencyMs: 100 });
      }
      // All should be healthy (no failures ever added)
      expect(tracker.getHealthScore("model-a")).toBe(1.0);
    });
  });

  describe("isHealthy", () => {
    it("returns true for a healthy model above threshold", () => {
      const tracker = new HealthTracker(20);
      tracker.recordResult("model-a", { timestamp: Date.now(), success: true, latencyMs: 100 });
      expect(tracker.isHealthy("model-a", 0.5)).toBe(true);
    });

    it("returns false for a model below threshold", () => {
      const windowSize = 10;
      const tracker = new HealthTracker(windowSize);
      // 7 failures × 0.3/10 = 0.21 penalty → score = 0.79 < 0.8 (unhealthy)
      for (let i = 0; i < 7; i++) {
        tracker.recordResult("model-a", {
          timestamp: Date.now(),
          success: false,
          latencyMs: 100,
          error: "error",
        });
      }
      expect(tracker.isHealthy("model-a", 0.8)).toBe(false);
    });

    it("returns true for an unknown model (default healthy)", () => {
      const tracker = new HealthTracker(20);
      expect(tracker.isHealthy("unknown", 0.5)).toBe(true);
    });

    it("correctly applies custom threshold", () => {
      const windowSize = 10;
      const tracker = new HealthTracker(windowSize);
      // 2 failures × 0.3/10 = 0.06 penalty → score = 0.94
      for (let i = 0; i < 2; i++) {
        tracker.recordResult("model-a", {
          timestamp: Date.now(),
          success: false,
          latencyMs: 100,
          error: "error",
        });
      }
      expect(tracker.isHealthy("model-a", 0.9)).toBe(true);
      expect(tracker.isHealthy("model-a", 0.95)).toBe(false);
    });
  });

  describe("serialize/deserialize", () => {
    it("round-trips the store via JSON", () => {
      const tracker = new HealthTracker(10);
      tracker.recordResult("model-a", { timestamp: 1000, success: true, latencyMs: 200 });
      tracker.recordResult("model-a", {
        timestamp: 2000,
        success: false,
        latencyMs: 500,
        error: "error",
      });
      tracker.recordResult("model-b", { timestamp: 3000, success: true, latencyMs: 100 });

      const serialized = tracker.serialize();
      expect(typeof serialized).toBe("string");

      const tracker2 = new HealthTracker(10);
      tracker2.deserialize(serialized);

      expect(tracker2.getHealthScore("model-a")).toBeCloseTo(tracker.getHealthScore("model-a"), 10);
      expect(tracker2.getHealthScore("model-b")).toBe(tracker.getHealthScore("model-b"));
    });

    it("serialize produces valid JSON", () => {
      const tracker = new HealthTracker(5);
      tracker.recordResult("x", { timestamp: 1, success: true, latencyMs: 10 });
      expect(() => JSON.parse(tracker.serialize())).not.toThrow();
    });

    it("deserialize clears previous state", () => {
      const tracker = new HealthTracker(10);
      tracker.recordResult("old-model", {
        timestamp: 1,
        success: false,
        latencyMs: 100,
        error: "error",
      });

      const emptyTracker = new HealthTracker(10);
      const emptyData = emptyTracker.serialize();

      tracker.deserialize(emptyData);
      // After deserializing empty data, old-model should have no records → score 1.0
      expect(tracker.getHealthScore("old-model")).toBe(1.0);
    });
  });
});
