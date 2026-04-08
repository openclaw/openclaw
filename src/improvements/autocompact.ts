import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { estimateMessagesTokens } from "../agents/compaction.js";
import { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";

export interface AutocompactConfig {
  enabled: boolean;
  thresholdPercent: number;
  keepRecentTurns: number;
  maxConsecutiveFailures: number;
  contextWindowTokens?: number;
}

export interface AutocompactRuntime {
  model: Model<Api>;
  summarize: (messages: AgentMessage[]) => Promise<string>;
}

export const DEFAULT_AUTOCOMPACT_CONFIG: AutocompactConfig = {
  enabled: true,
  thresholdPercent: 85,
  keepRecentTurns: 3,
  maxConsecutiveFailures: 3,
};

let consecutiveFailures = 0;

export function resetAutocompactFailures(): void {
  consecutiveFailures = 0;
}

export function recordAutocompactFailure(): void {
  consecutiveFailures += 1;
}

export async function shouldAutocompact(
  config: AutocompactConfig = DEFAULT_AUTOCOMPACT_CONFIG,
): Promise<boolean> {
  return config.enabled && consecutiveFailures < config.maxConsecutiveFailures;
}

function resolveContextWindowTokens(
  runtime: AutocompactRuntime,
  config: AutocompactConfig,
): number {
  return config.contextWindowTokens ?? runtime.model.contextWindow ?? DEFAULT_CONTEXT_TOKENS;
}

export function getAutoCompactThreshold(
  runtime: AutocompactRuntime,
  config: AutocompactConfig = DEFAULT_AUTOCOMPACT_CONFIG,
): number {
  return Math.floor((resolveContextWindowTokens(runtime, config) * config.thresholdPercent) / 100);
}

export function estimateTotalTokens(messages: AgentMessage[]): number {
  return estimateMessagesTokens(messages);
}

function splitMessages(
  messages: AgentMessage[],
  keepRecentTurns: number,
): {
  oldMessages: AgentMessage[];
  recentMessages: AgentMessage[];
} {
  const keepCount = Math.max(0, keepRecentTurns * 2);
  if (keepCount === 0) {
    return { oldMessages: messages, recentMessages: [] };
  }
  return {
    oldMessages: messages.slice(0, -keepCount),
    recentMessages: messages.slice(-keepCount),
  };
}

export async function generateSummary(
  messages: AgentMessage[],
  runtime: AutocompactRuntime,
  config: AutocompactConfig = DEFAULT_AUTOCOMPACT_CONFIG,
): Promise<string> {
  const { oldMessages } = splitMessages(messages, config.keepRecentTurns);
  if (oldMessages.length === 0) {
    return "";
  }

  try {
    const summary = await runtime.summarize(oldMessages);
    resetAutocompactFailures();
    return summary;
  } catch (error) {
    recordAutocompactFailure();
    throw error;
  }
}

export async function applyAutocompact(
  messages: AgentMessage[],
  runtime: AutocompactRuntime,
  config: AutocompactConfig = DEFAULT_AUTOCOMPACT_CONFIG,
): Promise<AgentMessage[]> {
  if (!config.enabled || messages.length === 0) {
    return messages;
  }

  const totalTokens = estimateTotalTokens(messages);
  const threshold = getAutoCompactThreshold(runtime, config);
  if (totalTokens < threshold) {
    return messages;
  }

  if (!(await shouldAutocompact(config))) {
    return messages;
  }

  try {
    const summary = await generateSummary(messages, runtime, config);
    if (!summary.trim()) {
      return messages;
    }
    const { recentMessages } = splitMessages(messages, config.keepRecentTurns);
    return [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `[Autocompact summary]\n${summary}`,
          },
        ],
        timestamp: Date.now(),
      },
      ...recentMessages,
    ];
  } catch {
    return messages;
  }
}

export default {
  DEFAULT_AUTOCOMPACT_CONFIG,
  applyAutocompact,
  estimateTotalTokens,
  generateSummary,
  getAutoCompactThreshold,
  recordAutocompactFailure,
  resetAutocompactFailures,
  shouldAutocompact,
};
