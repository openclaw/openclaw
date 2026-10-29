import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sha256Hex } from "./crypto-digest.js";
import {
  encodeUsageCostQuarters,
  type UsageCostQuarterRow,
} from "./session-cost-usage-quarters.js";
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
import { resolveZstdCodec } from "./zstd-codec.js";

export const LEGACY_USAGE_COST_PARTITION_SCOPE = "session-cost-usage-projection-v1";
export const USAGE_COST_PARTITION_SCOPE = "session-cost-usage-projection-v2";
export const USAGE_COST_QUARTER_MS = 15 * 60 * 1000;
const codec = resolveZstdCodec();

export type UsageCostPartition = {
  date: string;
  valueJson: string;
  blob: Uint8Array;
  /** Report summary committed with this partition; absent on partitions read back. */
  quarters?: UsageCostQuarterRow;
};

export function usageCostPartitionKey(sessionFile: string, date: string): string {
  // JSON escapes path delimiters and NULs before the key reaches PostgreSQL text.
  return `${JSON.stringify(sessionFile)}:${date}`;
}

export function readUsageCostPartitionKey(key: string): { sessionFile: string; date: string } {
  const separator = key.lastIndexOf(":");
  const sessionFile: unknown = JSON.parse(key.slice(0, separator));
  if (typeof sessionFile !== "string") {
    throw new Error("Invalid usage partition key");
  }
  return { sessionFile, date: key.slice(separator + 1) };
}

function encodeUsageCostPartition(
  date: string,
  rollup: SessionUsageRollupData,
): UsageCostPartition & { blob: Uint8Array<ArrayBuffer> } {
  const raw = Buffer.from(JSON.stringify(rollup));
  const compressed = raw.byteLength >= 1024 ? codec.compress(raw, 1) : undefined;
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
): SessionUsageRollupData | undefined;
export function decodeUsageCostPartition(
  valueJson: string,
  blob: Uint8Array | null,
  budget: { remainingBytes: number },
): SessionUsageRollupData | null | undefined;
export function decodeUsageCostPartition(
  valueJson: string,
  blob: Uint8Array | null,
  budget?: { remainingBytes: number },
): SessionUsageRollupData | null | undefined {
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
      (metadata.encoding === "identity"
        ? metadata.bytes !== blob.byteLength
        : metadata.bytes <= blob.byteLength) ||
      typeof metadata.sha256 !== "string"
    ) {
      return undefined;
    }
    if (budget) {
      if (metadata.bytes > budget.remainingBytes) {
        return null;
      }
      budget.remainingBytes -= metadata.bytes;
    }
    const raw =
      metadata.encoding === "zstd"
        ? codec.decompress(blob, metadata.bytes)
        : Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
    if (raw.byteLength !== metadata.bytes || sha256Hex(raw) !== metadata.sha256) {
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

export function partitionUsageCostRollup(entry: UsageCostRollupEntry): {
  valueJson: string;
  blob: Uint8Array<ArrayBuffer>;
  partitions: Array<UsageCostPartition & { blob: Uint8Array<ArrayBuffer> }>;
} {
  const months = new Map<string, SessionUsageRollupData>();
  const buckets = Object.values(entry.rollup.buckets).toSorted(
    (left, right) => left.timestampMs - right.timestampMs,
  );
  for (const bucket of buckets) {
    const quarter = Math.floor(bucket.timestampMs / USAGE_COST_QUARTER_MS) * USAGE_COST_QUARTER_MS;
    // Pack sparse quarters together so small daily rows do not defeat compression.
    const date = `${new Date(quarter).toISOString().slice(0, 7)}-01`;
    let month = months.get(date);
    if (!month) {
      month = createSessionUsageRollupData();
      months.set(date, month);
    }
    const current = month.buckets[String(quarter)];
    if (current) {
      mergeSessionUsageRollupBucket(current, bucket);
    } else {
      month.buckets[String(quarter)] = {
        ...structuredClone(bucket),
        timestampMs: quarter,
        firstTimestampMs: bucket.firstTimestampMs ?? bucket.timestampMs,
        lastTimestampMs: bucket.lastTimestampMs ?? bucket.timestampMs,
      };
    }
  }
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
  // Keep the existing envelope shape; report readers accept aggregate rounding.
  envelope.projection = { version: 3, dates: [...months.keys()], canonicalNumbers: false };
  return {
    valueJson: JSON.stringify(envelope),
    blob: encoded.blob,
    partitions: [...months].map(([date, rollup]) =>
      Object.assign(encodeUsageCostPartition(date, rollup), {
        quarters: encodeUsageCostQuarters(date, rollup),
      }),
    ),
  };
}
