import type { ModelDefinitionConfig } from "../config/types.js";
import { resolveCopilotApiToken } from "./github-copilot-token.js";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8192;

// Copilot model ids vary by plan/org and can change.
// We keep this list intentionally broad; if a model isn't available Copilot will
// return an error and users can remove it from their config.
const DEFAULT_MODEL_IDS = [
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",
  "gpt-4o",
  "claude-3.5-sonnet",
  "gemini-2.0-flash-001",
  "o1",
  "o1-mini",
  "o3-mini",
  "claude-3.7-sonnet",
  "claude-sonnet-4",
  "claude-sonnet-4.6",
  "claude-opus-4",
  "claude-opus-4.6",
  "gpt-4.5-preview",
] as const;

export function getDefaultCopilotModelIds(): string[] {
  return [...DEFAULT_MODEL_IDS];
}

export async function fetchCopilotModels(githubToken: string): Promise<string[]> {
  try {
    // 1. Exchange GitHub token for Copilot token
    const { token, baseUrl } = await resolveCopilotApiToken({ githubToken });

    // 2. Fetch models from Copilot API
    // The base URL is usually https://api.individual.githubcopilot.com or similar
    const res = await fetch(`${baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      console.warn(`Failed to fetch Copilot models: ${res.status} ${res.statusText}`);
      // Fallback: try GitHub API if the base URL (proxy) fails
      // This handles cases where the proxy EP in the token is outdated or unreachable
      // The models endpoint is generally available at api.githubcopilot.com/models
      // or via the main GitHub API (though that one 404s for some).
      return [...DEFAULT_MODEL_IDS];
    }

    const json = (await res.json()) as { data: { id: string }[] };
    if (!Array.isArray(json.data)) {
      console.warn("Unexpected Copilot models response format");
      return [...DEFAULT_MODEL_IDS];
    }

    const modelIds = json.data.map((m) => m.id);
    if (modelIds.length === 0) {
      return [...DEFAULT_MODEL_IDS];
    }

    return modelIds;
  } catch (error) {
    console.warn("Error fetching Copilot models:", error);
    return [...DEFAULT_MODEL_IDS];
  }
}

export function buildCopilotModelDefinition(modelId: string): ModelDefinitionConfig {
  const id = modelId.trim();
  if (!id) {
    throw new Error("Model id required");
  }
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
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}
