export const CONNECTION_PING_SAMPLE_LIMIT = 100;

export type ConnectionPingSummary = {
  count: number;
  averageMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
};

export function summarizeConnectionPing(samples: readonly number[]): ConnectionPingSummary | null {
  if (samples.length === 0) {
    return null;
  }
  const sorted = samples.toSorted((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1]!;
  return {
    count: samples.length,
    averageMs: samples.reduce((total, sample) => total + sample, 0) / samples.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
  };
}
