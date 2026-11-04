import {
  resolveSessionArchiveReadPathPrefix,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "../config/sessions/archive-compression.js";
import type { SessionCostUsageRollupRow } from "./session-cost-usage-cache.kernel.js";
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
    const prefixEnd = key.indexOf("-", key.lastIndexOf("/")) + 1;
    return prefixEnd > 0 ? currentKeys.get(key.slice(0, prefixEnd)) : undefined;
  };
}
