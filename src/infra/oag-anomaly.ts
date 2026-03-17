import { emitOagEvent } from "./oag-event-bus.js";
import type { MetricSnapshot } from "./oag-memory.js";

export type Baseline = {
  mean: number;
  stdDev: number;
  sampleCount: number;
};

export type AnomalyResult = {
  metric: string;
  anomalous: boolean;
  zScore: number;
  direction: "spike" | "drop" | "normal";
  current: number;
  baseline: Baseline;
};

export type Prediction = {
  metric: string;
  hoursToBreak: number;
  currentValue: number;
  threshold: number;
  slope: number;
};

export function computeBaseline(values: number[]): Baseline {
  if (values.length === 0) {
    return { mean: 0, stdDev: 0, sampleCount: 0 };
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
  return { mean, stdDev: Math.sqrt(variance), sampleCount: values.length };
}

export function detectAnomaly(current: number, baseline: Baseline, threshold = 2.0): AnomalyResult {
  if (baseline.stdDev === 0) {
    // When stdDev is 0, any deviation from mean is anomalous
    const diff = current - baseline.mean;
    if (diff === 0) {
      return {
        metric: "",
        anomalous: false,
        zScore: 0,
        direction: "normal",
        current,
        baseline,
      };
    }
    // Use a large zScore to signal clear deviation from a constant baseline
    const zScore = diff > 0 ? Infinity : -Infinity;
    return {
      metric: "",
      anomalous: true,
      zScore,
      direction: diff > 0 ? "spike" : "drop",
      current,
      baseline,
    };
  }

  const zScore = (current - baseline.mean) / baseline.stdDev;
  const anomalous = Math.abs(zScore) > threshold;
  let direction: "spike" | "drop" | "normal" = "normal";
  if (zScore > threshold) {
    direction = "spike";
  } else if (zScore < -threshold) {
    direction = "drop";
  }

  return {
    metric: "",
    anomalous,
    zScore,
    direction,
    current,
    baseline,
  };
}

/**
 * Check all metrics against baselines derived from the historical metric series.
 * Returns only anomalous results for metrics with non-trivial activity.
 */
export function detectAnomalies(
  currentMetrics: Record<string, number>,
  series: MetricSnapshot[],
  options?: { minSamples?: number; threshold?: number },
): AnomalyResult[] {
  const minSamples = options?.minSamples ?? 24; // need at least 24h of data
  if (series.length < minSamples) {
    return [];
  }

  const results: AnomalyResult[] = [];
  for (const [metric, current] of Object.entries(currentMetrics)) {
    const values = series.map((s) => s.metrics[metric] ?? 0);
    const baseline = computeBaseline(values);
    const result = detectAnomaly(current, baseline, options?.threshold);
    // Only report anomalies for metrics that have non-trivial activity
    if (result.anomalous && baseline.mean > 0) {
      results.push({ ...result, metric });
      emitOagEvent("anomaly_detected", {
        metric,
        zScore: result.zScore,
        direction: result.direction,
      });
    }
  }
  return results;
}

/** Simple linear regression slope over equally-spaced values. */
export function linearSlope(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const n = values.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) {
    return 0;
  }
  return (n * sumXY - sumX * sumY) / denom;
}

/**
 * Predict when a metric will breach a threshold based on recent linear trend.
 * Returns null when the metric is not trending toward the threshold within 6 hours.
 */
export function predictBreach(
  series: MetricSnapshot[],
  metric: string,
  threshold: number,
  windowHours = 12,
): Prediction | null {
  const recent = series.slice(-windowHours);
  if (recent.length < 3) {
    return null;
  }

  const values = recent.map((s) => s.metrics[metric] ?? 0);
  const slope = linearSlope(values);
  if (slope <= 0) {
    return null;
  } // not increasing

  const current = values[values.length - 1];
  if (current >= threshold) {
    return null;
  } // already breached

  const hoursToBreak = (threshold - current) / slope;
  if (hoursToBreak <= 0 || hoursToBreak > 6) {
    return null;
  } // too far out

  emitOagEvent("prediction_alert", { metric, hoursToBreak, slope });
  return { metric, hoursToBreak, currentValue: current, threshold, slope };
}
