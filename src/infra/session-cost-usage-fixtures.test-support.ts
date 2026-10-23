import { partitionUsageCostRollup } from "./session-cost-usage-partitions.js";
import {
  encodeUsageCostRollup,
  USAGE_COST_ROLLUP_VERSION,
  type UsageCostRollupEntry,
} from "./session-cost-usage-rollup-codec.js";

export function createUsageTranscriptEntry(
  totalTokens: number,
  options: {
    timestamp?: string;
    cost?: number;
    provider?: string;
    model?: string;
    content?: string;
  } = {},
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
  if (variant !== "corrupt-length") {
    const tools = [
      {
        name: toolPrefix + "x".repeat((variant === "stored body" ? 2 : 35) * 1024 * 1024),
        count: 1,
      },
    ];
    if (variant === "compressed partition") {
      entry.rollup.buckets[String(Date.UTC(2026, 8, 18))] = {
        ...entry.rollup.untimestamped,
        tools,
        timestampMs: Date.UTC(2026, 8, 18),
        latency: { centroids: [], count: 0, max: 0, sum: 0 },
      };
    } else {
      entry.rollup.untimestamped.tools = tools;
    }
  }
  const encoded =
    variant === "compressed partition"
      ? partitionUsageCostRollup(entry)
      : { ...encodeUsageCostRollup(entry), partitions: [] };
  if (variant === "stored body") {
    encoded.blob = Uint8Array.from(Buffer.from(JSON.stringify(entry.rollup)));
    const envelope = JSON.parse(encoded.valueJson);
    envelope.body.encoding = "identity";
    envelope.body.storedBytes = encoded.blob.byteLength;
    encoded.valueJson = JSON.stringify(envelope);
  } else if (variant === "corrupt-length") {
    const envelope = JSON.parse(encoded.valueJson);
    envelope.body.bytes = 35 * 1024 * 1024;
    encoded.valueJson = JSON.stringify(envelope);
  }
  return encoded;
}
