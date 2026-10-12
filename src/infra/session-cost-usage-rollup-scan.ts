import type { ModelCostConfig } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { scanSessionTranscriptTree } from "../config/sessions/transcript-tree.js";
import { selectVisibleTranscriptEvents } from "../config/sessions/transcript-visible-events.js";
import { sha256Base64Url } from "./crypto-digest.js";
import {
  computeUsageTokenTotals,
  parseUsageCostTranscriptRecord,
  needsUsageCostEstimate,
  applyUsageCostEstimate,
} from "./session-cost-usage-pricing.js";
import {
  USAGE_COST_ROLLUP_VERSION,
  type UsageCostJsonlCheckpoint,
  type UsageCostSqliteCheckpoint,
  type UsageCostRollupEntry,
} from "./session-cost-usage-rollup-codec.js";
import {
  appendSessionUsageRollupContribution,
  createSessionUsageRollupData,
} from "./session-cost-usage-rollup.js";
import { createEmptyCostUsageTotals as emptyTotals } from "./session-cost-usage-totals.js";
import type {
  CostUsageTotals,
  ParsedTranscriptEntry,
  UsageCostTranscriptFile,
} from "./session-cost-usage.types.js";

type UsageCostRollupScanInput = {
  previous?: UsageCostRollupEntry;
  pricingFingerprint: string;
  resolveCosts: (
    pairs: Array<{ provider?: string; model?: string }>,
  ) => Promise<Array<ModelCostConfig | undefined>>;
};

function hashUsageCostCheckpointEvent(event: unknown): string {
  return sha256Base64Url(JSON.stringify(event));
}

export function createUsageRollupScan(params: UsageCostRollupScanInput & { appendOnly: boolean }) {
  const previous = params.appendOnly ? params.previous : undefined;
  // This task exclusively owns the decoded body; publication retains its original envelope for CAS.
  const rollup = previous?.rollup ?? createSessionUsageRollupData();
  let countedRecords = 0;
  let parsedRecords = 0;
  return {
    async addRecords(records: Iterable<Record<string, unknown>>): Promise<void> {
      let batch: ParsedTranscriptEntry[] = [];
      const flush = async () => {
        const estimated = batch.filter(needsUsageCostEstimate);
        const costs = await params.resolveCosts(
          estimated.map(({ provider, model }) => ({ provider, model })),
        );
        for (let i = 0; i < estimated.length; i++) {
          applyUsageCostEstimate(estimated[i]!, () => costs[i]);
        }
        for (const entry of batch) {
          let usageTotals: CostUsageTotals | undefined;
          if (entry.usage) {
            usageTotals = emptyTotals();
            const tokens = computeUsageTokenTotals(entry.usage);
            usageTotals.input += tokens.input;
            usageTotals.output += tokens.output;
            usageTotals.cacheRead += tokens.cacheRead;
            usageTotals.cacheWrite += tokens.cacheWrite;
            usageTotals.totalTokens += tokens.totalTokens;
            const cost = entry.costBreakdown;
            if (cost?.total !== undefined) {
              usageTotals.totalCost += cost.total;
              usageTotals.inputCost += cost.input ?? 0;
              usageTotals.outputCost += cost.output ?? 0;
              usageTotals.cacheReadCost += cost.cacheRead ?? 0;
              usageTotals.cacheWriteCost += cost.cacheWrite ?? 0;
            } else if (entry.costTotal === undefined) {
              usageTotals.missingCostEntries = 1;
              const modelKey = `${normalizeOptionalString(entry.provider) ?? "unknown"}/${normalizeOptionalString(entry.model) ?? "unknown"}`;
              usageTotals.missingCostByModel = { [modelKey]: 1 };
            } else {
              usageTotals.totalCost += entry.costTotal;
            }
          }
          const timestamp = entry.timestamp?.getTime();
          appendSessionUsageRollupContribution(rollup, {
            timestamp,
            role: entry.role,
            durationMs: entry.durationMs,
            provider: entry.provider,
            model: entry.model,
            stopReason: entry.stopReason,
            toolNames: entry.toolNames,
            toolResultCounts: entry.toolResultCounts,
            usageTotals,
          });
          countedRecords += entry.usage && timestamp ? 1 : 0;
          parsedRecords += entry.usage ? 1 : 0;
        }
        batch = [];
      };
      for (const record of records) {
        const entry = parseUsageCostTranscriptRecord(record);
        if (entry) {
          batch.push(entry);
        }
        if (batch.length === 128) {
          await flush();
        }
      }
      if (batch.length > 0) {
        await flush();
      }
    },
    finish(checkpoint: UsageCostJsonlCheckpoint | UsageCostSqliteCheckpoint): UsageCostRollupEntry {
      return {
        version: USAGE_COST_ROLLUP_VERSION,
        pricingFingerprint: params.pricingFingerprint,
        checkpoint,
        scannedAt: Date.now(),
        parsedRecords: (previous?.parsedRecords ?? 0) + parsedRecords,
        countedRecords: (previous?.countedRecords ?? 0) + countedRecords,
        rollup,
      };
    },
  };
}

/** Memory snapshots are immutable; no post-scan source probe or database lease is needed. */
export async function scanMemoryUsageCostRollup(params: {
  file: UsageCostTranscriptFile;
  events: Array<{ seq: number; eventJson: string }>;
  pricingFingerprint: string;
  resolveCosts: UsageCostRollupScanInput["resolveCosts"];
}): Promise<UsageCostRollupEntry> {
  const records = params.events.map(({ eventJson }): unknown => JSON.parse(eventJson));
  const scan = createUsageRollupScan({ ...params, appendOnly: false });
  await scan.addRecords(selectVisibleTranscriptEvents(records).filter(isRecord));
  const visibleLeafId = scanSessionTranscriptTree(records).leafId;
  return scan.finish({
    kind: "sqlite",
    maxSeq: params.file.maxSeq ?? 0,
    eventCount: params.file.eventCount ?? 0,
    size: params.file.size,
    mtimeMs: params.file.mtimeMs,
    anchorHash:
      records.length > 0 ? hashUsageCostCheckpointEvent(records.at(-1)) : sha256Base64Url(""),
    ...(visibleLeafId ? { visibleLeafId } : {}),
  });
}
