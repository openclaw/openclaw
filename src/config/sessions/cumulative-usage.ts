import type { SessionCumulativeUsage, SessionEntry } from "./types.js";

function resolveNonNegativeCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Accumulate per-session token usage totals that survive gateway restarts.
 * These totals are additive and intentionally separate from the latest-run
 * snapshot fields (`inputTokens`, `outputTokens`, `totalTokens`, etc.).
 */
export function accumulateSessionCumulativeUsage(
  entry: Pick<SessionEntry, "cumulativeUsage"> | undefined,
  delta: {
    inputTokens?: number;
    outputTokens?: number;
    toolTokens?: number;
    compactionOverheadTokens?: number;
  },
  updatedAt = Date.now(),
): SessionCumulativeUsage | undefined {
  const nextInput = resolveNonNegativeCount(delta.inputTokens);
  const nextOutput = resolveNonNegativeCount(delta.outputTokens);
  const nextTool = resolveNonNegativeCount(delta.toolTokens);
  const nextCompaction = resolveNonNegativeCount(delta.compactionOverheadTokens);
  const previous = entry?.cumulativeUsage;

  if (!previous && nextInput + nextOutput + nextTool + nextCompaction <= 0) {
    return undefined;
  }

  return {
    inputTokens: resolveNonNegativeCount(previous?.inputTokens) + nextInput,
    outputTokens: resolveNonNegativeCount(previous?.outputTokens) + nextOutput,
    toolTokens: resolveNonNegativeCount(previous?.toolTokens) + nextTool,
    compactionOverheadTokens:
      resolveNonNegativeCount(previous?.compactionOverheadTokens) + nextCompaction,
    updatedAt,
  };
}
