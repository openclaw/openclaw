/**
 * Dynamic supplemental model discovery.
 *
 * Calls provider APIs (Anthropic, OpenAI) to discover models not yet in
 * pi-ai's static catalog. Results are injected into loadModelCatalog after
 * the built-in models are loaded, so they NEVER replace existing entries.
 *
 * This runs only when auth tokens are available and skips providers that
 * cannot be reached (timeout, errors). The discovery is cached alongside
 * the model catalog in loadModelCatalog.
 */

import type { ModelCatalogEntry } from "./model-catalog.js";

const DISCOVERY_TIMEOUT_MS = 8000;

// ─── Anthropic ─────────────────────────────────────────────────────

interface AnthropicModel {
  id: string;
  display_name?: string;
  type?: string;
  created_at?: string;
}

interface AnthropicModelsResponse {
  data?: AnthropicModel[];
  has_more?: boolean;
}

/** OAuth access tokens start with this prefix. */
const ANTHROPIC_OAUTH_PREFIX = "sk-ant-oat";

function buildAnthropicHeaders(token: string): Record<string, string> {
  if (token.startsWith(ANTHROPIC_OAUTH_PREFIX)) {
    return {
      Authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-dangerous-direct-browser-access": "true",
    };
  }
  return {
    "x-api-key": token,
    "anthropic-version": "2023-06-01",
  };
}

async function discoverAnthropicModels(apiKey: string): Promise<ModelCatalogEntry[]> {
  const models: ModelCatalogEntry[] = [];
  let url = "https://api.anthropic.com/v1/models?limit=100";
  const headers = buildAnthropicHeaders(apiKey);

  while (url) {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });

    if (!response.ok) {
      break;
    }

    const data = (await response.json()) as AnthropicModelsResponse;
    if (!Array.isArray(data.data)) {
      break;
    }

    for (const m of data.data) {
      const id = m.id?.trim();
      if (!id) {
        continue;
      }
      const isReasoning = id.includes("opus") || id.includes("sonnet") || id.includes("haiku");
      const hasVision = id.includes("opus") || id.includes("sonnet");
      models.push({
        id,
        name: m.display_name || id,
        provider: "anthropic",
        reasoning: isReasoning,
        input: hasVision ? ["text", "image"] : ["text"],
        contextWindow: 200000,
      });
    }

    url = data.has_more
      ? `https://api.anthropic.com/v1/models?limit=100&after_id=${models.at(-1)?.id}`
      : "";
  }

  return models;
}

// ─── OpenAI ────────────────────────────────────────────────────────

interface OpenAIModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

interface OpenAIModelsResponse {
  data?: OpenAIModel[];
}

// Models to exclude (embedding, audio, image models that aren't chat completions)
const OPENAI_EXCLUDE_PREFIXES = [
  "text-embedding",
  "dall-e",
  "tts-",
  "whisper",
  "babbage",
  "davinci",
  "text-search",
  "text-similarity",
  "text-davinci",
  "text-curie",
  "text-babbage",
  "text-ada",
  "ada",
  "curie",
  "code-",
  "chatgpt-",
  "ft:",
];

function isOpenAIChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  return !OPENAI_EXCLUDE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

async function discoverOpenAIModels(apiKey: string): Promise<ModelCatalogEntry[]> {
  const response = await fetch("https://api.openai.com/v1/models", {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });

  if (!response.ok) {
    return [];
  }

  const data = (await response.json()) as OpenAIModelsResponse;
  if (!Array.isArray(data.data)) {
    return [];
  }

  const models: ModelCatalogEntry[] = [];
  for (const m of data.data) {
    const id = m.id?.trim();
    if (!id || !isOpenAIChatModel(id)) {
      continue;
    }
    const isReasoning = id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4");
    const hasVision =
      id.includes("gpt-4") || id.includes("gpt-5") || id.startsWith("o3") || id.startsWith("o4");
    models.push({
      id,
      name: id,
      provider: "openai",
      reasoning: isReasoning,
      input: hasVision ? ["text", "image"] : ["text"],
      contextWindow: 128000,
    });
  }

  return models;
}

// ─── Resolve auth tokens ───────────────────────────────────────────

type AuthProfileStore = {
  profiles: Record<
    string,
    | { type: "api_key"; provider: string; key: string }
    | { type: "token"; provider: string; token: string }
    | { type: "oauth"; provider: string; access?: string }
    | { type: string; provider: string; [key: string]: unknown }
  >;
};

function resolveToken(
  provider: string,
  store: AuthProfileStore | null,
  envVarName: string,
): string | undefined {
  const fromEnv = process.env[envVarName]?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  if (!store) {
    return undefined;
  }

  for (const cred of Object.values(store.profiles)) {
    if (cred.provider !== provider) {
      continue;
    }
    if (cred.type === "api_key" && "key" in cred) {
      return (cred as { key: string }).key;
    }
    if (cred.type === "token" && "token" in cred) {
      return (cred as { token: string }).token;
    }
    if (cred.type === "oauth" && "access" in cred) {
      return (cred as { access?: string }).access?.trim() || undefined;
    }
  }

  return undefined;
}

// ─── Public API ────────────────────────────────────────────────────

export interface DiscoveryContext {
  agentDir: string;
}

/**
 * Discover supplemental models from provider APIs.
 * Returns entries not meant to replace existing catalog entries —
 * the caller is responsible for deduplication.
 */
export async function discoverSupplementalModels(
  ctx: DiscoveryContext,
): Promise<ModelCatalogEntry[]> {
  // Skip in test environment
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return [];
  }

  let authStore: AuthProfileStore | null = null;
  try {
    const { ensureAuthProfileStore } = await import("./auth-profiles.js");
    authStore = ensureAuthProfileStore(ctx.agentDir, {
      allowKeychainPrompt: false,
    }) as AuthProfileStore;
  } catch {
    // Auth store not available — rely on env vars only
  }

  const results: ModelCatalogEntry[] = [];
  const tasks: Promise<ModelCatalogEntry[]>[] = [];

  const anthropicToken = resolveToken("anthropic", authStore, "ANTHROPIC_API_KEY");
  if (anthropicToken) {
    tasks.push(
      discoverAnthropicModels(anthropicToken).catch((err) => {
        console.warn(`[model-discovery] Anthropic discovery failed: ${String(err)}`);
        return [] as ModelCatalogEntry[];
      }),
    );
  }

  const openaiToken = resolveToken("openai", authStore, "OPENAI_API_KEY");
  if (openaiToken) {
    tasks.push(
      discoverOpenAIModels(openaiToken).catch((err) => {
        console.warn(`[model-discovery] OpenAI discovery failed: ${String(err)}`);
        return [] as ModelCatalogEntry[];
      }),
    );
  }

  const settled = await Promise.all(tasks);
  for (const batch of settled) {
    results.push(...batch);
  }

  return results;
}

/** Static fallback used only in test environments (empty). */
export const SUPPLEMENTAL_MODELS: ModelCatalogEntry[] = [];
