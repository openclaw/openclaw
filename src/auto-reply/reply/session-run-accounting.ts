import { areRuntimeModelRefsEquivalent } from "../../agents/model-runtime-aliases.js";
import { deriveSessionTotalTokens, type NormalizedUsage } from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { incrementCompactionCount } from "./session-updates.js";
import { persistSessionUsageUpdate } from "./session-usage.js";

type PersistRunSessionUsageParams = Parameters<typeof persistSessionUsageUpdate>[0];

type IncrementRunCompactionCountParams = Omit<
  Parameters<typeof incrementCompactionCount>[0],
  "tokensAfter"
> & {
  amount?: number;
  cfg?: OpenClawConfig;
  compactionTokensAfter?: number;
  lastCallUsage?: NormalizedUsage;
  contextTokensUsed?: number;
  newSessionId?: string;
  newSessionFile?: string;
};

function resolveNonNegativeTokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function modelRefsEquivalent(
  left: { provider?: string; model?: string },
  right: { provider?: string; model?: string },
): boolean {
  if (!left.provider || !left.model || !right.provider || !right.model) {
    return false;
  }
  return areRuntimeModelRefsEquivalent(
    `${left.provider}/${left.model}`,
    `${right.provider}/${right.model}`,
  );
}

export function resolveRunSessionModelPersistence(params: {
  selectedProvider?: string;
  selectedModel?: string;
  providerUsed?: string;
  modelUsed?: string;
}): Pick<PersistRunSessionUsageParams, "sessionModelProvider" | "sessionModel"> {
  if (
    !params.selectedProvider ||
    !params.selectedModel ||
    !params.providerUsed ||
    !params.modelUsed
  ) {
    return {};
  }
  if (
    modelRefsEquivalent(
      { provider: params.selectedProvider, model: params.selectedModel },
      { provider: params.providerUsed, model: params.modelUsed },
    )
  ) {
    return {};
  }
  return {
    sessionModelProvider: params.selectedProvider,
    sessionModel: params.selectedModel,
  };
}

export async function persistRunSessionUsage(
  params: PersistRunSessionUsageParams,
): Promise<boolean> {
  return await persistSessionUsageUpdate(params);
}

export async function incrementRunCompactionCount(
  params: IncrementRunCompactionCountParams,
): Promise<number | undefined> {
  const tokensAfterCompaction =
    resolveNonNegativeTokenCount(params.compactionTokensAfter) ??
    (params.lastCallUsage
      ? deriveSessionTotalTokens({
          usage: params.lastCallUsage,
          contextTokens: params.contextTokensUsed,
        })
      : undefined);
  return incrementCompactionCount({
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    cfg: params.cfg,
    amount: params.amount,
    tokensAfter: tokensAfterCompaction,
    newSessionId: params.newSessionId,
    newSessionFile: params.newSessionFile,
  });
}
