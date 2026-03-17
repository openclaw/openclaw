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
});
