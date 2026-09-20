import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { UsageCostTranscriptFile } from "./session-cost-usage-collection.js";
import type { SessionUsageRollupData } from "./session-cost-usage-rollup.js";

// Cache data is rebuildable. Semantic changes get a new version; old rows are
// ignored and rebuilt instead of normalized through a runtime compatibility path.
export const USAGE_COST_ROLLUP_VERSION = 6;

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
  valueJson: string;
};

export function decodeUsageCostRollup(
  valueJson: string,
  pricingFingerprint: string,
): UsageCostRollupEntry | undefined {
  try {
    const record: unknown = JSON.parse(valueJson);
    if (!isRecord(record)) {
      return undefined;
    }
    if (
      record.version !== USAGE_COST_ROLLUP_VERSION ||
      record.pricingFingerprint !== pricingFingerprint ||
      !record.checkpoint ||
      !record.rollup ||
      typeof record.scannedAt !== "number" ||
      typeof record.parsedRecords !== "number" ||
      typeof record.countedRecords !== "number"
    ) {
      return undefined;
    }
    // SAFETY: The current producer owns nested shapes; the reader validates the persisted envelope.
    return record as UsageCostRollupEntry;
  } catch {
    // Rebuildable cache row. The refresh path replaces it.
    return undefined;
  }
}

export function isUsageCostRollupFresh(params: {
  stored: UsageCostStoredRollup | undefined;
  file: UsageCostTranscriptFile;
}): boolean {
  const checkpoint = params.stored?.entry.checkpoint;
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
  stored: UsageCostStoredRollup | undefined;
  file: UsageCostTranscriptFile;
}): boolean {
  const checkpoint = params.stored?.entry.checkpoint;
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
