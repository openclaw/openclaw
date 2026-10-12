import { deriveSessionTotalTokens, type NormalizedUsage } from "../../agents/usage.js";
import { qualifySessionContextTokenSource } from "./context-token-provenance.js";
import { accountSessionGoalUsage } from "./goals-transitions.js";
import { SESSION_TOTAL_TOKENS_VERSION, type SessionEntry } from "./types.js";

export type SessionEntryUsageUpdate = {
  usage?: NormalizedUsage;
  lastCallUsage?: NormalizedUsage;
  modelSelection: { provider?: string; model?: string };
  agentHarnessId?: string;
  contextTokensUsed?: number;
  contextTokensSource?: SessionEntry["contextTokensSource"];
  authProfileId?: string | null;
  contextBudgetStatus?: SessionEntry["contextBudgetStatus"];
  systemPromptReport?: SessionEntry["systemPromptReport"];
  promptTokens?: number;
  estimatedCostUsd?: number;
  currentContextTokens?: number;
  hasUsage: boolean;
  hasBilling: boolean;
  hasContextUpdate: boolean;
  hasFreshContextSnapshot: boolean;
  hasCurrentContextSnapshot: boolean;
  preserveSessionModelState: boolean;
  preserveUserFacingRunState: boolean;
  preserveFreshTotalTokensOnStaleUsage?: boolean;
};

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
          contextTokensSource: qualifySessionContextTokenSource({
            entry,
            authProfileId: update.authProfileId,
            source: update.contextTokensSource,
          }),
          contextBudgetStatus: update.contextBudgetStatus,
        }
      : {}),
    ...(resolvedContextTokens !== undefined ? { contextTokens: resolvedContextTokens } : {}),
    systemPromptReport: update.preserveUserFacingRunState
      ? entry.systemPromptReport
      : (update.systemPromptReport ?? entry.systemPromptReport),
    updatedAt,
  };
  if (update.hasUsage && !update.preserveUserFacingRunState) {
    patch.inputTokens = update.usage?.input ?? 0;
    patch.outputTokens = update.usage?.output ?? 0;
    const cacheUsage = update.lastCallUsage ?? update.usage;
    patch.cacheRead = cacheUsage?.cacheRead ?? 0;
    patch.cacheWrite = cacheUsage?.cacheWrite ?? 0;
  }
  if (update.hasBilling && !update.preserveUserFacingRunState) {
    // Unknown current cost clears the prior run's amount instead of attaching it to new tokens.
    patch.estimatedCostUsd = update.estimatedCostUsd;
  }
  if (totalTokens !== undefined && !update.preserveUserFacingRunState) {
    patch.totalTokens = totalTokens;
    patch.totalTokensFresh = true;
    patch.totalTokensVersion = SESSION_TOTAL_TOKENS_VERSION;
    const accountedGoal = accountSessionGoalUsage({ ...entry, ...patch }, updatedAt);
    if (accountedGoal) {
      patch.goal = accountedGoal;
    }
  } else if (
    !update.preserveUserFacingRunState &&
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
