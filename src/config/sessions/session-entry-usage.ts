import {
  deriveSessionTotalTokens,
  hasBillableUsage,
  hasNonzeroUsage,
  type NormalizedUsage,
} from "../../agents/usage.js";
import { accountSessionGoalUsage } from "./goals-transitions.js";
import { SESSION_TOTAL_TOKENS_VERSION, type SessionEntry } from "./types.js";

export type SessionEntryUsageUpdate = {
  usage?: NormalizedUsage;
  lastCallUsage?: NormalizedUsage;
  modelSelection: { provider?: string; model?: string };
  agentHarnessId?: string;
  contextTokensUsed?: number;
  contextTokensSource?: SessionEntry["contextTokensSource"];
  contextBudgetStatus?: SessionEntry["contextBudgetStatus"];
  systemPromptReport?: SessionEntry["systemPromptReport"];
  promptTokens?: number;
  estimatedCostUsd?: number;
  currentContextTokens?: number;
  hasContextUpdate: boolean;
  hasFreshContextSnapshot: boolean;
  hasCurrentContextSnapshot: boolean;
  preserveSessionModelState: boolean;
  preserveUserFacingRunState: boolean;
  preserveFreshTotalTokensOnStaleUsage?: boolean;
};

/** Both CLI and reply finalizers publish the same latest-run billing snapshot. */
export function projectSessionUsageSnapshot(
  usage: NormalizedUsage | undefined,
  estimatedCostUsd: number | undefined,
  lastCallUsage = usage,
): Partial<SessionEntry> {
  if (usage?.usageReport?.state === "unavailable") {
    return {
      usageReport: usage.usageReport,
      inputTokens: undefined,
      outputTokens: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
      estimatedCostUsd: undefined,
      totalTokens: undefined,
      totalTokensFresh: false,
      totalTokensVersion: undefined,
    };
  }
  if (!hasBillableUsage(usage)) {
    return {};
  }
  return {
    usageReport: usage.usageReport,
    ...(usage.usageReport?.state === "available" || hasNonzeroUsage(usage)
      ? {
          inputTokens: usage.input ?? 0,
          outputTokens: usage.output ?? 0,
          cacheRead: lastCallUsage?.cacheRead ?? 0,
          cacheWrite: lastCallUsage?.cacheWrite ?? 0,
        }
      : {}),
    estimatedCostUsd,
  };
}

/** Apply prepared billing facts to the transaction's current context and Goal state. */
export function projectSessionEntryUsageUpdate(
  entry: SessionEntry,
  update: SessionEntryUsageUpdate,
  updatedAt = Date.now(),
): Partial<SessionEntry> {
  const resolvedContextTokens = update.preserveSessionModelState
    ? entry.contextTokens
    : (update.contextTokensUsed ?? entry.contextTokens);
  // Arrival order owns context freshness; billing stays independent of that observation.
  const totalTokens = update.hasCurrentContextSnapshot
    ? update.currentContextTokens
    : update.hasFreshContextSnapshot
      ? deriveSessionTotalTokens({
          lastCallUsage: update.lastCallUsage,
          contextTokens: resolvedContextTokens,
          promptTokens: update.promptTokens,
        })
      : undefined;
  const patch: Partial<SessionEntry> = {
    modelProvider: update.preserveSessionModelState
      ? entry.modelProvider
      : (update.modelSelection.provider ?? entry.modelProvider),
    model: update.preserveSessionModelState
      ? entry.model
      : (update.modelSelection.model ?? entry.model),
    ...(!update.preserveSessionModelState
      ? {
          agentHarnessId: update.agentHarnessId,
          contextTokensSource: update.contextTokensSource,
          contextBudgetStatus: update.contextBudgetStatus,
        }
      : {}),
    ...(resolvedContextTokens !== undefined ? { contextTokens: resolvedContextTokens } : {}),
    systemPromptReport: update.preserveUserFacingRunState
      ? entry.systemPromptReport
      : (update.systemPromptReport ?? entry.systemPromptReport),
    updatedAt,
  };
  if (!update.preserveUserFacingRunState) {
    Object.assign(
      patch,
      projectSessionUsageSnapshot(update.usage, update.estimatedCostUsd, update.lastCallUsage),
    );
  }
  const updatesContext = !update.preserveUserFacingRunState || update.hasCurrentContextSnapshot;
  if (totalTokens !== undefined && updatesContext) {
    patch.totalTokens = totalTokens;
    patch.totalTokensFresh = true;
    patch.totalTokensVersion = SESSION_TOTAL_TOKENS_VERSION;
    if (!update.preserveUserFacingRunState) {
      const accountedGoal = accountSessionGoalUsage({ ...entry, ...patch }, updatedAt);
      if (accountedGoal) {
        patch.goal = accountedGoal;
      }
    }
  } else if (
    updatesContext &&
    update.hasContextUpdate &&
    (update.hasCurrentContextSnapshot ||
      update.preserveFreshTotalTokensOnStaleUsage !== true ||
      entry.totalTokensFresh !== true)
  ) {
    patch.totalTokensFresh = false;
    patch.totalTokensVersion = undefined;
  }
  return patch;
}
