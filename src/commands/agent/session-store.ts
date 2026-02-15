import type { ThinkLevel } from "../../auto-reply/thinking.js";
import { listThinkingLevels } from "../../auto-reply/thinking.js";
import { setCliSessionId } from "../../agents/cli-session.js";
import { lookupContextTokens } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { deriveSessionTotalTokens, hasNonzeroUsage } from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/config.js";
import { type SessionEntry, updateSessionStore } from "../../config/sessions.js";
import type {
  AgentThinkingEscalationConfig,
  AgentThinkingEscalationThreshold,
} from "../../config/types.agent-defaults.js";

type RunResult = Awaited<
  ReturnType<(typeof import("../../agents/pi-embedded.js"))["runEmbeddedPiAgent"]>
>;

const THINKING_LEVEL_ORDER: ThinkLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/**
 * Compute the target thinking level based on context window usage and escalation thresholds.
 * Returns the highest thinking level from thresholds that have been exceeded.
 */
function computeTargetThinkingLevel(params: {
  escalation: AgentThinkingEscalationConfig | undefined;
  totalTokens: number;
  contextTokens: number;
  provider: string;
  model: string;
}): ThinkLevel | undefined {
  const { escalation, totalTokens, contextTokens, provider, model } = params;

  if (!escalation?.enabled || !escalation.thresholds || escalation.thresholds.length === 0) {
    return undefined;
  }

  if (contextTokens <= 0 || totalTokens < 0) {
    return undefined;
  }

  const usagePercent = (totalTokens / contextTokens) * 100;

  // Sort thresholds by atContextPercent descending to find the highest applicable
  const sortedThresholds = [...escalation.thresholds].toSorted(
    (a: AgentThinkingEscalationThreshold, b: AgentThinkingEscalationThreshold) =>
      b.atContextPercent - a.atContextPercent,
  );

  // Find the first (highest) threshold that has been exceeded
  const applicableThreshold = sortedThresholds.find(
    (t: AgentThinkingEscalationThreshold) => usagePercent >= t.atContextPercent,
  );

  if (!applicableThreshold) {
    return undefined;
  }

  const targetLevel = applicableThreshold.thinking;

  // Check if the target level is supported by this provider/model
  const allowedLevels = listThinkingLevels(provider, model);
  if (!allowedLevels.includes(targetLevel)) {
    // Find the highest allowed level that is <= targetLevel
    const targetIndex = THINKING_LEVEL_ORDER.indexOf(targetLevel);
    for (let i = targetIndex - 1; i >= 0; i--) {
      const lowerLevel = THINKING_LEVEL_ORDER[i];
      if (allowedLevels.includes(lowerLevel)) {
        return lowerLevel;
      }
    }
    return undefined;
  }

  return targetLevel;
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
    params.contextTokensOverride ?? lookupContextTokens(modelUsed) ?? DEFAULT_CONTEXT_TOKENS;

  const entry = sessionStore[sessionKey] ?? {
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

    // Check for thinking level escalation based on context usage
    const escalation = cfg.agents?.defaults?.thinkingEscalation;
    if (escalation?.enabled) {
      const currentLevel = (entry.thinkingLevel as ThinkLevel | undefined) ?? "off";
      const targetLevel = computeTargetThinkingLevel({
        escalation,
        totalTokens,
        contextTokens,
        provider: providerUsed,
        model: modelUsed,
      });

      if (targetLevel) {
        const currentIndex = THINKING_LEVEL_ORDER.indexOf(currentLevel);
        const targetIndex = THINKING_LEVEL_ORDER.indexOf(targetLevel);

        // Only escalate (increase thinking level), never de-escalate
        if (targetIndex > currentIndex) {
          next.thinkingLevel = targetLevel;
        }
      }
    }
  }
  if (compactionsThisRun > 0) {
    next.compactionCount = (entry.compactionCount ?? 0) + compactionsThisRun;
  }
  sessionStore[sessionKey] = next;
  await updateSessionStore(storePath, (store) => {
    store[sessionKey] = next;
  });
}
