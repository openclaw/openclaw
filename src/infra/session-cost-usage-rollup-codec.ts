import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sha256Hex } from "./crypto-digest.js";
import type { SessionUsageRollupData } from "./session-cost-usage-rollup.js";
import type { UsageCostTranscriptFile } from "./session-cost-usage.types.js";
import { resolveZstdCodec } from "./zstd-codec.js";

// Cache data is rebuildable. Semantic changes get a new version; old rows are
// ignored and rebuilt instead of normalized through a runtime compatibility path.
export const USAGE_COST_ROLLUP_VERSION = 6;
const USAGE_COST_ROLLUP_FORMAT_VERSION = 1;
export const USAGE_COST_ROLLUP_SCOPE = "session-cost-usage-rollup-v3";
const zstd = resolveZstdCodec();

export type UsageCostJsonlCheckpoint = {
  kind: "jsonl";
  parsedOffset: number;
  observedSize: number;
  observedMtimeMs: number;
  device: number;
  inode: number;
  anchorHash: string;
};

export type UsageCostSqliteCheckpoint = {
  kind: "sqlite";
  maxSeq: number;
  eventCount: number;
  size: number;
  mtimeMs: number;
  anchorHash: string;
  visibleLeafId?: string;
};

export type UsageCostRollupEntry = {
  version: number;
  pricingFingerprint: string;
  checkpoint: UsageCostJsonlCheckpoint | UsageCostSqliteCheckpoint;
  scannedAt: number;
  parsedRecords: number;
  countedRecords: number;
  rollup: SessionUsageRollupData;
};

export type UsageCostStoredRollup = {
  entry: UsageCostRollupEntry;
};

export type UsageCostRollupEnvelope = Omit<UsageCostRollupEntry, "rollup"> & {
  format: typeof USAGE_COST_ROLLUP_FORMAT_VERSION;
  body: {
    encoding: "identity" | "zstd";
    bytes: number;
    storedBytes: number;
    utf16Length: number;
    sha256: string;
  };
};

export function encodeUsageCostRollup(entry: UsageCostRollupEntry): {
  valueJson: string;
  blob: Uint8Array<ArrayBuffer>;
} {
  const json = JSON.stringify(entry.rollup);
  const raw = Buffer.from(json, "utf8");
  const compressed = raw.byteLength >= 1024 ? zstd?.compress(raw, 1) : undefined;
  const useCompressed = compressed !== undefined && compressed.byteLength < raw.byteLength;
  const bytes = useCompressed ? compressed : raw;
  const envelope: UsageCostRollupEnvelope = {
    version: entry.version,
    pricingFingerprint: entry.pricingFingerprint,
    checkpoint: entry.checkpoint,
    scannedAt: entry.scannedAt,
    parsedRecords: entry.parsedRecords,
    countedRecords: entry.countedRecords,
    format: USAGE_COST_ROLLUP_FORMAT_VERSION,
    body: {
      encoding: useCompressed ? "zstd" : "identity",
      bytes: raw.byteLength,
      storedBytes: bytes.byteLength,
      utf16Length: json.length,
      sha256: sha256Hex(raw),
    },
  };
  // Transfer ownership without exposing a pooled Buffer's backing allocation.
  return { valueJson: JSON.stringify(envelope), blob: Uint8Array.from(bytes) };
}

export type UsageCostFreshnessCheckpoint =
  | Pick<UsageCostJsonlCheckpoint, "kind" | "observedSize" | "observedMtimeMs" | "device" | "inode">
  | Pick<UsageCostSqliteCheckpoint, "kind" | "maxSeq" | "eventCount" | "size" | "mtimeMs">;

