import type { StreamOptions, ThinkingBudgets, ThinkingLevel } from "../types.js";

export type BedrockThinkingDisplay = "summarized" | "omitted";

export interface BedrockOptions extends StreamOptions {
  region?: string;
  profile?: string;
  toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
  /* See https://docs.aws.amazon.com/bedrock/latest/userguide/inference-reasoning.html for supported models. */
  reasoning?: ThinkingLevel;
  /* Custom token budgets per thinking level. Overrides default budgets. */
  thinkingBudgets?: ThinkingBudgets;
  /* Only supported by Claude 4.x models, see https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html#claude-messages-extended-thinking-tool-use-interleaved */
  interleavedThinking?: boolean;
  /**
   * Controls how Claude's thinking content is returned in responses.
   * - "summarized": Thinking blocks contain summarized thinking text.
   * - "omitted": Thinking content is redacted but the signature still travels back
   *   for multi-turn continuity, reducing time-to-first-text-token.
   */
  thinkingDisplay?: BedrockThinkingDisplay;
  /** Key-value pairs attached to the inference request for cost allocation tagging. */
  requestMetadata?: Record<string, string>;
  /** Bearer token for Bedrock API key authentication. */
  bearerToken?: string;
}

function getModelMatchCandidates(modelId: string, modelName?: string): string[] {
  const values = modelName ? [modelId, modelName] : [modelId];
  return values.flatMap((value) => {
    const lower = value.toLowerCase();
    return [lower, lower.replace(/[\s_.:]+/g, "-")];
  });
}

/**
 * Check if the model supports explicit Bedrock Converse prompt cache points.
 *
 * Amazon Nova models have automatic caching and do not need explicit cache
 * points. Application inference profiles may be opaque, so callers can pass a
 * display name or force cache points with AWS_BEDROCK_FORCE_CACHE=1.
 */
export function supportsBedrockPromptCaching(modelId: string, modelName?: string): boolean {
  const candidates = getModelMatchCandidates(modelId, modelName);
  const hasClaudeRef = candidates.some((s) => s.includes("claude"));
  if (!hasClaudeRef) {
    if (typeof process !== "undefined" && process.env.AWS_BEDROCK_FORCE_CACHE === "1") {
      return true;
    }
    return false;
  }
  if (candidates.some((s) => s.includes("-4-"))) {
    return true;
  }
  if (candidates.some((s) => s.includes("claude-3-7-sonnet"))) {
    return true;
  }
  if (candidates.some((s) => s.includes("claude-3-5-haiku"))) {
    return true;
  }
  return false;
}
