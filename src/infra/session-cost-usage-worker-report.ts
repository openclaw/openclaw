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

/** Capture cache inputs synchronously while their shared read snapshot is open. */
export function prepareUsageCostReportEntry(params: {
  row: SessionCostUsageRollupRow;
  body: (row: SessionCostUsageRollupRow) => Uint8Array | null;
  partitions: (filePath: string, startMs?: number, endMs?: number) => UsageCostPartition[];
  startMs?: number;
  endMs?: number;
  overview: boolean;
  pricingFingerprint: string;
}) {
  const blob = params.body(params.row);
  const cached = decodeUsageCostRollup(params.row.valueJson, params.pricingFingerprint, blob);
  const envelope = decodeUsageCostRollupEnvelope(params.row.valueJson, params.pricingFingerprint);
  const startMs = params.startMs ?? Number.NEGATIVE_INFINITY;
  const endMs = params.endMs ?? Number.POSITIVE_INFINITY;
  // Exact partial boundaries and legacy callers retain canonical addition order.
  const aligned =
    (!Number.isFinite(startMs) || startMs % USAGE_COST_QUARTER_MS === 0) &&
    (!Number.isFinite(endMs) || (endMs + 1) % USAGE_COST_QUARTER_MS === 0);
  const selected =
    cached &&
    envelope?.projection &&
    params.overview &&
    aligned &&
    !envelope.projection.canonicalNumbers
      ? params.partitions(params.row.key, startMs, endMs)
      : undefined;
  return { blob, cached, envelope, selected };
}

/** Project captured cache inputs; canonical replay uses its own bounded transcript reads. */
export async function readUsageCostReportEntry(params: {
  prepared: ReturnType<typeof prepareUsageCostReportEntry>;
  file: UsageCostTranscriptFile | undefined;
  startMs?: number;
  endMs?: number;
  dayBucket: UsageDailyBucket;
  scan: RollupScan;
}): Promise<UsageCostRollupEntry | undefined> {
  const { file, scan } = params;
  const { cached, envelope, selected } = params.prepared;
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
      const day = decodeUsageCostPartition(partition.valueJson, partition.blob);
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
  const canonical = await scanUsageCostRollupInWorker({ ...scan, file: snapshotFile }).catch(
    (error: unknown) => {
      if (error instanceof UsageCostHostEffectError || error instanceof WorkerTaskError) {
        throw error;
      }
      // Omit failed replays so the report stays partial without publishing incomplete usage.
      return undefined;
    },
  );
  if (!canonical || canonical.checkpoint.anchorHash !== checkpoint.anchorHash) {
    return undefined;
  }
  return { ...canonical, scannedAt: cached.scannedAt };
}
