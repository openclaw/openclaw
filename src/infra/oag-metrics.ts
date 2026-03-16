export type OagMetricCounters = {
  channelRestarts: number;
  deliveryRecoveries: number;
  deliveryRecoveryFailures: number;
  staleSocketDetections: number;
  stalePollDetections: number;
  noteDeliveries: number;
  noteDeduplications: number;
  lockAcquisitions: number;
  lockStalRecoveries: number;
};

type OagMetricEntry = {
  name: string;
  value: number;
  labels?: Record<string, string>;
};

const counters: OagMetricCounters = {
  channelRestarts: 0,
  deliveryRecoveries: 0,
  deliveryRecoveryFailures: 0,
  staleSocketDetections: 0,
  stalePollDetections: 0,
  noteDeliveries: 0,
  noteDeduplications: 0,
  lockAcquisitions: 0,
  lockStalRecoveries: 0,
};

export function incrementOagMetric(name: keyof OagMetricCounters, amount = 1): void {
  counters[name] += amount;
}

export function getOagMetrics(): OagMetricCounters {
  return { ...counters };
}

export function getOagMetricsEntries(): OagMetricEntry[] {
  return Object.entries(counters).map(([name, value]) => ({
    name: `oag_${name.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`)}`,
    value,
  }));
}

export function resetOagMetrics(): void {
  for (const key of Object.keys(counters) as Array<keyof OagMetricCounters>) {
    counters[key] = 0;
  }
}
