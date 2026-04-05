import type { ActivityMetrics } from "./activity-types.ts";

const MAX_SAMPLES = 60;

export type MetricsSample = {
  ts: number;
  metrics: ActivityMetrics;
};

export type MetricsHistory = {
  samples: MetricsSample[];
};

export function createMetricsHistory(): MetricsHistory {
  return { samples: [] };
}

export function pushSample(history: MetricsHistory, metrics: ActivityMetrics): void {
  history.samples.push({ ts: Date.now(), metrics });
  if (history.samples.length > MAX_SAMPLES) {
    history.samples.splice(0, history.samples.length - MAX_SAMPLES);
  }
}

export function getSparklineData(
  history: MetricsHistory,
  accessor: (m: ActivityMetrics) => number,
): number[] {
  return history.samples.map((s) => accessor(s.metrics));
}
