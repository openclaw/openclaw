import path from "node:path";
import {
  resolveSessionArchiveReadPathPrefix,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "../config/sessions/archive-compression.js";
import type { SessionCostUsageRollupRow } from "./session-cost-usage-cache.kernel.js";
import {
  decodeUsageCostPartition,
  type UsageCostPartition,
} from "./session-cost-usage-partitions.js";
import {
  decodeUsageCostRollup,
  isUsageCostRollupFresh,
  USAGE_COST_ROLLUP_VERSION,
  type UsageCostRollupEntry,
  type UsageCostRollupEnvelope,
} from "./session-cost-usage-rollup-codec.js";
import type { UsageCostWorkerHostEffects } from "./session-cost-usage-worker.types.js";
import type { UsageCostTranscriptFile } from "./session-cost-usage.types.js";

type PruneRows = UsageCostWorkerHostEffects["prune-rows"]["input"];

/** Sends stale rollup rows to the host writer in bounded batches. */
export function createUsageCostRollupPruner(send: (rows: PruneRows) => Promise<void>) {
  let batch: PruneRows = [];
  let batchBytes = 0;
  const flush = async () => {
    if (batch.length === 0) {
      return;
    }
    // Settle each bounded snapshot before producing more, releasing writer custody between batches.
    await send(batch);
    batch = [];
    batchBytes = 0;
  };
  return {
    flush,
    async prune(row: SessionCostUsageRollupRow) {
      const value = new TextEncoder().encode(row.valueJson);
      const rowBytes = value.byteLength + 2 * row.key.length;
      // Preserve single-row delivery for oversized metadata without growing other batches.
      if (batch.length > 0 && (batch.length >= 1024 || batchBytes + rowBytes > 1024 * 1024)) {
        await flush();
      }
      batch.push({ key: row.key, value, updatedAt: row.updatedAt });
      batchBytes += rowBytes;
    },
  };
}

/**
 * A changed archive gets a new rollup key. Returns, for an earlier key of a live
 * archive, that archive's current key; the caller prunes the earlier row only
 * after the current identity commits, so an undecodable archive keeps its usage.
 */
export function createSupersededArchiveKeyResolver(files: readonly UsageCostTranscriptFile[]) {
  const currentKeys = new Map(
    files.flatMap((file) =>
      file.kind === "jsonl" && file.sourcePath.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX)
        ? [[resolveSessionArchiveReadPathPrefix(file.sourcePath), file.filePath] as const]
        : [],
    ),
  );
  return (key: string) => {
    // Cache keys are platform paths ending in "<hex hash>-<size>-<mtime>.jsonl".
    const name = path.basename(key);
    const hashEnd = name.indexOf("-") + 1;
    return hashEnd > 0
      ? currentKeys.get(path.join(path.dirname(key), name.slice(0, hashEnd)))
      : undefined;
  };
}

type RollupBody = { blob: Uint8Array | null };

/** Loads a committed rollup with its day partitions merged into its buckets. */
export async function loadUsageCostRollupEntry(
  row: SessionCostUsageRollupRow,
  envelope: UsageCostRollupEnvelope,
  read: {
    pricingFingerprint: string;
    readPartitionedBody: (
      row: SessionCostUsageRollupRow,
    ) => Promise<
      | (RollupBody & { partitions: UsageCostPartition[]; quarterDates: ReadonlySet<string> })
      | undefined
    >;
    readBody: (key: string) => Promise<RollupBody | undefined>;
  },
) {
  let priorPartitions: UsageCostPartition[] = [];
  let priorQuarterDates: ReadonlySet<string> = new Set();
  let body: RollupBody | undefined;
  if (envelope.projection) {
    const snapshot = await read.readPartitionedBody(row);
    body = snapshot;
    priorPartitions = snapshot?.partitions ?? [];
    priorQuarterDates = snapshot?.quarterDates ?? priorQuarterDates;
  } else {
    body = await read.readBody(row.key);
  }
  let entry: UsageCostRollupEntry | undefined = body
    ? decodeUsageCostRollup(row.valueJson, read.pricingFingerprint, body.blob)
    : undefined;
  if (entry && envelope.projection) {
    if (priorPartitions.length !== envelope.projection.dates.length) {
      entry = undefined;
    } else {
      for (const partition of priorPartitions) {
        const day = decodeUsageCostPartition(partition.valueJson, partition.blob);
        if (!day) {
          entry = undefined;
          break;
        }
        Object.assign(entry.rollup.buckets, day.buckets);
      }
    }
  }
  return { entry, priorPartitions, priorQuarterDates };
}

/**
 * Re-keys an undecodable archive's last committed usage to its current identity.
 * Reports read only that identity and see it as stale; the matching identity keeps
 * the archive from being rescanned until its bytes change again.
 */
export function carryUsageCostRollupToFile(
  carried: UsageCostRollupEntry,
  file: UsageCostTranscriptFile,
): UsageCostRollupEntry | undefined {
  if (carried.checkpoint.kind !== "jsonl") {
    return undefined;
  }
  return {
    ...carried,
    version: USAGE_COST_ROLLUP_VERSION,
    checkpoint: {
      ...carried.checkpoint,
      parsedOffset: file.size,
      observedSize: file.size,
      observedMtimeMs: file.mtimeMs,
      device: file.device ?? 0,
      inode: file.inode ?? 0,
      undecodable: 1,
    },
  };
}

/** A carried archive stays stale for readers but is rescanned only after its bytes change. */
export function isCarriedArchiveCurrent(
  checkpoint: UsageCostRollupEntry["checkpoint"] | undefined,
  file: UsageCostTranscriptFile,
): boolean {
  return (
    checkpoint?.kind === "jsonl" &&
    checkpoint.undecodable !== undefined &&
    isUsageCostRollupFresh({ checkpoint: { ...checkpoint, undecodable: undefined }, file })
  );
}

/** Prior rows of archives whose current identity has no committed rollup yet. */
export function collectSupersededArchiveRows(
  rows: readonly SessionCostUsageRollupRow[],
  supersededArchiveKey: (key: string) => string | undefined,
  committed: ReadonlyMap<string, unknown>,
) {
  return rows.flatMap((row) => {
    const current = supersededArchiveKey(row.key);
    return current && current !== row.key && !committed.has(current) ? [{ row, current }] : [];
  });
}
