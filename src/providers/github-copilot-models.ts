import type { ModelDefinitionConfig } from "../config/types.js";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8192;

// Copilot model ids vary by plan/org and can change.
// We keep this list intentionally broad; if a model isn't available Copilot will
// return an error and users can remove it from their config.
const DEFAULT_MODEL_IDS = [
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",
  "gpt-4o",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "o1",
  "o1-mini",
  "o3-mini",
] as const;

export function getDefaultCopilotModelIds(): string[] {
  return [...DEFAULT_MODEL_IDS];
}

/**
 * Resolve the correct API transport for a Copilot model based on its model ID.
 *
 * GitHub Copilot proxies requests to different upstream providers:
 * - Claude models → Anthropic Messages API (native Anthropic transport)
 * - GPT-5.x / Codex models → OpenAI Responses API
 * - GPT-4.x / Gemini / Grok / other models → OpenAI Chat Completions API
 *
 * pi-ai's built-in catalog already maps these correctly; this function mirrors
 * that logic for fallback/inline model definitions that aren't in the catalog.
 */
export function resolveCopilotModelApi(modelId: string): ModelDefinitionConfig["api"] {
  const lower = modelId.toLowerCase();
  // Claude models use the native Anthropic Messages API through Copilot's proxy.
  if (lower.startsWith("claude-")) {
    return "anthropic-messages";
  }
  // GPT-5.x and Codex models support the OpenAI Responses API.
  if (lower.startsWith("gpt-5") || lower.includes("codex")) {
    return "openai-responses";
  }
  // All other models (GPT-4.x, Gemini, Grok, o1, o3, etc.) use Chat Completions.
  return "openai-completions";
}

export function buildCopilotModelDefinition(modelId: string): ModelDefinitionConfig {
  const id = modelId.trim();
  if (!id) {
    throw new Error("Model id required");
  }
  return {
    id,
    name: id,
    api: resolveCopilotModelApi(id),
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}
