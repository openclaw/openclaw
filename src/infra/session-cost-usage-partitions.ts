import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sha256Hex } from "./crypto-digest.js";
import {
  encodeUsageCostRollup,
  type UsageCostRollupEntry,
  type UsageCostRollupEnvelope,
} from "./session-cost-usage-rollup-codec.js";
import {
  createSessionUsageRollupData,
  mergeSessionUsageRollupBucket,
  type SessionUsageRollupData,
} from "./session-cost-usage-rollup.js";
import type { CostUsageTotals } from "./session-cost-usage.types.js";
import { resolveZstdCodec } from "./zstd-codec.js";

export const USAGE_COST_PARTITION_SCOPE = "session-cost-usage-projection-v1";
export const USAGE_COST_QUARTER_MS = 15 * 60 * 1000;
const codec = resolveZstdCodec();

export type UsageCostPartition = {
  date: string;
  valueJson: string;
  blob: Uint8Array;
};

export function usageCostPartitionKey(sessionFile: string, date: string): string {
  return `${sessionFile}\0${date}`;
}

function encodeUsageCostPartition(
  date: string,
  rollup: SessionUsageRollupData,
): UsageCostPartition & { blob: Uint8Array<ArrayBuffer> } {
  const raw = Buffer.from(JSON.stringify(rollup));
  const compressed = raw.byteLength >= 1024 ? codec?.compress(raw, 1) : undefined;
  const useCompressed = compressed !== undefined && compressed.byteLength < raw.byteLength;
  return {
    date,
    valueJson: JSON.stringify({
      encoding: useCompressed ? "zstd" : "identity",
      bytes: raw.byteLength,
      sha256: sha256Hex(raw),
    }),
    blob: Uint8Array.from(useCompressed ? compressed : raw),
  };
}

export function decodeUsageCostPartition(
  valueJson: string,
  blob: Uint8Array | null,
): SessionUsageRollupData | undefined {
  if (!blob) {
    return undefined;
  }
  try {
    const metadata: unknown = JSON.parse(valueJson);
    if (
      !isRecord(metadata) ||
      (metadata.encoding !== "identity" && metadata.encoding !== "zstd") ||
      typeof metadata.bytes !== "number" ||
      !Number.isSafeInteger(metadata.bytes) ||
      metadata.bytes <= 0 ||
      typeof metadata.sha256 !== "string"
    ) {
      return undefined;
    }
    const raw =
      metadata.encoding === "zstd"
        ? codec?.decompress(blob, metadata.bytes)
        : Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
    if (!raw || raw.byteLength !== metadata.bytes || sha256Hex(raw) !== metadata.sha256) {
      return undefined;
    }
    const value: unknown = JSON.parse(raw.toString("utf8"));
    if (!isRecord(value) || !isRecord(value.buckets) || !isRecord(value.untimestamped)) {
      return undefined;
    }
    // SAFETY: The hash and versioned scope identify the owner's generated bucket shape.
    return value as SessionUsageRollupData;
  } catch {
    return undefined;
  }
}

const numericTotals: Array<Exclude<keyof CostUsageTotals, "missingCostByModel">> = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "totalTokens",
  "totalCost",
  "inputCost",
  "outputCost",
  "cacheReadCost",
  "cacheWriteCost",
  "missingCostEntries",
];

export function partitionUsageCostRollup(
  entry: UsageCostRollupEntry,
  inheritedCanonicalNumbers = false,
  ephemeral = false,
): {
  valueJson: string;
  blob: Uint8Array<ArrayBuffer>;
  partitions: Array<UsageCostPartition & { blob: Uint8Array<ArrayBuffer> }>;
} {
  // The legacy incognito owner is process-held; only durable stores persist date projections.
  if (ephemeral) {
    return { ...encodeUsageCostRollup(entry), partitions: [] };
  }
  const days = new Map<string, SessionUsageRollupData>();
  let canonicalNumbers = inheritedCanonicalNumbers;
  let regrouped = false;
  let integerArithmetic = true;
  const canonicalTotal = { ...entry.rollup.untimestamped.totals };
  const groupedTotal = { ...entry.rollup.untimestamped.totals };
  const buckets = Object.values(entry.rollup.buckets).toSorted(
    (left, right) => left.timestampMs - right.timestampMs,
  );
  for (const bucket of buckets) {
    const quarter = Math.floor(bucket.timestampMs / USAGE_COST_QUARTER_MS) * USAGE_COST_QUARTER_MS;
    const date = new Date(quarter).toISOString().slice(0, 10);
    let day = days.get(date);
    if (!day) {
      day = createSessionUsageRollupData();
      days.set(date, day);
    }
    const current = day.buckets[String(quarter)];
    if (current) {
      regrouped = true;
      mergeSessionUsageRollupBucket(current, bucket);
    } else {
      day.buckets[String(quarter)] = {
        ...structuredClone(bucket),
        timestampMs: quarter,
        firstTimestampMs: bucket.firstTimestampMs ?? bucket.timestampMs,
        lastTimestampMs: bucket.lastTimestampMs ?? bucket.timestampMs,
      };
    }
    integerArithmetic &&= bucket.models.every((model) =>
      numericTotals.every(
        (key) => Number.isSafeInteger(model.totals[key]) && model.totals[key] >= 0,
      ),
    );
    for (const key of numericTotals) {
      canonicalTotal[key] += bucket.totals[key];
      integerArithmetic &&=
        Number.isSafeInteger(bucket.totals[key]) &&
        bucket.totals[key] >= 0 &&
        Number.isSafeInteger(canonicalTotal[key]);
    }
  }
  for (const day of days.values()) {
    for (const bucket of Object.values(day.buckets)) {
      for (const key of numericTotals) {
        groupedTotal[key] += bucket.totals[key];
      }
    }
  }
  // Any regrouping must remain exact for every subrange, not just the full sum.
  canonicalNumbers ||= regrouped && !integerArithmetic;
  canonicalNumbers ||= numericTotals.some((key) => canonicalTotal[key] !== groupedTotal[key]);
  const checkpoint = {
    ...entry,
    rollup: {
      ...createSessionUsageRollupData(),
      lastUserTimestamp: entry.rollup.lastUserTimestamp,
      untimestamped: entry.rollup.untimestamped,
    },
  };
  const encoded = encodeUsageCostRollup(checkpoint);
  const envelope: UsageCostRollupEnvelope = JSON.parse(encoded.valueJson);
  envelope.projection = { version: 1, dates: [...days.keys()], canonicalNumbers };
  return {
    valueJson: JSON.stringify(envelope),
    blob: encoded.blob,
    partitions: [...days].map(([date, rollup]) => encodeUsageCostPartition(date, rollup)),
  };
}
