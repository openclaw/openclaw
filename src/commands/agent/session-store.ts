import { setCliSessionId } from "../../agents/cli-session.js";
import { lookupContextTokens } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { deriveSessionTotalTokens, hasNonzeroUsage } from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/config.js";
import { type SessionEntry, updateSessionStore } from "../../config/sessions.js";

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
    params.contextTokensOverride ?? lookupContextTokens(modelUsed) ?? DEFAULT_CONTEXT_TOKENS;

  // Build the updated entry inside the lock's mutator callback so we always
  // merge against the latest on-disk state.  Previously `next` was computed
  // outside the lock using a potentially-stale `sessionStore` snapshot, which
  // could silently overwrite concurrent writes from other agents sharing the
  // same store file.
  await updateSessionStore(storePath, (store) => {
    const entry = store[sessionKey] ?? {
      sessionId,
      updatedAt: Date.now(),
    };
    const next: SessionEntry = {
      ...entry,
      sessionId,
      updatedAt: Date.now(),
      modelProvider: providerUsed,
      model: modelUsed,
      contextTokens,
    };
    if (isCliProvider(providerUsed, cfg)) {
      const cliSessionId = result.meta.agentMeta?.sessionId?.trim();
      if (cliSessionId) {
        setCliSessionId(next, providerUsed, cliSessionId);
      }
    }
    next.abortedLastRun = result.meta.aborted ?? false;
    if (hasNonzeroUsage(usage)) {
      const input = usage.input ?? 0;
      const output = usage.output ?? 0;
      const totalTokens =
        deriveSessionTotalTokens({
          usage,
          contextTokens,
          promptTokens,
        }) ?? input;
      next.inputTokens = input;
      next.outputTokens = output;
      next.totalTokens = totalTokens;
      next.totalTokensFresh = true;
    }
    if (compactionsThisRun > 0) {
      next.compactionCount = (entry.compactionCount ?? 0) + compactionsThisRun;
    }
    store[sessionKey] = next;
    // Keep the caller's in-memory snapshot consistent.
    sessionStore[sessionKey] = next;
  });
}
