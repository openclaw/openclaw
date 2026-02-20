import type { ModelDefinitionConfig } from "../config/types.js";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8192;

// Copilot uses premium request units, not per-token pricing.
// Cost tracking is zero until we model request-unit multipliers.
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// Copilot model ids vary by plan/org and can change.
// This list matches the models reported by `copilot --model` as of 2026-02-15.
// If a model isn't available Copilot will return an error.
const DEFAULT_MODEL_IDS = [
  "claude-sonnet-4.5",
  "claude-haiku-4.5",
  "claude-opus-4.6",
  "claude-opus-4.6-fast",
  "claude-opus-4.5",
  "claude-sonnet-4",
  "gemini-3-pro-preview",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.2",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex",
  "gpt-5.1",
  "gpt-5",
  "gpt-5.1-codex-mini",
  "gpt-5-mini",
  "gpt-4.1",
  "gpt-4o",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "o1",
  "o1-mini",
  "o3-mini",
  "gemini-2.5-pro",
] as const;

/** Known models that support reasoning effort. */
const REASONING_MODEL_IDS = new Set([
  "o1",
  "o1-mini",
  "o3-mini",
  "claude-opus-4.5",
  "claude-opus-4.6",
  "claude-opus-4.6-fast",
]);

/** Known models that support image/vision input. */
const VISION_MODEL_IDS = new Set([
  "gpt-4o",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-5",
  "gpt-5.1",
  "gpt-5.2",
  "claude-sonnet-4",
  "claude-sonnet-4.5",
  "claude-opus-4.5",
  "claude-opus-4.6",
  "claude-opus-4.6-fast",
  "gemini-2.5-pro",
  "gemini-3-pro-preview",
]);

export function getDefaultCopilotModelIds(): string[] {
  return [...DEFAULT_MODEL_IDS];
}

export function buildCopilotModelDefinition(modelId: string): ModelDefinitionConfig {
  const id = modelId.trim();
  if (!id) {
    throw new Error("Model id required");
  }

  const isReasoning = REASONING_MODEL_IDS.has(id);
  const isVision = VISION_MODEL_IDS.has(id);

  // Copilot exposes both /chat/completions (OpenAI) and /v1/messages (Anthropic)
  // at the same base URL. Use the Anthropic Messages API for Claude models to get
  // proper extended thinking with real cryptographic signatures.
  const isClaude = id.startsWith("claude-");
  const api = isClaude ? "anthropic-messages" : "openai-responses";

  return {
    id,
    name: id,
    api,
    reasoning: isReasoning,
    input: isVision ? ["text", "image"] : ["text"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}
