import fs from "node:fs";
import readline from "node:readline";
import { setCliSessionId } from "../../agents/cli-session.js";
import { estimateMessagesTokens } from "../../agents/compaction.js";
import { resolveContextTokensForModel } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { deriveSessionTotalTokens, hasNonzeroUsage } from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  mergeSessionEntry,
  resolveSessionTranscriptPath,
  setSessionRuntimeModel,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";

type RunResult = Awaited<
  ReturnType<(typeof import("../../agents/pi-embedded.js"))["runEmbeddedPiAgent"]>
>;

/**
 * Fallback function to estimate token count from session transcript when provider doesn't report usage.
 * Reads the JSONL session file and estimates tokens from message content.
 */
async function estimateTokensFromSessionTranscript(params: {
  sessionId: string;
  sessionKey: string;
  agentId?: string;
}): Promise<number | undefined> {
  try {
    // Resolve transcript path
    const transcriptPath = resolveSessionTranscriptPath(params.sessionId, params.agentId);

    // Check if transcript file exists
    if (!fs.existsSync(transcriptPath)) {
      return undefined;
    }

    // Read and parse JSONL file to extract messages
    const messages: any[] = [];
    const fileStream = fs.createReadStream(transcriptPath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const parsed = JSON.parse(trimmed);
          // Extract message objects that have role/content
          if (parsed?.message?.role && (parsed.message.content || parsed.message.tool_calls)) {
            messages.push(parsed.message);
          }
        } catch {
          // Skip malformed lines
        }
      }
    } finally {
      rl.close();
      fileStream.destroy();
    }

    // If we have messages, estimate tokens using the existing function
    if (messages.length > 0) {
      return estimateMessagesTokens(messages);
    }

    return undefined;
  } catch {
    // If anything fails, return undefined so the system doesn't break
    return undefined;
  }
}

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
  if (hasNonzeroUsage(usage)) {
    const input = usage.input ?? 0;
    const output = usage.output ?? 0;
    const totalTokens = deriveSessionTotalTokens({
      usage,
      contextTokens,
      promptTokens,
    });
    next.inputTokens = input;
    next.outputTokens = output;
    if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
      next.totalTokens = totalTokens;
      next.totalTokensFresh = true;
    } else {
      next.totalTokens = undefined;
      next.totalTokensFresh = false;
    }
    next.cacheRead = usage.cacheRead ?? 0;
    next.cacheWrite = usage.cacheWrite ?? 0;
  } else {
    // Fallback: when provider doesn't report usage (e.g., MiniMax via Cloudflare AI Gateway),
    // estimate token count from the session transcript content
    try {
      const estimatedTokens = await estimateTokensFromSessionTranscript({
        sessionId,
        sessionKey,
        agentId: cfg.agentId ?? "main",
      });

      if (typeof estimatedTokens === "number" && estimatedTokens > 0) {
        next.totalTokens = estimatedTokens;
        next.totalTokensFresh = true;
        // Set input/output to 0 since we don't have breakdown, but have estimated total
        next.inputTokens = 0;
        next.outputTokens = 0;
        next.cacheRead = 0;
        next.cacheWrite = 0;
      } else {
        // If estimation also fails, keep the old behavior
        next.totalTokens = undefined;
        next.totalTokensFresh = false;
      }
    } catch {
      // If fallback estimation fails, don't break - just use the old behavior
      next.totalTokens = undefined;
      next.totalTokensFresh = false;
    }
  }
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
