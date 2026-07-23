import type { ToolCallRecord } from "../logging/diagnostic-session-state.js";

const MIN_STABLE_CALLS_PER_VARIANT = 3;
const MAX_PROBE_CALL_SHARE = 0.2;

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

  const allOutcomes = Array.from(outcomes.values());
  const count = allOutcomes.reduce((sum, outcome) => sum + outcome.count, 0);
  const stableOutcomes = allOutcomes.filter(
    (outcome) => outcome.count >= MIN_STABLE_CALLS_PER_VARIANT,
  );
  const stableCallCount = stableOutcomes.reduce((sum, outcome) => sum + outcome.count, 0);
  const probeCallCount = count - stableCallCount;
  const maxProbeCallCount = Math.max(1, Math.floor(count * MAX_PROBE_CALL_SHARE));

  // Three observations distinguish sustained churn from an ordinary two-pass batch.
  // A small share of novel probes may interrupt the loop without erasing its evidence.
  const hasStableChurn = stableOutcomes.length > 1 && probeCallCount <= maxProbeCallCount;
  return hasStableChurn
    ? { count, variantCount: stableOutcomes.length }
    : { count: 0, variantCount: 0 };
}
