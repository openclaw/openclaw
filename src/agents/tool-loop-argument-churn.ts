import type { ToolCallRecord } from "../logging/diagnostic-session-state.js";

export function getArgumentChurnNoProgressStreak(
  history: readonly ToolCallRecord[],
  toolName: string,
): { count: number; variantCount: number } {
  const outcomes = new Map<string, { resultHash: string; count: number }>();
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const record = history[i];
    if (!record || record.toolName !== toolName || !record.resultHash) {
      break;
    }
    const previous = outcomes.get(record.argsHash);
    if (previous && previous.resultHash !== record.resultHash) {
      break;
    }
    outcomes.set(record.argsHash, {
      resultHash: record.resultHash,
      count: (previous?.count ?? 0) + 1,
    });
  }

  // Do not classify one-shot batches or changing results as no progress.
  const variantCount = outcomes.size;
  const repeatedStableVariants =
    variantCount > 1 && Array.from(outcomes.values()).every((outcome) => outcome.count >= 2);
  const count = Array.from(outcomes.values()).reduce((sum, outcome) => sum + outcome.count, 0);
  return repeatedStableVariants ? { count, variantCount } : { count: 0, variantCount: 0 };
}
