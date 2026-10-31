import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ModelRef } from "../../agents/model-ref-shared.js";
import { hasBillableUsage, hasNonzeroUsage, type NormalizedUsage } from "../../agents/usage.js";
import { getRuntimeConfig } from "../../config/config.js";
import { accountSessionGoalUsage } from "../../config/sessions/goals-transitions.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { SessionEntryUsageUpdate } from "../../config/sessions/session-entry-usage.js";
import {
  SESSION_TOTAL_TOKENS_VERSION,
  type InternalSessionEntry,
  type SessionEntry,
  type SessionSystemPromptReport,
} from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { estimateAggregateUsageCost } from "../../utils/usage-format.js";

type SessionUsageUpdateParams = {
  cfg?: OpenClawConfig;
  agentDir?: string;
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

/** Prepare host-owned pricing without choosing a persistence envelope. */
export function prepareSessionUsageUpdate(params: SessionUsageUpdateParams) {
  const cfg = params.cfg ?? getRuntimeConfig();
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
  const estimateCost = (entry?: SessionEntry) =>
    preserveUserFacingRunState || !hasBilling
      ? undefined
      : asNonNegativeFiniteNumber(
          estimateAggregateUsageCost({
            config: cfg,
            agentDir: params.agentDir,
            usage: params.usage,
            provider: params.providerUsed ?? entry?.modelProvider,
            model: params.modelUsed ?? entry?.model,
          }),
        );
  return { update, estimateCost };
}

/**
 * Publishes one settled model call's context snapshot while its turn is still
 * running, so status readers see a long turn's context grow. The latest settled
 * call wins, including a smaller one after compaction; turn-completion
 * accounting stays authoritative and lands after the caller has stopped writing.
 */
export async function persistSessionContextTotalTokens(params: {
  agentId?: string;
  storePath: string;
  sessionKey: string;
  /** Admission facts. Reset keeps the session id, so the writer claim is always checked. */
  expectedSession: Pick<InternalSessionEntry, "sessionId" | "lifecycleRevision"> & {
    activeWriterRunId: string;
  };
  /** Prompt-token context snapshot of the latest settled model call. */
  totalTokens: number;
}): Promise<void> {
  const { agentId, storePath, sessionKey, expectedSession, totalTokens } = params;
  try {
    await patchSessionEntryCore(
      { agentId, storePath, sessionKey },
      (entry) => {
        if (
          entry.sessionId !== expectedSession.sessionId ||
          entry.activeWriterRunId !== expectedSession.activeWriterRunId ||
          (expectedSession.lifecycleRevision !== undefined &&
            entry.lifecycleRevision !== expectedSession.lifecycleRevision) ||
          (entry.totalTokens === totalTokens &&
            entry.totalTokensFresh === true &&
            entry.totalTokensVersion === SESSION_TOTAL_TOKENS_VERSION)
        ) {
          return null;
        }
        const updatedAt = Date.now();
        const patch: Partial<SessionEntry> = {
          totalTokens,
          totalTokensFresh: true,
          totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
          updatedAt,
        };
        const accountedGoal = accountSessionGoalUsage({ ...entry, ...patch }, updatedAt);
        if (accountedGoal) {
          patch.goal = accountedGoal;
        }
        return patch;
      },
      { skipMaintenance: true, workerGuard: {} },
    );
  } catch (err) {
    logVerbose(`failed to persist per-call context total: ${String(err)}`);
  }
}
