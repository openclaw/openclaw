import { isDeepStrictEqual } from "node:util";
import type { SessionStoreTarget } from "../config/sessions/targets.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import type { readSessionListSelectionFacts } from "./session-list-target.js";

/** Accepted selection facts exclude replaceable display graphs. */
export type SelectionRow = {
  key: string;
  agentId: string;
  storeTarget: SessionStoreTarget;
  entry: SessionEntry;
  selection: ReturnType<typeof readSessionListSelectionFacts>;
  hasBoard?: boolean;
  generation: string | symbol;
  selectionFactsRevision?: object;
};

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
  return sameSelectionEntry(previous.entry, next.entry);
}

function sameSelectionEntry<T extends object>(before: T, after: T) {
  for (const field in before) {
    if (Object.hasOwn(before, field) && !presentationFields.has(field)) {
      if (
        !Object.prototype.propertyIsEnumerable.call(after, field) ||
        !isDeepStrictEqual(before[field], after[field])
      ) {
        return false;
      }
    }
  }
  for (const field in after) {
    if (
      Object.hasOwn(after, field) &&
      !presentationFields.has(field) &&
      !Object.prototype.propertyIsEnumerable.call(before, field)
    ) {
      return false;
    }
  }
  return true;
}
