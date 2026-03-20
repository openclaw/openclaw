import { describe, expect, it, vi } from "vitest";

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockEmitOagEvent = vi.fn();
vi.mock("./oag-event-bus.js", () => ({
  emitOagEvent: (...args: unknown[]) => mockEmitOagEvent(...args),
}));

import {
  computeBaseline,
  detectAnomaly,
  detectAnomalies,
  linearSlope,
  linearSlopeTimeWeighted,
  predictBreach,
} from "./oag-anomaly.js";
import type { MetricSnapshot } from "./oag-memory.js";

describe("computeBaseline", () => {
  it("returns zeros for empty array", () => {
    const baseline = computeBaseline([]);
    expect(baseline).toEqual({ mean: 0, stdDev: 0, sampleCount: 0 });
  });

  it("returns correct values for single value", () => {
    const baseline = computeBaseline([42]);
    expect(baseline.mean).toBe(42);
    expect(baseline.stdDev).toBe(0);
    expect(baseline.sampleCount).toBe(1);
  });

  it("computes mean and stdDev for multiple values", () => {
    const baseline = computeBaseline([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(baseline.mean).toBe(5);
    expect(baseline.stdDev).toBeCloseTo(2, 0);
    expect(baseline.sampleCount).toBe(8);
  });

  it("handles large dataset", () => {
    const values = Array.from({ length: 1000 }, (_, i) => i);
    const baseline = computeBaseline(values);
    expect(baseline.mean).toBeCloseTo(499.5, 1);
    expect(baseline.sampleCount).toBe(1000);
    expect(baseline.stdDev).toBeGreaterThan(0);
  });
});

describe("detectAnomaly", () => {
  it("reports normal when zScore is below threshold", () => {
    const baseline = computeBaseline([10, 10, 10, 10, 10]);
    const result = detectAnomaly(10, baseline);
    expect(result.anomalous).toBe(false);
    expect(result.direction).toBe("normal");
    expect(result.zScore).toBe(0);
  });

  it("detects spike when zScore exceeds positive threshold", () => {
    const baseline = { mean: 10, stdDev: 2, sampleCount: 24 };
    // current = 20, zScore = (20-10)/2 = 5
    const result = detectAnomaly(20, baseline);
    expect(result.anomalous).toBe(true);
    expect(result.direction).toBe("spike");
    expect(result.zScore).toBe(5);
  });

  it("detects drop when zScore is below negative threshold", () => {
    const baseline = { mean: 10, stdDev: 2, sampleCount: 24 };
    // current = 2, zScore = (2-10)/2 = -4
    const result = detectAnomaly(2, baseline);
    expect(result.anomalous).toBe(true);
    expect(result.direction).toBe("drop");
    expect(result.zScore).toBe(-4);
  });

  it("handles zero stdDev with deviation from mean", () => {
    const baseline = { mean: 5, stdDev: 0, sampleCount: 10 };
    const result = detectAnomaly(10, baseline);
    expect(result.anomalous).toBe(true);
    expect(result.direction).toBe("spike");
    expect(result.zScore).toBe(Infinity);
  });

  it("handles zero stdDev with no deviation", () => {
    const baseline = { mean: 5, stdDev: 0, sampleCount: 10 };
    const result = detectAnomaly(5, baseline);
    expect(result.anomalous).toBe(false);
    expect(result.direction).toBe("normal");
    expect(result.zScore).toBe(0);
  });
});

describe("detectAnomalies", () => {
  function makeSeries(count: number, metrics: Record<string, number>): MetricSnapshot[] {
    return Array.from({ length: count }, (_, i) => ({
      timestamp: new Date(Date.now() - (count - i) * 3600_000).toISOString(),
      uptimeMs: i * 3600_000,
      metrics: { ...metrics },
    }));
  }

  it("skips when fewer than minSamples (24)", () => {
    const series = makeSeries(10, { channelRestarts: 5 });
    const results = detectAnomalies({ channelRestarts: 100 }, series);
    expect(results).toEqual([]);
  });

  it("returns anomalies for multiple metrics", () => {
    mockEmitOagEvent.mockClear();
    const series = makeSeries(30, { channelRestarts: 5, deliveryRecoveries: 10 });
    // channelRestarts: mean=5, current=50 -> anomalous spike
    // deliveryRecoveries: mean=10, current=100 -> anomalous spike
    const results = detectAnomalies({ channelRestarts: 50, deliveryRecoveries: 100 }, series);
    expect(results.length).toBe(2);
    expect(results.map((r) => r.metric)).toContain("channelRestarts");
    expect(results.map((r) => r.metric)).toContain("deliveryRecoveries");
    expect(mockEmitOagEvent).toHaveBeenCalledWith("anomaly_detected", expect.any(Object));
  });

  it("ignores zero-mean metrics even if current is non-zero", () => {
    const series = makeSeries(30, { channelRestarts: 0 });
    const results = detectAnomalies({ channelRestarts: 5 }, series);
    // mean=0, so anomalies with zero mean are excluded
    expect(results).toEqual([]);
  });

  it("skips intermittent metrics with insufficient valid samples", () => {
    // Create series where metric is only present in half the samples
    const series: MetricSnapshot[] = Array.from({ length: 30 }, (_, i) => ({
      timestamp: new Date(Date.now() - (30 - i) * 3600_000).toISOString(),
      uptimeMs: i * 3600_000,
      // Only include metric in even-indexed samples (15 valid samples < 24 minSamples)
      metrics: i % 2 === 0 ? { channelRestarts: 5 } : {},
    }));
    // Even with a high current value, should skip due to insufficient samples
    const results = detectAnomalies({ channelRestarts: 100 }, series);
    expect(results).toEqual([]);
  });

  it("detects anomalies for intermittent metrics with enough valid samples", () => {
    mockEmitOagEvent.mockClear();
    // Create series with 25 valid samples (>= 24 minSamples)
    const series: MetricSnapshot[] = Array.from({ length: 50 }, (_, i) => ({
      timestamp: new Date(Date.now() - (50 - i) * 3600_000).toISOString(),
      uptimeMs: i * 3600_000,
      // Include metric in 25 out of 50 samples (valid, others undefined)
      metrics: i < 25 ? { channelRestarts: 5 } : {},
    }));
    // Should detect anomaly since we have 25 valid samples
    const results = detectAnomalies({ channelRestarts: 100 }, series);
    expect(results.length).toBe(1);
    expect(results[0].metric).toBe("channelRestarts");
    expect(results[0].anomalous).toBe(true);
  });

  it("skips new counter metrics not present in history", () => {
    // Series has no 'newMetric' at all
    const series = makeSeries(30, { existingMetric: 10 });
    // Trying to detect anomaly on a new metric that doesn't exist in history
    const results = detectAnomalies({ newMetric: 100 }, series);
    expect(results).toEqual([]);
  });
});

describe("linearSlope", () => {
  it("returns 0 for flat data", () => {
    const slope = linearSlope([5, 5, 5, 5, 5]);
    expect(slope).toBeCloseTo(0, 10);
  });

  it("returns positive slope for increasing data", () => {
    const slope = linearSlope([1, 2, 3, 4, 5]);
    expect(slope).toBeCloseTo(1, 10);
  });

  it("returns negative slope for decreasing data", () => {
    const slope = linearSlope([5, 4, 3, 2, 1]);
    expect(slope).toBeCloseTo(-1, 10);
  });

  it("returns 0 for single point", () => {
    const slope = linearSlope([42]);
    expect(slope).toBe(0);
  });
});

describe("linearSlopeTimeWeighted", () => {
  it("returns 0 for empty arrays", () => {
    expect(linearSlopeTimeWeighted([], [])).toBe(0);
  });

  it("returns 0 for single point", () => {
    expect(linearSlopeTimeWeighted([0], [42])).toBe(0);
  });

  it("returns 0 for mismatched array lengths", () => {
    expect(linearSlopeTimeWeighted([0, 1], [42])).toBe(0);
  });

  it("returns correct slope for equally-spaced data", () => {
    // x = [0, 1, 2, 3], y = [1, 2, 3, 4] -> slope = 1
    const slope = linearSlopeTimeWeighted([0, 1, 2, 3], [1, 2, 3, 4]);
    expect(slope).toBeCloseTo(1, 10);
  });

  it("returns correct slope for sparse time intervals", () => {
    // x = [0, 6, 12], y = [1, 7, 13] -> slope = 1 (6 units per 6 hours)
    const slope = linearSlopeTimeWeighted([0, 6, 12], [1, 7, 13]);
    expect(slope).toBeCloseTo(1, 10);
  });

  it("handles negative slope correctly", () => {
    const slope = linearSlopeTimeWeighted([0, 1, 2], [5, 4, 3]);
    expect(slope).toBeCloseTo(-1, 10);
  });

  it("returns 0 for constant values", () => {
    const slope = linearSlopeTimeWeighted([0, 1, 2, 3], [5, 5, 5, 5]);
    expect(slope).toBeCloseTo(0, 10);
  });
});

describe("predictBreach", () => {
  function makeSeries(values: number[]): MetricSnapshot[] {
    return values.map((v, i) => ({
      timestamp: new Date(Date.now() - (values.length - i) * 3600_000).toISOString(),
      uptimeMs: i * 3600_000,
      metrics: { channelRestarts: v },
    }));
  }

  it("predicts breach for increasing metric approaching threshold", () => {
    mockEmitOagEvent.mockClear();
    // Values: 1,2,3,4 — slope ~1, current=4, threshold=6
    // hoursToBreak = (6-4)/1 = 2
    const series = makeSeries([1, 2, 3, 4]);
    const result = predictBreach(series, "channelRestarts", 6, 12);
    expect(result).not.toBeNull();
    expect(result!.hoursToBreak).toBeCloseTo(2, 0);
    expect(result!.slope).toBeCloseTo(1, 0);
    expect(result!.currentValue).toBe(4);
    expect(result!.threshold).toBe(6);
    expect(mockEmitOagEvent).toHaveBeenCalledWith(
      "prediction_alert",
      expect.objectContaining({ metric: "channelRestarts" }),
    );
  });

  it("returns null when slope is <= 0", () => {
    const series = makeSeries([5, 4, 3, 2]);
    const result = predictBreach(series, "channelRestarts", 10, 12);
    expect(result).toBeNull();
  });

  it("returns null when metric already breached", () => {
    const series = makeSeries([1, 2, 3, 10]);
    const result = predictBreach(series, "channelRestarts", 5, 12);
    expect(result).toBeNull();
  });

  it("returns null when breach is too far out (>6h)", () => {
    // slope ~1, current=4, threshold=100 => hoursToBreak = 96
    const series = makeSeries([1, 2, 3, 4]);
    const result = predictBreach(series, "channelRestarts", 100, 12);
    expect(result).toBeNull();
  });

  it("returns null with insufficient data (< 3 points)", () => {
    const series = makeSeries([1, 2]);
    const result = predictBreach(series, "channelRestarts", 10, 12);
    expect(result).toBeNull();
  });

  it("returns null for intermittent metric with insufficient valid samples", () => {
    // Create series with only 2 valid samples (need >= 3)
    const series: MetricSnapshot[] = Array.from({ length: 12 }, (_, i) => ({
      timestamp: new Date(Date.now() - (12 - i) * 3600_000).toISOString(),
      uptimeMs: i * 3600_000,
      // Only 2 samples have the metric defined
      metrics: i < 2 ? { channelRestarts: i + 1 } : {},
    }));
    const result = predictBreach(series, "channelRestarts", 10, 12);
    expect(result).toBeNull();
  });

  it("predicts breach for intermittent metric with enough valid samples", () => {
    // Create series with 4 valid samples (>= 3)
    const series: MetricSnapshot[] = Array.from({ length: 12 }, (_, i) => ({
      timestamp: new Date(Date.now() - (12 - i) * 3600_000).toISOString(),
      uptimeMs: i * 3600_000,
      // First 4 samples have increasing values, rest undefined
      metrics: i < 4 ? { channelRestarts: i + 1 } : {},
    }));
    const result = predictBreach(series, "channelRestarts", 6, 12);
    expect(result).not.toBeNull();
    expect(result!.currentValue).toBe(4);
  });

  it("returns null for metric not present in any sample", () => {
    const series: MetricSnapshot[] = Array.from({ length: 12 }, (_, i) => ({
      timestamp: new Date(Date.now() - (12 - i) * 3600_000).toISOString(),
      uptimeMs: i * 3600_000,
      metrics: { otherMetric: i },
    }));
    const result = predictBreach(series, "channelRestarts", 10, 12);
    expect(result).toBeNull();
  });

  it("uses time-weighted slope for sparse samples", () => {
    // Samples at hours -11, -5, -1 (gaps of 6h each)
    // Values: 1, 7, 11 -> slope should be ~1 (10 units over 10 hours)
    const now = Date.now();
    const series: MetricSnapshot[] = [
      {
        timestamp: new Date(now - 11 * 3600_000).toISOString(),
        uptimeMs: 0,
        metrics: { channelRestarts: 1 },
      },
      {
        timestamp: new Date(now - 5 * 3600_000).toISOString(),
        uptimeMs: 0,
        metrics: { channelRestarts: 7 },
      },
      {
        timestamp: new Date(now - 1 * 3600_000).toISOString(),
        uptimeMs: 0,
        metrics: { channelRestarts: 11 },
      },
    ];
    const result = predictBreach(series, "channelRestarts", 15, 12);
    expect(result).not.toBeNull();
    // Slope should be approximately 1 unit/hour (10 units over 10 hours)
    expect(result!.slope).toBeCloseTo(1, 1);
    // hoursToBreak = (15 - 11) / 1 = 4
    expect(result!.hoursToBreak).toBeCloseTo(4, 0);
  });

  it("returns high confidence when samples have no large gaps", () => {
    // Samples every hour, no gaps > 6h
    const series = makeSeries([1, 2, 3, 4]);
    const result = predictBreach(series, "channelRestarts", 6, 12);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("high");
  });

  it("returns low confidence when samples have large gaps", () => {
    // Samples with 8h gap between them
    const now = Date.now();
    const series: MetricSnapshot[] = [
      {
        timestamp: new Date(now - 12 * 3600_000).toISOString(),
        uptimeMs: 0,
        metrics: { channelRestarts: 0 },
      },
      {
        timestamp: new Date(now - 10 * 3600_000).toISOString(),
        uptimeMs: 0,
        metrics: { channelRestarts: 1 },
      },
      {
        timestamp: new Date(now - 2 * 3600_000).toISOString(),
        uptimeMs: 0,
        metrics: { channelRestarts: 9 },
      },
    ];
    // threshold=12, current=9, slope ~0.93 -> hoursToBreak ~3.2 (within 6h)
    const result = predictBreach(series, "channelRestarts", 12, 12);
    expect(result).not.toBeNull();
    // Gap between second and third sample is 8h (> 6h threshold)
    expect(result!.confidence).toBe("low");
  });
});
