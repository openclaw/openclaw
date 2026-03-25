// ─────────────────────────────────────────────
//  OpenClaw Shield — Function Health Scoring
//  Per-function health score + baseline learning
//  for gateway endpoint protection.
//  Adapted from Kairos Shield Protocol (Layer 4)
//  By Kairos Lab
// ─────────────────────────────────────────────

// ─── Types ───────────────────────────────────

export interface FunctionMetrics {
  functionName: string;
  window: "1min";
  totalInvocations: number;
  successCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
  timeoutCount: number;
  p50Latency: number;
  p95Latency: number;
  p99Latency: number;
  errorRate: number;
  availability: number;
}

export interface FunctionHealth {
  functionName: string;
  healthScore: number;
  status: FunctionStatus;
  lastChecked: string;
}

export interface FunctionBaseline {
  rpm: number;
  p95: number;
}

export type FunctionStatus = "HEALTHY" | "DEGRADED" | "CRITICAL" | "CIRCUIT_OPEN";

// ─── Constants ───────────────────────────────

export const STATUS_THRESHOLDS = {
  HEALTHY: 80,
  DEGRADED: 50,
  CRITICAL: 25,
} as const;

export const BASELINE_LEARNING_HOURS = 24;

// ─── Health Score Calculation ─────────────────

export function calculateFunctionHealth(
  metrics: FunctionMetrics,
  baselineP95: number,
  baselineVolume: number,
): number {
  let score = 100;

  // Error rate penalty
  if (metrics.errorRate > 1) {
    score -= metrics.errorRate * 3;
  }
  if (metrics.errorRate > 5) {
    score -= (metrics.errorRate - 5) * 5;
  }
  if (metrics.errorRate > 20) {
    score -= 30;
  }

  // Latency penalty
  if (baselineP95 > 0) {
    if (metrics.p95Latency > baselineP95 * 5) {
      score -= 20;
    } else if (metrics.p95Latency > baselineP95 * 2) {
      score -= 10;
    }
  }
  if (metrics.p95Latency > 10000) {
    score -= 15;
  }

  // Timeout penalty
  if (metrics.timeoutCount > 0) {
    score -= metrics.timeoutCount * 5;
  }

  // Volume anomaly
  if (baselineVolume > 10 && metrics.totalInvocations < baselineVolume * 0.1) {
    score -= 10;
  }

  return Math.max(0, Math.min(100, score));
}

// ─── Status Classification ──────────────────

export function getFunctionStatus(score: number): FunctionStatus {
  if (score >= STATUS_THRESHOLDS.HEALTHY) {
    return "HEALTHY";
  }
  if (score >= STATUS_THRESHOLDS.DEGRADED) {
    return "DEGRADED";
  }
  if (score >= STATUS_THRESHOLDS.CRITICAL) {
    return "CRITICAL";
  }
  return "CIRCUIT_OPEN";
}

// ─── Baseline Calculation ────────────────────

export function calculatePercentile(values: number[], percentile: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = (percentile / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return sorted[lower];
  }

  const fraction = index - lower;
  return sorted[lower] + fraction * (sorted[upper] - sorted[lower]);
}

export function buildFunctionBaseline(
  metricsHistory: { total_invocations: number; p95_latency: number | null }[],
): FunctionBaseline {
  const invocations = metricsHistory.map((m) => m.total_invocations);
  const latencies = metricsHistory
    .map((m) => m.p95_latency)
    .filter((v): v is number => v !== null && v > 0);

  return {
    rpm: calculatePercentile(invocations, 75),
    p95: calculatePercentile(latencies, 90),
  };
}

export function buildFunctionHealth(
  functionName: string,
  metrics: FunctionMetrics,
  baselineP95: number,
  baselineVolume: number,
): FunctionHealth {
  const score = calculateFunctionHealth(metrics, baselineP95, baselineVolume);
  return {
    functionName,
    healthScore: score,
    status: getFunctionStatus(score),
    lastChecked: new Date().toISOString(),
  };
}
