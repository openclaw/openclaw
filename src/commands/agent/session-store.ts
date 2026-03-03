import { setCliSessionId } from "../../agents/cli-session.js";
import { resolveContextTokensForModel } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { deriveSessionTotalTokens, hasNonzeroUsage } from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  mergeSessionEntry,
  setSessionRuntimeModel,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";

type RunResult = Awaited<
  ReturnType<(typeof import("../../agents/pi-embedded.js"))["runEmbeddedPiAgent"]>
>;

export async function updateSessionStoreAfterAgentRun(params: {
  cfg: OpenClawConfig;
  contextTokensOverride?: number;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  sessionStore: Record<string, SessionEntry>;
  defaultProvider: string;
  defaultModel: string;
  fallbackProvider?: string;
  fallbackModel?: string;
  result: RunResult;
}) {
  const {
    cfg,
    sessionId,
    sessionKey,
    storePath,
    sessionStore,
    defaultProvider,
    defaultModel,
    fallbackProvider,
    fallbackModel,
    result,
  } = params;

  const usage = result.meta.agentMeta?.usage;
  const promptTokens = result.meta.agentMeta?.promptTokens;
  const compactionsThisRun = Math.max(0, result.meta.agentMeta?.compactionCount ?? 0);
  const modelUsed = result.meta.agentMeta?.model ?? fallbackModel ?? defaultModel;
  const providerUsed = result.meta.agentMeta?.provider ?? fallbackProvider ?? defaultProvider;
  const contextTokens =
    resolveContextTokensForModel({
      cfg,
      provider: providerUsed,
      model: modelUsed,
      contextTokensOverride: params.contextTokensOverride,
      fallbackContextTokens: DEFAULT_CONTEXT_TOKENS,
    }) ?? DEFAULT_CONTEXT_TOKENS;

  const now = Date.now();
  const patch: Partial<SessionEntry> = {
    sessionId,
    updatedAt: now,
    contextTokens,
    abortedLastRun: result.meta.aborted ?? false,
  };
  if (hasNonzeroUsage(usage)) {
    const input = usage.input ?? 0;
    const output = usage.output ?? 0;
    const totalTokens = deriveSessionTotalTokens({
      usage,
      contextTokens,
      promptTokens,
    });
    patch.inputTokens = input;
    patch.outputTokens = output;
    if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
      patch.totalTokens = totalTokens;
      patch.totalTokensFresh = true;
    } else {
      patch.totalTokens = undefined;
      patch.totalTokensFresh = false;
    }
    patch.cacheRead = usage.cacheRead ?? 0;
    patch.cacheWrite = usage.cacheWrite ?? 0;
  }

  const cliSessionId =
    isCliProvider(providerUsed, cfg) && result.meta.agentMeta?.sessionId?.trim()
      ? result.meta.agentMeta.sessionId.trim()
      : undefined;

  const persisted = await updateSessionStore(storePath, (store) => {
    const existing =
      store[sessionKey] ??
      sessionStore[sessionKey] ?? {
        sessionId,
        updatedAt: now,
      };
    const merged = mergeSessionEntry(existing, patch);
    setSessionRuntimeModel(merged, {
      provider: providerUsed,
      model: modelUsed,
    });
    if (cliSessionId) {
      setCliSessionId(merged, providerUsed, cliSessionId);
    }
    if (compactionsThisRun > 0) {
      merged.compactionCount = (existing.compactionCount ?? 0) + compactionsThisRun;
    }
    store[sessionKey] = merged;
    return merged;
  });
  sessionStore[sessionKey] = persisted;
}
