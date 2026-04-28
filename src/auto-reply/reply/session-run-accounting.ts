import type { EmbeddedPiRunResult } from "../../agents/pi-embedded-runner/types.js";
import { deriveSessionTotalTokens, type NormalizedUsage } from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { updateSessionStoreEntry, type SessionEntry } from "../../config/sessions.js";
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

type PersistSystemSentAfterSuccessParams = {
  storePath?: string;
  sessionKey?: string;
  sessionEntry?: SessionEntry;
  runResult: EmbeddedPiRunResult;
};

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

export async function persistSystemSentAfterSuccess(
  params: PersistSystemSentAfterSuccessParams,
): Promise<void> {
  const { storePath, sessionKey, sessionEntry, runResult } = params;
  const payloadArray = runResult.payloads ?? [];
  const hasMetaError = Boolean(runResult.meta?.error);
  const hasNonErrorPayload = payloadArray.some(
    (p) => !p.isError && Boolean(p.text?.trim() || (p.mediaUrls?.length ?? 0) > 0 || p.mediaUrl),
  );
  const hasSentViaMessagingTool =
    runResult.didSendViaMessagingTool === true ||
    (runResult.messagingToolSentTexts?.length ?? 0) > 0 ||
    (runResult.messagingToolSentMediaUrls?.length ?? 0) > 0;
  const hasSuccessfulStopReason =
    Boolean(runResult.meta?.stopReason) &&
    runResult.meta.stopReason !== "error" &&
    runResult.meta.stopReason !== "aborted";
  if (
    sessionKey &&
    storePath &&
    sessionEntry?.systemSent !== true &&
    !hasMetaError &&
    (hasNonErrorPayload || hasSentViaMessagingTool || hasSuccessfulStopReason)
  ) {
    await updateSessionStoreEntry({
      storePath,
      sessionKey,
      update: async () => ({ systemSent: true }),
    });
  }
}
