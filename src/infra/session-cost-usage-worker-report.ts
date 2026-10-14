import type { SessionCostUsageRollupRow } from "./session-cost-usage-cache.kernel.js";
import {
  decodeUsageCostPartition,
  USAGE_COST_QUARTER_MS,
  type UsageCostPartition,
} from "./session-cost-usage-partitions.js";
import { createUsageDayKeyFormatter } from "./session-cost-usage-projection.js";
import {
  decodeUsageCostRollup,
  decodeUsageCostRollupEnvelope,
  type UsageCostRollupEntry,
} from "./session-cost-usage-rollup-codec.js";
import { createSessionUsageRollupData } from "./session-cost-usage-rollup.js";
import { scanUsageCostRollupInWorker } from "./session-cost-usage-worker-refresh.js";
import { UsageCostHostEffectError } from "./session-cost-usage-worker.types.js";
import type { UsageCostTranscriptFile, UsageDailyBucket } from "./session-cost-usage.types.js";
import { WorkerTaskError } from "./worker-task-pool.js";

type RollupScan = Omit<Parameters<typeof scanUsageCostRollupInWorker>[0], "file" | "previous">;

/** Prepare bounded cache inputs synchronously inside their shared read snapshot. */
export function prepareUsageCostReportEntry(params: {
  row: SessionCostUsageRollupRow;
  body: (row: SessionCostUsageRollupRow) => Uint8Array | null;
  partitions: (filePath: string) => UsageCostPartition[];
  startMs?: number;
  endMs?: number;
  pricingFingerprint: string;
  throwIfCancelled: () => void;
}) {
  params.throwIfCancelled();
  const blob = params.body(params.row);
  const envelope = decodeUsageCostRollupEnvelope(params.row.valueJson, params.pricingFingerprint);
  params.throwIfCancelled();
  const startMs = params.startMs ?? Number.NEGATIVE_INFINITY;
  const endMs = params.endMs ?? Number.POSITIVE_INFINITY;
  // Exact partial boundaries need individual timestamps. Aligned reports use the
  // committed aggregates; regrouping floating costs may change their final bit.
  const aligned =
    (!Number.isFinite(startMs) || startMs % USAGE_COST_QUARTER_MS === 0) &&
    (!Number.isFinite(endMs) || (endMs + 1) % USAGE_COST_QUARTER_MS === 0);
  const selected =
    blob && envelope?.projection && aligned ? params.partitions(params.row.key) : undefined;
  return { valueJson: params.row.valueJson, blob, envelope, selected };
}

/** Project captured cache inputs; replay opens its own bounded transcript reads. */
export async function readUsageCostReportEntry(params: {
  prepared: ReturnType<typeof prepareUsageCostReportEntry>;
  file: UsageCostTranscriptFile | undefined;
  startMs?: number;
  endMs?: number;
  dayBucket: UsageDailyBucket;
  scan: RollupScan;
  throwIfCancelled: () => void;
  replayBudget: { remainingBytes: number; deadline: number };
  cacheBudget: { remainingBytes: number };
}): Promise<UsageCostRollupEntry | null | undefined> {
  const { file, scan } = params;
  params.throwIfCancelled();
  const { valueJson, blob, envelope, selected } = params.prepared;
  const cached = decodeUsageCostRollup(
    valueJson,
    scan.pricingFingerprint,
    blob,
    params.cacheBudget,
  );
  params.throwIfCancelled();
  if (!cached || !envelope?.projection) {
    return cached;
  }
  if (!file) {
    return undefined;
  }
  const startMs = params.startMs ?? Number.NEGATIVE_INFINITY;
  const endMs = params.endMs ?? Number.POSITIVE_INFINITY;
  if (selected) {
    const startMonth = Number.isFinite(startMs)
      ? `${new Date(startMs).toISOString().slice(0, 7)}-01`
      : "";
    const endMonth = Number.isFinite(endMs)
      ? `${new Date(endMs).toISOString().slice(0, 7)}-01`
      : "\uffff";
    const expected = envelope.projection.dates.filter((date) => {
      return date >= startMonth && date <= endMonth;
    });
    if (selected.length !== expected.length) {
      return undefined;
    }
    const rollup = createSessionUsageRollupData();
    rollup.untimestamped = cached.rollup.untimestamped;
    for (const partition of selected) {
      params.throwIfCancelled();
      const day = decodeUsageCostPartition(partition.valueJson, partition.blob, params.cacheBudget);
      if (day === null) {
        return null;
      }
      if (!day) {
        return undefined;
      }
      for (const [key, bucket] of Object.entries(day.buckets)) {
        if (bucket.timestampMs >= startMs && bucket.timestampMs <= endMs) {
          rollup.buckets[key] = bucket;
        }
      }
    }
    const formatDay = createUsageDayKeyFormatter(params.dayBucket);
    if (
      Object.values(rollup.buckets).every(
        (bucket) =>
          formatDay(new Date(bucket.firstTimestampMs ?? bucket.timestampMs)) ===
          formatDay(new Date(bucket.lastTimestampMs ?? bucket.timestampMs)),
      )
    ) {
      return { ...cached, rollup };
    }
  }
  const checkpoint = cached.checkpoint;
  const snapshotFile =
    checkpoint.kind === "sqlite"
      ? {
          ...file,
          maxSeq: checkpoint.maxSeq,
          eventCount: checkpoint.eventCount,
          size: checkpoint.size,
          mtimeMs: checkpoint.mtimeMs,
        }
      : { ...file, size: checkpoint.observedSize, mtimeMs: checkpoint.observedMtimeMs };
  const budget = params.replayBudget;
  if (snapshotFile.size > budget.remainingBytes || performance.now() >= budget.deadline) {
    return null;
  }
  budget.remainingBytes -= snapshotFile.size;
  const exhausted = new Error("Usage report replay budget exhausted");
  const checkProgress = () => {
    params.throwIfCancelled();
    if (performance.now() >= budget.deadline) {
      throw exhausted;
    }
  };
  const canonical = await scanUsageCostRollupInWorker({
    ...scan,
    file: snapshotFile,
    checkProgress,
    resolveCosts: async (pairs) => {
      checkProgress();
      const costs = await scan.resolveCosts(pairs);
      checkProgress();
      return costs;
    },
  }).catch((error: unknown) => {
    params.throwIfCancelled();
    if (error === exhausted) {
      return null;
    }
    if (error instanceof UsageCostHostEffectError || error instanceof WorkerTaskError) {
      throw error;
    }
    // Omit failed replays so the report stays partial without publishing incomplete usage.
    return undefined;
  });
  params.throwIfCancelled();
  if (canonical === null) {
    return null;
  }
  if (!canonical || canonical.checkpoint.anchorHash !== checkpoint.anchorHash) {
    return undefined;
  }
  return { ...canonical, scannedAt: cached.scannedAt };
}
