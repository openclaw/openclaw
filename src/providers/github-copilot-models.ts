import type { ModelDefinitionConfig } from "../config/types.js";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8192;

// Claude models have larger context windows
const CLAUDE_CONTEXT_WINDOW = 200_000;
const CLAUDE_MAX_TOKENS = 8192;

// Copilot model ids vary by plan/org and can change.
// We keep this list intentionally broad; if a model isn't available Copilot will
// return an error and users can remove it from their config.
const DEFAULT_MODEL_IDS = [
  "gpt-4o",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "o1",
  "o1-mini",
  "o3-mini",
  // Claude models (requires GitHub Copilot Pro+ subscription)
  "claude-opus-4.5",
  "claude-sonnet-4.5",
  "claude-sonnet-4",
] as const;

// Models that are known to be Claude models
const CLAUDE_MODEL_PREFIXES = ["claude-"] as const;

function isClaudeModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return CLAUDE_MODEL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function getDefaultCopilotModelIds(): string[] {
  return [...DEFAULT_MODEL_IDS];
}

export function buildCopilotModelDefinition(modelId: string): ModelDefinitionConfig {
  const id = modelId.trim();
  if (!id) {
    throw new Error("Model id required");
  }

  const isClaude = isClaudeModel(id);

  return {
    id,
    name: id,
    // pi-coding-agent's registry schema doesn't know about a "github-copilot" API.
    // We use OpenAI-compatible responses API, while keeping the provider id as
    // "github-copilot" (pi-ai uses that to attach Copilot-specific headers).
    api: "openai-responses",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: isClaude ? CLAUDE_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW,
    maxTokens: isClaude ? CLAUDE_MAX_TOKENS : DEFAULT_MAX_TOKENS,
  };
}
