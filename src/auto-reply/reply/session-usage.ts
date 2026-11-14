import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ModelRef } from "../../agents/model-ref-shared.js";
import { hasBillableUsage, hasNonzeroUsage, type NormalizedUsage } from "../../agents/usage.js";
import type { SessionEntryUsageUpdate } from "../../config/sessions/session-entry-usage.js";
import type { SessionEntry, SessionSystemPromptReport } from "../../config/sessions/types.js";

type SessionUsageUpdateParams = {
  estimatedCostUsd?: number;
  usage?: NormalizedUsage;
  /**
   * Usage from the last individual API call (not accumulated). Supplies context
   * only when no chronology-qualified currentContextSnapshot was observed.
   */
  lastCallUsage?: NormalizedUsage;
  modelUsed?: string;
  providerUsed?: string;
  /** Session selection can differ from the response model used for billing. */
  runtimeModelSelection?: ModelRef;
  agentHarnessId?: string;
  contextTokensUsed?: number;
  contextTokensSource?: SessionEntry["contextTokensSource"];
  contextBudgetStatus?: SessionEntry["contextBudgetStatus"];
  promptTokens?: number;
  systemPromptReport?: SessionSystemPromptReport;
  /** Presence overrides usage inference; undefined tokens explicitly mean current context is unknown. */
  currentContextSnapshot?: { tokens: number | undefined };
  preserveFreshTotalTokensOnStaleUsage?: boolean;
  preserveRuntimeModel?: boolean;
  preserveUserFacingSessionModelState?: boolean;
};

/** Prepare usage facts without choosing a persistence envelope. */
export function prepareSessionUsageUpdate(params: SessionUsageUpdateParams) {
  const modelSelection = params.runtimeModelSelection ?? {
    provider: params.providerUsed,
    model: params.modelUsed,
  };
  const hasUsage = hasNonzeroUsage(params.usage);
  const hasBilling = hasBillableUsage(params.usage);
  const hasPromptTokens =
    params.promptTokens !== undefined &&
    Number.isFinite(params.promptTokens) &&
    params.promptTokens > 0;
  const hasUsableLastCallUsage =
    Boolean(params.lastCallUsage) && params.lastCallUsage?.contextUsage?.state !== "unavailable";
  const hasFreshContextSnapshot = hasUsableLastCallUsage || hasPromptTokens;
  const hasCurrentContextSnapshot = params.currentContextSnapshot !== undefined;

  // A monetary-only update must not invalidate the existing context observation.
  const hasContextUpdate =
    params.usage?.usageReport?.state === "unavailable" ||
    hasUsage ||
    hasFreshContextSnapshot ||
    hasCurrentContextSnapshot ||
    Boolean(modelSelection.model || params.contextTokensUsed);
  if (!hasBilling && !hasContextUpdate) {
    return undefined;
  }
  const preserveUserFacingRunState = params.preserveUserFacingSessionModelState === true;
  const currentContextTokens = asNonNegativeFiniteNumber(params.currentContextSnapshot?.tokens);
  const update: SessionEntryUsageUpdate = {
    usage: params.usage,
    estimatedCostUsd:
      preserveUserFacingRunState || !hasBilling
        ? undefined
        : asNonNegativeFiniteNumber(params.estimatedCostUsd),
    lastCallUsage: params.lastCallUsage,
    modelSelection,
    agentHarnessId: normalizeOptionalString(params.agentHarnessId),
    contextTokensUsed: params.contextTokensUsed,
    contextTokensSource: params.contextTokensSource,
    contextBudgetStatus: params.contextBudgetStatus,
    systemPromptReport: params.systemPromptReport,
    promptTokens: params.promptTokens,
    currentContextTokens:
      currentContextTokens === undefined ? undefined : Math.floor(currentContextTokens),
    hasContextUpdate,
    hasFreshContextSnapshot,
    hasCurrentContextSnapshot,
    preserveSessionModelState: params.preserveRuntimeModel === true || preserveUserFacingRunState,
    preserveUserFacingRunState,
    preserveFreshTotalTokensOnStaleUsage: params.preserveFreshTotalTokensOnStaleUsage,
  };
  return update;
}
