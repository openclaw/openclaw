import { sha256Hex } from "./crypto-digest.js";
import type { SessionCostUsageRollupRow } from "./session-cost-usage-cache.kernel.js";
import {
  isUsageCostRollupFresh,
  type UsageCostFreshnessCheckpoint,
} from "./session-cost-usage-rollup-codec.js";
import type { UsageCostTranscriptFile } from "./session-cost-usage.types.js";

/** The refresh worker retains only the latest target's digests and copied freshness fields. */
export class UsageCostRefreshCheckpoints {
  private target: string | undefined;
  private readonly rows = new Map<
    string,
    { fingerprint: string; checkpoint: UsageCostFreshnessCheckpoint }
  >();

  prepare(target: string | undefined, files: ReadonlyMap<string, unknown>): void {
    if (target !== this.target) {
      this.rows.clear();
      this.target = target;
    }
    for (const key of this.rows.keys()) {
      if (!files.has(key)) {
        this.rows.delete(key);
      }
    }
  }

  isFresh(row: SessionCostUsageRollupRow, file: UsageCostTranscriptFile): boolean {
    const retained = this.rows.get(row.key);
    if (
      retained &&
      isUsageCostRollupFresh({ checkpoint: retained.checkpoint, file }) &&
      retained.fingerprint === sha256Hex(row.valueJson)
    ) {
      return true;
    }
    this.rows.delete(row.key);
    return false;
  }

  remember(key: string, valueJson: string, checkpoint: UsageCostFreshnessCheckpoint): void {
    if (this.target === undefined) {
      return;
    }
    // Copy named primitives, never the decoded checkpoint's unknown fields or rollup graph.
    const copied: UsageCostFreshnessCheckpoint =
      checkpoint.kind === "jsonl"
        ? {
            kind: "jsonl",
            observedSize: checkpoint.observedSize,
            observedMtimeMs: checkpoint.observedMtimeMs,
            device: checkpoint.device,
            inode: checkpoint.inode,
          }
        : {
            kind: "sqlite",
            maxSeq: checkpoint.maxSeq,
            eventCount: checkpoint.eventCount,
            size: checkpoint.size,
            mtimeMs: checkpoint.mtimeMs,
          };
    this.rows.set(key, { fingerprint: sha256Hex(valueJson), checkpoint: copied });
  }
}
