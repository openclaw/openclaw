import { deriveSessionTotalTokens, type NormalizedUsage } from "../../agents/usage.js";
import type { SessionEntry } from "../../config/sessions.js";
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

function resolvePositiveTokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function normalizeModelRefPart(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function modelRefsEqual(
  left: { provider?: string; model?: string },
  right: { provider?: string; model?: string },
): boolean {
  const leftProvider = normalizeModelRefPart(left.provider);
  const leftModel = normalizeModelRefPart(left.model);
  const rightProvider = normalizeModelRefPart(right.provider);
  const rightModel = normalizeModelRefPart(right.model);
  return Boolean(
    leftProvider &&
    leftModel &&
    rightProvider &&
    rightModel &&
    leftProvider === rightProvider &&
    leftModel === rightModel,
  );
}

export function resolveRunSessionModelPersistence(params: {
  sessionEntry?: Pick<SessionEntry, "modelOverrideSource">;
  selectedProvider?: string;
  selectedModel?: string;
  providerUsed?: string;
  modelUsed?: string;
}): Pick<PersistRunSessionUsageParams, "sessionModelProvider" | "sessionModel"> {
  if (params.sessionEntry?.modelOverrideSource === "user") {
    return {};
  }
  if (
    !params.selectedProvider ||
    !params.selectedModel ||
    !params.providerUsed ||
    !params.modelUsed
  ) {
    return {};
  }
  if (
    modelRefsEqual(
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

export async function persistRunSessionUsage(params: PersistRunSessionUsageParams): Promise<void> {
  await persistSessionUsageUpdate(params);
}

export async function incrementRunCompactionCount(
  params: IncrementRunCompactionCountParams,
): Promise<number | undefined> {
  const tokensAfterCompaction =
    resolvePositiveTokenCount(params.compactionTokensAfter) ??
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
