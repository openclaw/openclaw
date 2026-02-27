/**
 * Anomaly Detection Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  RollingStats,
  ExponentialMovingAverage,
  AnomalyDetector,
  CredentialAccessDetector,
  resetAnomalyDetectors,
} from "./anomaly-detection.js";
import { querySecurityEvents, resetSecurityEventsManager } from "./security-events.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RollingStats", () => {
  let stats: RollingStats;

  beforeEach(() => {
    stats = new RollingStats(100);
  });

  describe("basic statistics", () => {
    it("should compute mean correctly", () => {
      stats.add(10);
      stats.add(20);
      stats.add(30);

      const result = stats.getStats();
      expect(result.mean).toBe(20);
    });

    it("should compute standard deviation correctly", () => {
      // Values: 2, 4, 4, 4, 5, 5, 7, 9
      // Mean: 5, Variance: 4, StdDev: 2
      const values = [2, 4, 4, 4, 5, 5, 7, 9];
      for (const v of values) {
        stats.add(v);
      }

      const result = stats.getStats();
      expect(result.mean).toBe(5);
      expect(result.stdDev).toBeCloseTo(2, 5);
    });

    it("should track min and max", () => {
      stats.add(5);
      stats.add(1);
      stats.add(10);
      stats.add(3);

      const result = stats.getStats();
      expect(result.min).toBe(1);
      expect(result.max).toBe(10);
    });

    it("should track count", () => {
      stats.add(1);
      stats.add(2);
      stats.add(3);

      const result = stats.getStats();
      expect(result.count).toBe(3);
    });

    it("should track last value and timestamp", () => {
      const now = Date.now();
      stats.add(42, now);

      const result = stats.getStats();
      expect(result.lastValue).toBe(42);
      expect(result.lastTimestamp).toBe(now);
    });
  });

  describe("windowed statistics", () => {
    it("should compute windowed mean", () => {
      const smallWindow = new RollingStats(5);

      // Add 10 values, only last 5 should be in window
      for (let i = 1; i <= 10; i++) {
        smallWindow.add(i);
      }

      // Window contains [6, 7, 8, 9, 10], mean = 8
      expect(smallWindow.windowedMean()).toBe(8);
    });

    it("should compute windowed stdDev", () => {
      const smallWindow = new RollingStats(5);

      // Add same value repeatedly
      for (let i = 0; i < 5; i++) {
        smallWindow.add(10);
      }

      expect(smallWindow.windowedStdDev()).toBe(0);
    });
  });

  describe("z-score", () => {
    it("should calculate z-score correctly", () => {
      // Create a known distribution
      for (let i = 0; i < 100; i++) {
        stats.add(50); // All same value
      }

      // stdDev is 0, so z-score should be 0
      expect(stats.zScore(50)).toBe(0);
      expect(stats.zScore(100)).toBe(0); // Can't compute with 0 stdDev
    });

    it("should calculate z-score for varied data", () => {
      // Add values with mean ~50 and known spread
      const values = [40, 45, 50, 55, 60];
      for (const v of values) {
        stats.add(v);
      }

      const mean = stats.windowedMean();
      const stdDev = stats.windowedStdDev();

      // Z-score of 50 (the mean) should be ~0
      expect(stats.zScore(50)).toBeCloseTo(0, 1);

      // Z-score of value 2 std devs above mean
      const twoSigma = mean + 2 * stdDev;
      expect(stats.zScore(twoSigma)).toBeCloseTo(2, 1);
    });
  });

  describe("reset", () => {
    it("should reset all statistics", () => {
      stats.add(10);
      stats.add(20);
      stats.reset();

      const result = stats.getStats();
      expect(result.count).toBe(0);
      expect(result.mean).toBe(0);
      expect(result.min).toBe(0);
      expect(result.max).toBe(0);
      expect(result.lastValue).toBeNull();
    });
  });

  describe("NumericRingBuffer O(1) window (BP-13)", () => {
    it("windowedMean stays correct after window wraps", () => {
      // windowSize=3; push 5 values — only last 3 should count
      const narrow = new RollingStats(3);
      narrow.add(1);
      narrow.add(2);
      narrow.add(3);
      narrow.add(4); // evicts 1
      narrow.add(5); // evicts 2

      // Window should contain [3, 4, 5]
      expect(narrow.windowedMean()).toBeCloseTo((3 + 4 + 5) / 3, 5);
    });

    it("windowedStdDev stays correct after window wraps", () => {
      const narrow = new RollingStats(4);
      for (let i = 1; i <= 6; i++) {
        narrow.add(i);
      }
      // Window = [3, 4, 5, 6]; mean = 4.5; var = (2.25+0.25+0.25+2.25)/4 = 1.25
      expect(narrow.windowedStdDev()).toBeCloseTo(Math.sqrt(1.25), 4);
    });

    it("reset clears the ring buffer — windowedMean returns 0 after reset", () => {
      const s = new RollingStats(10);
      for (let i = 0; i < 8; i++) {
        s.add(42);
      }
      s.reset();
      expect(s.windowedMean()).toBe(0);
      expect(s.windowedStdDev()).toBe(0);
    });

    it("window eviction does not affect Welford global count/mean", () => {
      // Add 10 values [1..10] into a window of 3.
      const s = new RollingStats(3);
      for (let i = 1; i <= 10; i++) {
        s.add(i);
      }
      // Welford tracks all 10; window only has the last 3.
      expect(s.getStats().count).toBe(10);
      expect(s.windowedMean()).toBeCloseTo((8 + 9 + 10) / 3, 5);
    });
  });
});

describe("ExponentialMovingAverage", () => {
  it("should initialize to first value", () => {
    const ema = new ExponentialMovingAverage(0.1);
    ema.update(100);

    expect(ema.get()).toBe(100);
  });

  it("should apply decay factor", () => {
    const ema = new ExponentialMovingAverage(0.5);
    ema.update(100);
    ema.update(0);

    // EMA = 0.5 * 0 + 0.5 * 100 = 50
    expect(ema.get()).toBe(50);
  });

  it("should converge to constant value", () => {
    const ema = new ExponentialMovingAverage(0.1);

    // Start at 0, then constant 100
    ema.update(0);
    for (let i = 0; i < 100; i++) {
      ema.update(100);
    }

    // Should be very close to 100
    expect(ema.get()).toBeGreaterThan(99);
  });

  it("should reject invalid decay factors", () => {
    expect(() => new ExponentialMovingAverage(0)).toThrow();
    expect(() => new ExponentialMovingAverage(-0.1)).toThrow();
    expect(() => new ExponentialMovingAverage(1.5)).toThrow();
  });

  it("should reset correctly", () => {
    const ema = new ExponentialMovingAverage(0.1);
    ema.update(100);
    ema.reset();

    expect(ema.get()).toBeNull();
  });
});

describe("AnomalyDetector", () => {
  let detector: AnomalyDetector;

  beforeEach(() => {
    resetAnomalyDetectors();
    resetSecurityEventsManager();
    detector = new AnomalyDetector({
      enabled: true,
      sensitivity: 3.0,
      minDataPoints: 10,
      windowSize: 100,
    });
  });

  describe("record", () => {
    it("should not flag anomaly before minimum data points", () => {
      for (let i = 0; i < 5; i++) {
        const result = detector.record("test_metric", 100);
        expect(result.isAnomaly).toBe(false);
      }
    });

    it("should not flag normal values as anomalies", () => {
      // Build deterministic baseline (values in [50..60] range)
      const baseline = [
        50, 53, 57, 51, 59, 54, 52, 58, 56, 50, 53, 57, 51, 59, 54, 52, 58, 56, 55, 54,
      ];
      for (const v of baseline) {
        detector.record("test_metric", v);
      }

      // Record normal value
      const result = detector.record("test_metric", 55);

      expect(result.isAnomaly).toBe(false);
      expect(Math.abs(result.zScore)).toBeLessThan(3);
    });

    it("should flag extreme values as anomalies", () => {
      // Build deterministic baseline with small variance (values in [50..52] range)
      const baseline = [
        50.0, 51.2, 50.4, 51.8, 50.6, 51.0, 50.2, 51.6, 50.8, 51.4, 50.1, 51.3, 50.5, 51.9, 50.7,
        51.1, 50.3, 51.7, 50.9, 51.5, 50.0, 51.2, 50.4, 51.8, 50.6, 51.0, 50.2, 51.6, 50.8, 51.4,
        50.1, 51.3, 50.5, 51.9, 50.7, 51.1, 50.3, 51.7, 50.9, 51.5, 50.0, 51.2, 50.4, 51.8, 50.6,
        51.0, 50.2, 51.6, 50.8, 51.4,
      ];
      for (const v of baseline) {
        detector.record("test_metric", v);
      }

      // Record extreme value (way outside normal range)
      const result = detector.record("test_metric", 200);

      expect(result.isAnomaly).toBe(true);
      expect(Math.abs(result.zScore)).toBeGreaterThan(3);
    });

    it("should track different metrics separately", () => {
      // Build deterministic baseline for metric A (around 100, range [100..105])
      const baselineA = [
        100, 102, 104, 101, 103, 100, 102, 104, 101, 103, 100, 102, 104, 101, 103, 105, 100, 102,
        104, 101,
      ];
      for (const v of baselineA) {
        detector.record("metric_a", v);
      }

      // Build deterministic baseline for metric B (around 10, range [10..12])
      const baselineB = [
        10, 11, 10, 12, 11, 10, 11, 10, 12, 11, 10, 11, 10, 12, 11, 10, 11, 10, 12, 11,
      ];
      for (const v of baselineB) {
        detector.record("metric_b", v);
      }

      // Value 100 is normal for A but anomaly for B
      const resultA = detector.record("metric_a", 100);
      const resultB = detector.record("metric_b", 100);

      expect(resultA.isAnomaly).toBe(false);
      expect(resultB.isAnomaly).toBe(true);
    });
  });

  describe("recordBatch", () => {
    it("should record multiple metrics at once", () => {
      // Build deterministic baselines
      const cpuVals = [
        50, 53, 57, 51, 59, 54, 52, 58, 56, 55, 50, 53, 57, 51, 59, 54, 52, 58, 56, 55,
      ];
      const memVals = [
        70, 72, 74, 71, 73, 70, 72, 74, 71, 73, 70, 72, 74, 71, 73, 70, 72, 74, 71, 73,
      ];
      for (let i = 0; i < 20; i++) {
        detector.recordBatch({
          cpu: cpuVals[i],
          memory: memVals[i],
        });
      }

      const results = detector.recordBatch({
        cpu: 55,
        memory: 72,
      });

      expect(results.cpu).toBeDefined();
      expect(results.memory).toBeDefined();
    });
  });

  describe("getMetricStats", () => {
    it("should return null for unknown metric", () => {
      expect(detector.getMetricStats("unknown")).toBeNull();
    });

    it("should return stats for tracked metric", () => {
      detector.record("test", 100);

      const stats = detector.getMetricStats("test");
      expect(stats).not.toBeNull();
      expect(stats!.count).toBe(1);
      expect(stats!.mean).toBe(100);
    });
  });

  describe("getTrackedMetrics", () => {
    it("should return all tracked metric names", () => {
      detector.record("metric_a", 1);
      detector.record("metric_b", 2);
      detector.record("metric_c", 3);

      const metrics = detector.getTrackedMetrics();
      expect(metrics).toHaveLength(3);
      expect(metrics).toContain("metric_a");
      expect(metrics).toContain("metric_b");
      expect(metrics).toContain("metric_c");
    });
  });

  describe("enabled flag", () => {
    it("should not flag anomalies when disabled", () => {
      const disabledDetector = new AnomalyDetector({
        enabled: false,
        sensitivity: 3.0,
        minDataPoints: 10,
      });

      // Build baseline
      for (let i = 0; i < 50; i++) {
        disabledDetector.record("test", 50);
      }

      // Extreme value should not be flagged
      const result = disabledDetector.record("test", 500);

      expect(result.isAnomaly).toBe(false);
    });
  });

  describe("sensitivity", () => {
    it("should respect custom sensitivity threshold", () => {
      const sensitiveDetector = new AnomalyDetector({
        enabled: true,
        sensitivity: 1.5, // More sensitive
        minDataPoints: 10,
      });

      // Build deterministic baseline with low variance (values in [50..51] range)
      const baseline = [
        50.0, 50.2, 50.4, 50.6, 50.8, 50.1, 50.3, 50.5, 50.7, 50.9, 50.0, 50.2, 50.4, 50.6, 50.8,
        50.1, 50.3, 50.5, 50.7, 50.9,
      ];
      for (const v of baseline) {
        sensitiveDetector.record("test", v);
      }

      // Value far enough above baseline to deterministically exceed 1.5 sigma
      const result = sensitiveDetector.record("test", 55);

      expect(Math.abs(result.zScore)).toBeGreaterThanOrEqual(1.5);
      expect(result.isAnomaly).toBe(true);
    });
  });

  describe("updateConfig", () => {
    it("should update sensitivity at runtime", () => {
      detector.updateConfig({ sensitivity: 10 });

      // Build baseline
      for (let i = 0; i < 20; i++) {
        detector.record("test", 50);
      }

      // Extreme value but with high threshold
      const result = detector.record("test", 100);

      // With threshold of 10, unlikely to flag
      expect(result.isAnomaly).toBe(false);
    });
  });

  describe("reset", () => {
    it("should reset specific metric", () => {
      detector.record("metric_a", 100);
      detector.record("metric_b", 200);

      detector.resetMetric("metric_a");

      expect(detector.getMetricStats("metric_a")).toBeNull();
      expect(detector.getMetricStats("metric_b")).not.toBeNull();
    });

    it("should reset all metrics", () => {
      detector.record("metric_a", 100);
      detector.record("metric_b", 200);

      detector.resetAll();

      expect(detector.getTrackedMetrics()).toHaveLength(0);
    });
  });
});

describe("CredentialAccessDetector", () => {
  let detector: CredentialAccessDetector;

  beforeEach(() => {
    resetAnomalyDetectors();
    resetSecurityEventsManager();
    detector = new CredentialAccessDetector({
      enabled: true,
      sensitivity: 2.5,
      minDataPoints: 5,
    });
  });

  it("should record credential access", () => {
    const result = detector.recordAccess("api_key", "provider");

    // First access, no anomaly check yet
    expect(result).toBeNull();
  });

  it("should flush aggregated access counts per credential and scope", () => {
    const nowSpy = vi.spyOn(Date, "now");
    let now = 1_020_000; // Aligned to 60s boundary for deterministic bucket math.
    nowSpy.mockImplementation(() => now);

    for (let i = 0; i < 10; i++) {
      detector.recordAccess("api_key", "provider");
    }
    for (let i = 0; i < 4; i++) {
      detector.recordAccess("api_key", "cli");
    }
    for (let i = 0; i < 3; i++) {
      detector.recordAccess("service_key", "provider");
    }

    // Move to the next bucket boundary so flush records pending counts.
    now += 60_000;
    detector.flush();

    const providerApiStats = detector.getAccessStats("api_key", "provider");
    const cliApiStats = detector.getAccessStats("api_key", "cli");
    const providerServiceStats = detector.getAccessStats("service_key", "provider");

    expect(providerApiStats).not.toBeNull();
    expect(providerApiStats!.count).toBe(1);
    expect(providerApiStats!.mean).toBe(10);
    expect(providerApiStats!.stdDev).toBe(0);
    expect(providerApiStats!.lastValue).toBe(10);

    expect(cliApiStats).not.toBeNull();
    expect(cliApiStats!.count).toBe(1);
    expect(cliApiStats!.mean).toBe(4);
    expect(cliApiStats!.stdDev).toBe(0);

    expect(providerServiceStats).not.toBeNull();
    expect(providerServiceStats!.count).toBe(1);
    expect(providerServiceStats!.mean).toBe(3);
    expect(providerServiceStats!.stdDev).toBe(0);

    expect(querySecurityEvents({ type: "credential_access_spike" })).toHaveLength(0);
  });

  it("should not flush a current bucket before the interval boundary", () => {
    const nowSpy = vi.spyOn(Date, "now");
    const now = 1_020_000; // Aligned to 60s boundary for deterministic bucket math.
    nowSpy.mockImplementation(() => now);

    for (let i = 0; i < 10; i++) {
      detector.recordAccess("api_key", "provider");
    }

    detector.flush();

    expect(detector.getAccessStats("api_key", "provider")).toBeNull();
    expect(querySecurityEvents({ type: "credential_access_spike" })).toHaveLength(0);
  });

  it("should emit credential_access_spike when a bucket spikes after baseline", () => {
    const nowSpy = vi.spyOn(Date, "now");
    let now = 1_020_000; // Aligned to 60s boundary for deterministic bucket math.
    nowSpy.mockImplementation(() => now);

    const sensitiveDetector = new CredentialAccessDetector({
      enabled: true,
      sensitivity: 2.0,
      minDataPoints: 5,
    });

    // Baseline: five stable buckets at 1 access/minute.
    for (let bucket = 0; bucket < 5; bucket++) {
      sensitiveDetector.recordAccess("api_key", "provider");
      now += 60_000;
      sensitiveDetector.flush();
    }

    expect(querySecurityEvents({ type: "credential_access_spike" })).toHaveLength(0);

    // Spike bucket: 20 accesses in one minute.
    for (let i = 0; i < 20; i++) {
      sensitiveDetector.recordAccess("api_key", "provider");
    }
    now += 60_000;
    const bucketStart = now - 60_000;
    const bucketEnd = now;
    sensitiveDetector.flush();

    const spikeEvents = querySecurityEvents({ type: "credential_access_spike" });
    expect(spikeEvents).toHaveLength(1);

    const [event] = spikeEvents;
    const details = event.details as {
      credential?: string;
      accessCount?: number;
      zScore?: number;
      mean?: number;
      stdDev?: number;
    };

    expect(event.type).toBe("credential_access_spike");
    expect(event.ts).toBeGreaterThanOrEqual(bucketStart);
    expect(event.ts).toBeLessThanOrEqual(bucketEnd);
    expect(event.source).toBe("anomaly-detection");
    expect(event.message).toContain("provider:api_key");
    expect(event.message).toContain("20");
    expect(event.message).toMatch(/access(?:es)?\/minute/i);
    expect(event.remediation).toBe("Investigate the source of credential access requests");
    expect(["warn", "critical"]).toContain(event.severity);
    expect(details.credential).toBe("provider:api_key");
    expect(details.accessCount).toBe(20);
    expect(details.zScore).toBeDefined();
    expect(Number.isFinite(details.zScore)).toBe(true);
    expect(details.mean).toBeDefined();
    expect(Number.isFinite(details.mean)).toBe(true);
    expect(details.stdDev).toBeDefined();
    expect(Number.isFinite(details.stdDev)).toBe(true);
    expect(Math.abs(details.zScore!)).toBeGreaterThanOrEqual(2);
  });

  it("should not double-emit on repeated flush with no new records", () => {
    const nowSpy = vi.spyOn(Date, "now");
    let now = 1_020_000; // Aligned to 60s boundary for deterministic bucket math.
    nowSpy.mockImplementation(() => now);

    const sensitiveDetector = new CredentialAccessDetector({
      enabled: true,
      sensitivity: 2.0,
      minDataPoints: 5,
    });

    for (let bucket = 0; bucket < 5; bucket++) {
      sensitiveDetector.recordAccess("api_key", "provider");
      now += 60_000;
      sensitiveDetector.flush();
    }

    for (let i = 0; i < 20; i++) {
      sensitiveDetector.recordAccess("api_key", "provider");
    }
    now += 60_000;
    sensitiveDetector.flush();

    const eventsAfterFirstFlush = querySecurityEvents({ type: "credential_access_spike" });
    expect(eventsAfterFirstFlush).toHaveLength(1);
    const eventCountAfterFirstFlush = eventsAfterFirstFlush.length;
    const firstEventDetails = eventsAfterFirstFlush[0].details as {
      credential?: string;
      accessCount?: number;
    };

    sensitiveDetector.flush();

    const eventsAfterSecondFlush = querySecurityEvents({ type: "credential_access_spike" });
    expect(eventsAfterSecondFlush).toHaveLength(eventCountAfterFirstFlush);
    const secondEventDetails = eventsAfterSecondFlush[0].details as {
      credential?: string;
      accessCount?: number;
    };
    expect(secondEventDetails.credential).toBe(firstEventDetails.credential);
    expect(secondEventDetails.accessCount).toBe(firstEventDetails.accessCount);
  });

  it("should isolate anomaly detection by scope and credential key", () => {
    const nowSpy = vi.spyOn(Date, "now");
    let now = 1_020_000; // Aligned to 60s boundary for deterministic bucket math.
    nowSpy.mockImplementation(() => now);

    const sensitiveDetector = new CredentialAccessDetector({
      enabled: true,
      sensitivity: 2.0,
      minDataPoints: 5,
    });

    // Build independent baselines for both partitions.
    for (let bucket = 0; bucket < 5; bucket++) {
      sensitiveDetector.recordAccess("api_key", "provider");
      sensitiveDetector.recordAccess("api_key", "cli");
      now += 60_000;
      sensitiveDetector.flush();
    }

    // Spike only one partition.
    for (let i = 0; i < 20; i++) {
      sensitiveDetector.recordAccess("api_key", "cli");
    }
    sensitiveDetector.recordAccess("api_key", "provider");
    now += 60_000;
    sensitiveDetector.flush();

    const spikeEvents = querySecurityEvents({ type: "credential_access_spike" });
    expect(spikeEvents).toHaveLength(1);

    const [spikeEvent] = spikeEvents;
    const spikeDetails = spikeEvent.details as { credential?: string; accessCount?: number };
    expect(spikeDetails.credential).toBe("cli:api_key");
    expect(spikeDetails.accessCount).toBe(20);
    expect(
      spikeEvents.some((event) => {
        const details = event.details as { credential?: string };
        return details.credential === "provider:api_key";
      }),
    ).toBe(false);
  });

  it("should return null and emit no events when disabled", () => {
    const disabledDetector = new CredentialAccessDetector({
      enabled: false,
    });

    expect(disabledDetector.recordAccess("key", "scope")).toBeNull();
    disabledDetector.flush();

    expect(disabledDetector.getAccessStats("key", "scope")).toBeNull();
    expect(querySecurityEvents({ type: "credential_access_spike" })).toHaveLength(0);
  });
});
