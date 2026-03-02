import type { ModelDefinitionConfig } from "../config/types.js";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8192;

// Copilot uses dot-notation ("claude-opus-4.6"), OpenClaw uses dashes
// ("claude-opus-4-6").  Normalize to dashes for all lookups.
function normalizeCopilotModelId(id: string): string {
  return id.toLowerCase().replace(/\./g, "-");
}

// GitHub Copilot has its own model naming convention that differs from
// Anthropic's official API names.  Copilot exposes a "-1m" suffix variant
// for the 1M context window (e.g. "claude-opus-4.6-1m").
//
// Context windows:
//   - Standard Claude models on Copilot: 200K (Anthropic's default)
//   - "-1m" variants: ~936K empirically (Copilot enforces its own limit)
//
// Keys use dash-notation; dot-notation is normalized at lookup time.
const COPILOT_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-4-6": 200_000,
  "claude-opus-4-5": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-sonnet-4-5": 200_000,
  "claude-haiku-4-5": 200_000,
  // Fast variants use the standard 128K context window.
  "claude-opus-4-6-fast": DEFAULT_CONTEXT_WINDOW,
  // 1M variant — only verified for Opus 4.6.
  "claude-opus-4-6-1m": 936_000,
};

// Models that support extended thinking / reasoning.
const COPILOT_REASONING_MODELS = new Set([
  "claude-opus-4-6",
  "claude-opus-4-6-fast",
  "claude-opus-4-6-1m",
  "claude-opus-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "o1",
  "o1-mini",
  "o3-mini",
]);

// Copilot model ids vary by plan/org and can change.
// We keep this list intentionally broad; if a model isn't available Copilot will
// return an error and users can remove it from their config.
const DEFAULT_MODEL_IDS = [
  // Claude models (available on GitHub Copilot)
  "claude-opus-4-6-1m",
  "claude-opus-4-6",
  "claude-opus-4-6-fast",
  "claude-opus-4.6-fast",
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  // OpenAI models
  "gpt-4o",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-5.3-codex",
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
  const normalized = normalizeCopilotModelId(id);
  const contextWindow = COPILOT_MODEL_CONTEXT_WINDOWS[normalized] ?? DEFAULT_CONTEXT_WINDOW;
  const reasoning = COPILOT_REASONING_MODELS.has(normalized);
  return {
    id,
    name: id,
    // pi-coding-agent's registry schema doesn't know about a "github-copilot" API.
    // We use OpenAI-compatible responses API, while keeping the provider id as
    // "github-copilot" (pi-ai uses that to attach Copilot-specific headers).
    api: "openai-responses",
    reasoning,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}
