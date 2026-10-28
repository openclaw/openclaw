import { isDeepStrictEqual } from "node:util";
import type { SelectionRow } from "./session-row-projection-record.js";

// Search and live-run queries bypass retained partitions; display facts publish separately.
const presentationFields = new Set<string>([
  "activeWriterRunId",
  "activitySummary",
  "sessionDiffBaseline",
  "sessionDiffBaselineCapture",
  "pendingFinalDelivery",
  "contextBudgetStatus",
  "abortedLastRun",
  "startedAt",
  "inputTokens",
  "outputTokens",
  "cacheRead",
  "cacheWrite",
  "estimatedCostUsd",
  "contextTokens",
  "contextTokensSource",
  "totalTokens",
  "totalTokensFresh",
  "totalTokensVersion",
  "usageReport",
] satisfies (keyof SelectionRow["entry"])[]);

export function sameSelectionFacts(previous: SelectionRow, next: SelectionRow) {
  if (
    previous.key !== next.key ||
    previous.agentId !== next.agentId ||
    previous.storeTarget.storePath !== next.storeTarget.storePath ||
    previous.generation !== next.generation ||
    previous.hasBoard !== next.hasBoard ||
    previous.entry.updatedAt !== next.entry.updatedAt ||
    !isDeepStrictEqual(previous.selection, next.selection)
  ) {
    return false;
  }
  if (previous.entry === next.entry) {
    return true;
  }
  const before = new Map<string, unknown>(
    Object.entries(previous.entry).filter(([field]) => !presentationFields.has(field)),
  );
  const after = new Map<string, unknown>(
    Object.entries(next.entry).filter(([field]) => !presentationFields.has(field)),
  );
  return isDeepStrictEqual(before, after);
}
