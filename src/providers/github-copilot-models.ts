import type { ModelDefinitionConfig } from "../config/types.js";
import type { ModelApi } from "../config/types.models.js";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8192;

// Per-model overrides for context window and API type.
// Validated against the Copilot API:
// - Claude models only work via /chat/completions ("openai-completions")
// - Codex models only work via /v1/responses ("openai-responses")
// - Older GPT/o-series models use /chat/completions ("openai-completions")
const MODEL_OVERRIDES: Record<
  string,
  { api: ModelApi; contextWindow: number; reasoning?: boolean }
> = {
  "claude-opus-4.6": { api: "anthropic-messages", contextWindow: 128_000, reasoning: true },
  "claude-opus-4.5": { api: "anthropic-messages", contextWindow: 128_000, reasoning: true },
  "claude-sonnet-4.6": { api: "anthropic-messages", contextWindow: 128_000 },
  "claude-sonnet-4.5": { api: "anthropic-messages", contextWindow: 128_000 },
  "gpt-5.3-codex": { api: "openai-responses", contextWindow: 128_000 },
  "gpt-5.2-codex": { api: "openai-responses", contextWindow: 128_000 },
};

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

export function buildCopilotModelDefinition(modelId: string): ModelDefinitionConfig {
  const id = modelId.trim();
  if (!id) {
    throw new Error("Model id required");
  }
  const overrides = MODEL_OVERRIDES[id.toLowerCase()];
  return {
    id,
    name: id,
    // pi-coding-agent's registry schema doesn't know about a "github-copilot" API.
    // We route to the correct OpenAI-compatible endpoint per model family:
    // Claude models → /chat/completions, Codex → /v1/responses, default → /chat/completions.
    api: overrides?.api ?? "openai-completions",
    reasoning: overrides?.reasoning ?? false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: overrides?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}
