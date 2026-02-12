import { deriveSessionTotalTokens, type NormalizedUsage } from "../../agents/usage.js";
import type { SessionEntry, SessionSystemPromptReport } from "../../config/sessions.js";
import { incrementCompactionCount } from "./session-updates.js";
import { persistSessionUsageUpdate } from "./session-usage.js";

export async function persistRunSessionUsage(params: {
  storePath?: string;
  sessionKey?: string;
  usage?: NormalizedUsage;
  lastCallUsage?: NormalizedUsage;
  modelUsed?: string;
  providerUsed?: string;
  contextTokensUsed?: number;
  systemPromptReport?: SessionSystemPromptReport;
  cliSessionId?: string;
  logLabel?: string;
}): Promise<void> {
  await persistSessionUsageUpdate({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    usage: params.usage,
    lastCallUsage: params.lastCallUsage,
    modelUsed: params.modelUsed,
    providerUsed: params.providerUsed,
    contextTokensUsed: params.contextTokensUsed,
    systemPromptReport: params.systemPromptReport,
    cliSessionId: params.cliSessionId,
    logLabel: params.logLabel,
  });
}

export async function incrementRunCompactionCount(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  lastCallUsage?: NormalizedUsage;
  contextTokensUsed?: number;
}): Promise<number | undefined> {
  const tokensAfterCompaction = params.lastCallUsage
    ? deriveSessionTotalTokens({
        usage: params.lastCallUsage,
        contextTokens: params.contextTokensUsed,
      })
    : undefined;
  return incrementCompactionCount({
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    tokensAfter: tokensAfterCompaction,
  });
}
