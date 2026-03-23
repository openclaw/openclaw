// ─────────────────────────────────────────────
//  OpenClaw Shield — Metrics Collector
//  Aggregation logic for gateway request metrics
//  into per-minute windows for health scoring.
//  Adapted from Kairos Shield Protocol (Layer 4)
//  By Kairos Lab
// ─────────────────────────────────────────────

import { calculatePercentile } from "./function-health.js";

// ─── Types ───────────────────────────────────

export interface RequestMetric {
  functionName: string;
  startTime: number;
  endTime: number;
  status: number;
  error: boolean;
  timeout: boolean;
}

export interface AggregatedMetrics {
  functionName: string;
  windowStart: string;
  total: number;
  success: number;
  clientErrors: number;
  serverErrors: number;
  timeouts: number;
  latencies: number[];
  p50: number;
  p95: number;
  p99: number;
  errorRate: number;
}

// ─── Constants ───────────────────────────────

export const FLUSH_INTERVAL_MS = 10_000;
export const FLUSH_SIZE = 50;

// ─── Aggregation ────────────────────────────

export function getWindowStart(timestamp: number): string {
  const date = new Date(timestamp);
  date.setSeconds(0, 0);
  return date.toISOString();
}

export function aggregateByFunctionAndMinute(
  metrics: RequestMetric[],
): Map<string, AggregatedMetrics> {
  const result = new Map<string, AggregatedMetrics>();

  for (const metric of metrics) {
    const windowStart = getWindowStart(metric.startTime);
    const key = `${metric.functionName}|${windowStart}`;

    let agg = result.get(key);
    if (!agg) {
      agg = {
        functionName: metric.functionName,
        windowStart,
        total: 0,
        success: 0,
        clientErrors: 0,
        serverErrors: 0,
        timeouts: 0,
        latencies: [],
        p50: 0,
        p95: 0,
        p99: 0,
        errorRate: 0,
      };
      result.set(key, agg);
    }

    agg.total++;
    const latency = metric.endTime - metric.startTime;
    agg.latencies.push(latency);

    if (metric.timeout) {
      agg.timeouts++;
    } else if (metric.status >= 500) {
      agg.serverErrors++;
    } else if (metric.status >= 400) {
      agg.clientErrors++;
    } else {
      agg.success++;
    }
  }

  for (const agg of result.values()) {
    agg.p50 = calculatePercentile(agg.latencies, 50);
    agg.p95 = calculatePercentile(agg.latencies, 95);
    agg.p99 = calculatePercentile(agg.latencies, 99);
    agg.errorRate = calculateErrorRate(agg.serverErrors, agg.timeouts, agg.total);
  }

  return result;
}

export function calculateErrorRate(serverErrors: number, timeouts: number, total: number): number {
  if (total === 0) {
    return 0;
  }
  return ((serverErrors + timeouts) / total) * 100;
}
