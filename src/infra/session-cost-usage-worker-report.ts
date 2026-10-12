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
import type { UsageCostTranscriptFile, UsageDailyBucket } from "./session-cost-usage.types.js";

type RollupScan = Omit<Parameters<typeof scanUsageCostRollupInWorker>[0], "file" | "previous">;

/** Reads one report entry under the caller's cache snapshot and transcript custody. */
export async function readUsageCostReportEntry(params: {
  row: SessionCostUsageRollupRow;
  file: UsageCostTranscriptFile | undefined;
  body: (row: SessionCostUsageRollupRow) => Uint8Array | null | Promise<Uint8Array | null>;
  partitions: (
    filePath: string,
    startMs?: number,
    endMs?: number,
  ) => UsageCostPartition[] | Promise<UsageCostPartition[]>;
  startMs?: number;
  endMs?: number;
  dayBucket: UsageDailyBucket;
  overview: boolean;
  scan: RollupScan;
}): Promise<UsageCostRollupEntry | undefined> {
  const { row, file, scan } = params;
  const cached = decodeUsageCostRollup(
    row.valueJson,
    scan.pricingFingerprint,
    await params.body(row),
  );
  const envelope = decodeUsageCostRollupEnvelope(row.valueJson, scan.pricingFingerprint);
  if (!cached || !envelope?.projection) {
    return cached;
  }
  if (!file) {
    return undefined;
  }
  const startMs = params.startMs ?? Number.NEGATIVE_INFINITY;
  const endMs = params.endMs ?? Number.POSITIVE_INFINITY;
  // Exact partial boundaries and legacy callers retain canonical addition order.
  const aligned =
    (!Number.isFinite(startMs) || startMs % USAGE_COST_QUARTER_MS === 0) &&
    (!Number.isFinite(endMs) || (endMs + 1) % USAGE_COST_QUARTER_MS === 0);
  if (params.overview && aligned && !envelope.projection.canonicalNumbers) {
    const selected = await params.partitions(row.key, startMs, endMs);
    const expected = envelope.projection.dates.filter((date) => {
      const time = Date.parse(date);
      return time + 86_400_000 > startMs && time <= endMs;
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
      Object.assign(rollup.buckets, day.buckets);
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
  const canonical = await scanUsageCostRollupInWorker({ ...scan, file: snapshotFile });
  if (canonical.checkpoint.anchorHash !== checkpoint.anchorHash) {
    return undefined;
  }
  return { ...canonical, scannedAt: cached.scannedAt };
}
