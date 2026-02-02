import { setCliSessionId } from "../../agents/cli-session.js";
import { hasNonzeroUsage, type NormalizedUsage } from "../../agents/usage.js";
import {
  type SessionSystemPromptReport,
  type SessionEntry,
  updateSessionStoreEntry,
} from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { queueSessionDescriptionRefresh } from "../../sessions/session-description.js";

export async function persistSessionUsageUpdate(params: {
  storePath?: string;
  sessionKey?: string;
  usage?: NormalizedUsage;
  modelUsed?: string;
  providerUsed?: string;
  contextTokensUsed?: number;
  systemPromptReport?: SessionSystemPromptReport;
  cliSessionId?: string;
  /** Claude Agent SDK session ID for native session resume. */
  claudeSdkSessionId?: string;
  logLabel?: string;
}): Promise<void> {
  const { storePath, sessionKey } = params;
  if (!storePath || !sessionKey) {
    return;
  }

  const label = params.logLabel ? `${params.logLabel} ` : "";
  if (hasNonzeroUsage(params.usage)) {
    try {
      const next = await updateSessionStoreEntry({
        storePath,
        sessionKey,
        update: async (entry) => {
          const input = params.usage?.input ?? 0;
          const output = params.usage?.output ?? 0;
          const promptTokens =
            input + (params.usage?.cacheRead ?? 0) + (params.usage?.cacheWrite ?? 0);
          const patch: Partial<SessionEntry> = {
            inputTokens: input,
            outputTokens: output,
            totalTokens: promptTokens > 0 ? promptTokens : (params.usage?.total ?? input),
            turnCount: (entry.turnCount ?? 0) + 1,
            modelProvider: params.providerUsed ?? entry.modelProvider,
            model: params.modelUsed ?? entry.model,
            contextTokens: params.contextTokensUsed ?? entry.contextTokens,
            systemPromptReport: params.systemPromptReport ?? entry.systemPromptReport,
            updatedAt: Date.now(),
          };
          const cliProvider = params.providerUsed ?? entry.modelProvider;
          if (params.cliSessionId && cliProvider) {
            const nextEntry = { ...entry, ...patch };
            setCliSessionId(nextEntry, cliProvider, params.cliSessionId);
            return {
              ...patch,
              cliSessionIds: nextEntry.cliSessionIds,
              claudeCliSessionId: nextEntry.claudeCliSessionId,
            };
          }
          // Persist Claude SDK session ID for native session resume
          if (params.claudeSdkSessionId) {
            return {
              ...patch,
              claudeSdkSessionId: params.claudeSdkSessionId,
            };
          }
          return patch;
        },
      });
      if (next) queueSessionDescriptionRefresh({ storePath, sessionKey, entry: next });
    } catch (err) {
      logVerbose(`failed to persist ${label}usage update: ${String(err)}`);
    }
    return;
  }

  if (params.modelUsed || params.contextTokensUsed) {
    try {
      const next = await updateSessionStoreEntry({
        storePath,
        sessionKey,
        update: async (entry) => {
          const patch: Partial<SessionEntry> = {
            modelProvider: params.providerUsed ?? entry.modelProvider,
            model: params.modelUsed ?? entry.model,
            contextTokens: params.contextTokensUsed ?? entry.contextTokens,
            systemPromptReport: params.systemPromptReport ?? entry.systemPromptReport,
            turnCount: (entry.turnCount ?? 0) + 1,
            updatedAt: Date.now(),
          };
          const cliProvider = params.providerUsed ?? entry.modelProvider;
          if (params.cliSessionId && cliProvider) {
            const nextEntry = { ...entry, ...patch };
            setCliSessionId(nextEntry, cliProvider, params.cliSessionId);
            return {
              ...patch,
              cliSessionIds: nextEntry.cliSessionIds,
              claudeCliSessionId: nextEntry.claudeCliSessionId,
            };
          }
          // Persist Claude SDK session ID for native session resume
          if (params.claudeSdkSessionId) {
            return {
              ...patch,
              claudeSdkSessionId: params.claudeSdkSessionId,
            };
          }
          return patch;
        },
      });
      if (next) queueSessionDescriptionRefresh({ storePath, sessionKey, entry: next });
    } catch (err) {
      logVerbose(`failed to persist ${label}model/context update: ${String(err)}`);
    }
  }
}