export function decodeUsageCostRollupEnvelope(
  valueJson: string,
  pricingFingerprint?: string,
): UsageCostRollupEnvelope | undefined {
  try {
    const record: unknown = JSON.parse(valueJson);
    if (!isRecord(record)) {
      return undefined;
    }
    if (
      record.version !== USAGE_COST_ROLLUP_VERSION ||
      record.format !== USAGE_COST_ROLLUP_FORMAT_VERSION ||
      typeof record.pricingFingerprint !== "string" ||
      (pricingFingerprint !== undefined && record.pricingFingerprint !== pricingFingerprint) ||
      !isRecord(record.checkpoint) ||
      (record.checkpoint.kind !== "jsonl" && record.checkpoint.kind !== "sqlite") ||
      typeof record.scannedAt !== "number" ||
      typeof record.parsedRecords !== "number" ||
      typeof record.countedRecords !== "number" ||
      !isRecord(record.body) ||
      (record.body.encoding !== "identity" && record.body.encoding !== "zstd") ||
      typeof record.body.bytes !== "number" ||
      !Number.isSafeInteger(record.body.bytes) ||
      record.body.bytes <= 0 ||
      typeof record.body.storedBytes !== "number" ||
      !Number.isSafeInteger(record.body.storedBytes) ||
      record.body.storedBytes <= 0 ||
      typeof record.body.utf16Length !== "number" ||
      !Number.isSafeInteger(record.body.utf16Length) ||
      record.body.utf16Length <= 0 ||
      typeof record.body.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(record.body.sha256)
    ) {
      return undefined;
    }
    // SAFETY: The current producer owns nested shapes; the reader validates the persisted envelope.
    return record as UsageCostRollupEnvelope;
  } catch {
    // Rebuildable cache row. The refresh path replaces it.
    return undefined;
  }
}

export function decodeUsageCostRollup(
  valueJson: string,
  pricingFingerprint: string,
  blob: Uint8Array | null,
): UsageCostRollupEntry | undefined {
  const envelope = decodeUsageCostRollupEnvelope(valueJson, pricingFingerprint);
  if (!envelope || !blob || blob.byteLength !== envelope.body.storedBytes) {
    return undefined;
  }
  try {
    const raw =
      envelope.body.encoding === "zstd"
        ? zstd?.decompress(blob, envelope.body.bytes)
        : Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
    if (!raw || raw.byteLength !== envelope.body.bytes || sha256Hex(raw) !== envelope.body.sha256) {
      return undefined;
    }
    const json = raw.toString("utf8");
    if (json.length !== envelope.body.utf16Length) {
      return undefined;
    }
    const rollup: unknown = JSON.parse(json);
    if (!isRecord(rollup) || !isRecord(rollup.buckets) || !isRecord(rollup.untimestamped)) {
      return undefined;
    }
    const { format: _format, body: _body, ...metadata } = envelope;
    // SAFETY: Hash-checked JSON was serialized by this cache owner; nested bucket semantics are versioned.
    return { ...metadata, rollup: rollup as SessionUsageRollupData };
  } catch {
    return undefined;
  }
}

export function isUsageCostRollupFresh(params: {
  checkpoint: UsageCostFreshnessCheckpoint | undefined;
  file: UsageCostTranscriptFile;
}): boolean {
  const { checkpoint } = params;
  if (!checkpoint || checkpoint.kind !== params.file.kind) {
    return false;
  }
  if (checkpoint.kind === "jsonl") {
    return (
      checkpoint.observedSize === params.file.size &&
      checkpoint.observedMtimeMs === params.file.mtimeMs &&
      checkpoint.device === params.file.device &&
      checkpoint.inode === params.file.inode
    );
  }
  return (
    checkpoint.size === params.file.size &&
    checkpoint.mtimeMs === params.file.mtimeMs &&
    checkpoint.eventCount === params.file.eventCount &&
    checkpoint.maxSeq === params.file.maxSeq
  );
}

export function canUseUsageCostRollupForPartial(params: {
  checkpoint: UsageCostRollupEntry["checkpoint"] | undefined;
  file: UsageCostTranscriptFile;
}): boolean {
  const checkpoint = params.checkpoint;
  if (!checkpoint || checkpoint.kind !== params.file.kind) {
    return false;
  }
  if (checkpoint.kind === "jsonl") {
    return (
      checkpoint.parsedOffset <= params.file.size &&
      checkpoint.device === params.file.device &&
      checkpoint.inode === params.file.inode
    );
  }
  return checkpoint.maxSeq <= (params.file.maxSeq ?? 0);
}
