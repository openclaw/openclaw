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

  const entry = sessionStore[sessionKey] ?? {
    sessionId,
    updatedAt: Date.now(),
  };
  const next: SessionEntry = {
    ...entry,
    sessionId,
    updatedAt: Date.now(),
    contextTokens,
  };
  setSessionRuntimeModel(next, {
    provider: providerUsed,
    model: modelUsed,
  });
  if (isCliProvider(providerUsed, cfg)) {
    const cliSessionId = result.meta.agentMeta?.sessionId?.trim();
    if (cliSessionId) {
      setCliSessionId(next, providerUsed, cliSessionId);
    }
  }
  next.abortedLastRun = result.meta.aborted ?? false;
  if (result.meta.systemPromptReport) {
    next.systemPromptReport = result.meta.systemPromptReport;
  }

  // Always try to derive totalTokens, even if usage is incomplete.
  // Some providers (e.g., Kimi) only return promptTokens without structured usage.
  const totalTokens = deriveSessionTotalTokens({
    usage,
    contextTokens,
    promptTokens,
  });

  if (hasNonzeroUsage(usage)) {
    const input = usage.input ?? 0;
    const output = usage.output ?? 0;
    next.inputTokens = input;
    next.outputTokens = output;
    next.cacheRead = usage.cacheRead ?? 0;
    next.cacheWrite = usage.cacheWrite ?? 0;
  }

  // Update totalTokens when valid token data is available,
  // so promptTokens-only responses (e.g., Kimi) still display context usage.
  // If no token data is available (e.g., aborted runs), preserve the previous value.
  if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
    next.totalTokens = totalTokens;
    next.totalTokensFresh = true;
  } else if (hasNonzeroUsage(usage) || (typeof promptTokens === "number" && Number.isFinite(promptTokens))) {
    // If we have usage/promptTokens data but totalTokens is still invalid, mark as stale
    next.totalTokens = undefined;
    next.totalTokensFresh = false;
  }
  // Otherwise: no token data at all (aborted/failed run) — preserve previous totalTokens
  if (compactionsThisRun > 0) {
    next.compactionCount = (entry.compactionCount ?? 0) + compactionsThisRun;
  }
  const persisted = await updateSessionStore(storePath, (store) => {
    const merged = mergeSessionEntry(store[sessionKey], next);
    store[sessionKey] = merged;
    return merged;
  });
  sessionStore[sessionKey] = persisted;
}
