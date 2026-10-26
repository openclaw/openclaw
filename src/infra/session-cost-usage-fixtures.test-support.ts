import { partitionUsageCostRollup } from "./session-cost-usage-partitions.js";
import {
  encodeUsageCostRollup,
  USAGE_COST_ROLLUP_VERSION,
  type UsageCostRollupEntry,
} from "./session-cost-usage-rollup-codec.js";

export function createUsageTranscriptEntry(
  totalTokens: number,
  options: { cost?: number } & Partial<
    Record<"timestamp" | "provider" | "model" | "content", string>
  > = {},
) {
  const { timestamp = "2026-09-18T00:00:00Z", cost, ...message } = options;
  return {
    type: "message",
    timestamp,
    message: {
      role: "assistant",
      ...message,
      usage: {
        input: totalTokens,
        output: 0,
        totalTokens,
        ...(cost === undefined ? {} : { cost: { total: cost } }),
      },
    },
  };
}

export function createUsageCheckpoint(size: number, observedMtimeMs = 1, inode = 1) {
  return {
    kind: "jsonl" as const,
    parsedOffset: size,
    observedSize: size,
    observedMtimeMs,
    device: 1,
    inode,
    anchorHash: "anchor",
  };
}

export function createUsageRollupEntry(
  rollup: UsageCostRollupEntry["rollup"],
  overrides: Partial<UsageCostRollupEntry> = {},
): UsageCostRollupEntry {
  return {
    version: USAGE_COST_ROLLUP_VERSION,
    pricingFingerprint: "first",
    scannedAt: 1,
    parsedRecords: 4,
    countedRecords: 4,
    checkpoint: createUsageCheckpoint(4),
    rollup,
    ...overrides,
  };
}

export function encodeOversizedUsageRollup(
  source: UsageCostRollupEntry,
  variant: "stored body" | "compressed body" | "compressed partition" | "corrupt-length",
  toolPrefix = "synthetic-tool-",
) {
  const entry = structuredClone(source);
  const partition = variant === "compressed partition";
  const timestampMs = Date.UTC(2026, 8, 18);
  const bucket = partition
    ? (entry.rollup.buckets[String(timestampMs)] = {
        ...entry.rollup.untimestamped,
        timestampMs,
        latency: { centroids: [], count: 0, max: 0, sum: 0 },
      })
    : entry.rollup.untimestamped;
  if (variant !== "corrupt-length") {
    bucket.tools = [
      {
        name: toolPrefix + "x".repeat((variant === "stored body" ? 2 : 35) * 1024 * 1024),
        count: 1,
      },
    ];
  }
  const encoded = partition
    ? partitionUsageCostRollup(entry)
    : { ...encodeUsageCostRollup(entry), partitions: [] };
  const envelope = JSON.parse(encoded.valueJson);
  if (variant === "stored body") {
    encoded.blob = Uint8Array.from(Buffer.from(JSON.stringify(entry.rollup)));
    envelope.body.encoding = "identity";
    envelope.body.storedBytes = encoded.blob.byteLength;
  } else if (variant === "corrupt-length") {
    envelope.body.bytes = 35 * 1024 * 1024;
  }
  encoded.valueJson = JSON.stringify(envelope);
  return encoded;
}
