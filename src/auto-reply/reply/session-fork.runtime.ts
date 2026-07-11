/**
 * Lazy runtime seam for parent-fork token counting. File-era transcript tail
 * reads flow through gateway fs helpers; the SQLite flip estimates parent
 * tokens inside the storage boundary instead.
 */
import fs from "node:fs/promises";
import { derivePromptTokens } from "../../agents/usage.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../../config/sessions/paths.js";
import {
  resolveFreshSessionTotalTokens,
  type SessionEntry as StoreSessionEntry,
} from "../../config/sessions/types.js";
import { readLatestRecentSessionUsageFromTranscriptAsync } from "../../gateway/session-utils.fs.js";

const FALLBACK_TRANSCRIPT_BYTES_PER_TOKEN = 4;

function resolvePositiveTokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function maxPositiveTokenCount(...values: Array<number | undefined>): number | undefined {
  let max: number | undefined;
  for (const value of values) {
    const normalized = resolvePositiveTokenCount(value);
    if (typeof normalized === "number" && (max === undefined || normalized > max)) {
      max = normalized;
    }
  }
  return max;
}

async function estimateParentTranscriptTokensFromBytes(params: {
  parentEntry: StoreSessionEntry;
  storePath: string;
}): Promise<number | undefined> {
  try {
    const filePath = resolveSessionFilePath(
      params.parentEntry.sessionId,
      params.parentEntry,
      resolveSessionFilePathOptions({ storePath: params.storePath }),
    );
    const stat = await fs.stat(filePath);
    return resolvePositiveTokenCount(Math.ceil(stat.size / FALLBACK_TRANSCRIPT_BYTES_PER_TOKEN));
  } catch {
    return undefined;
  }
}

/** Resolves the best available token count for a parent session before forking. */
export async function resolveParentForkTokenCountRuntime(params: {
  parentEntry: StoreSessionEntry;
  storePath: string;
}): Promise<number | undefined> {
  const freshPersistedTokens = resolveFreshSessionTotalTokens(params.parentEntry);
  if (typeof freshPersistedTokens === "number") {
    return freshPersistedTokens;
  }

  const cachedTokens = resolvePositiveTokenCount(params.parentEntry.totalTokens);
  const byteEstimateTokens = await estimateParentTranscriptTokensFromBytes(params);
  try {
    const usage = await readLatestRecentSessionUsageFromTranscriptAsync(
      params.parentEntry.sessionId,
      params.storePath,
      params.parentEntry.sessionFile,
      undefined,
      1024 * 1024,
    );
    let transcriptTokens: number | undefined;
    if (usage?.contextUsage?.state === "available") {
      const trailingTokens = Math.ceil(
        (usage.trailingBytes ?? 0) / FALLBACK_TRANSCRIPT_BYTES_PER_TOKEN,
      );
      transcriptTokens = resolvePositiveTokenCount(usage.contextUsage.totalTokens + trailingTokens);
      if (typeof transcriptTokens === "number") {
        return transcriptTokens;
      }
    } else if (usage?.contextUsage?.state !== "unavailable") {
      const promptTokens = resolvePositiveTokenCount(
        derivePromptTokens({
          input: usage?.inputTokens,
          cacheRead: usage?.cacheRead,
          cacheWrite: usage?.cacheWrite,
        }),
      );
      const outputTokens = resolvePositiveTokenCount(usage?.outputTokens);
      if (typeof promptTokens === "number") {
        transcriptTokens = promptTokens + (outputTokens ?? 0);
      }
    }
    if (typeof transcriptTokens === "number") {
      return maxPositiveTokenCount(transcriptTokens, cachedTokens, byteEstimateTokens);
    }
  } catch {
    // Fall back to cached totals when recent transcript usage cannot be read.
  }

  return maxPositiveTokenCount(cachedTokens, byteEstimateTokens);
}
