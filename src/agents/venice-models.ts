import type { ModelDefinitionConfig } from "../config/types.js";

export const VENICE_BASE_URL = "https://api.venice.ai/api/v1";
export const VENICE_DEFAULT_MODEL_ID = "qwen3-5-9b";
export const VENICE_DEFAULT_MODEL_REF = `venice/${VENICE_DEFAULT_MODEL_ID}`;

// Venice uses credit-based pricing, not per-token costs.
// Set to 0 as costs vary by model and account type.
export const VENICE_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * Complete catalog of Venice AI models.
 *
 * Venice provides two privacy modes:
 * - "private": Fully private inference, no logging, ephemeral
 * - "anonymized": Proxied through Venice with metadata stripped (for proprietary models)
 *
 * Note: The `privacy` field is included for documentation purposes but is not
 * propagated to ModelDefinitionConfig as it's not part of the core model schema.
 * Privacy mode is determined by the model itself, not configurable at runtime.
 *
 * This catalog serves as a fallback when the Venice API is unreachable.
 */
export const VENICE_MODEL_CATALOG = [
  // ============================================
  // PRIVATE MODELS (Fully private, no logging)
  // ============================================

  // GLM models
  {
    id: "zai-org-glm-5-1",
    name: "GLM 5.1",
    reasoning: true,
    input: ["text"],
    contextWindow: 200000,
    maxTokens: 24000,
    privacy: "private",
  },
  {
    id: "zai-org-glm-5",
    name: "GLM 5",
    reasoning: true,
    input: ["text"],
    contextWindow: 198000,
    maxTokens: 32000,
    privacy: "private",
  },
  {
    id: "olafangensan-glm-4.7-flash-heretic",
    name: "GLM 4.7 Flash Heretic",
    reasoning: true,
    input: ["text"],
    contextWindow: 200000,
    maxTokens: 24000,
    privacy: "private",
  },
  {
    id: "zai-org-glm-4.7-flash",
    name: "GLM 4.7 Flash",
    reasoning: true,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 16384,
    privacy: "private",
  },
  {
    id: "zai-org-glm-4.6",
    name: "GLM 4.6",
    reasoning: true,
    input: ["text"],
    contextWindow: 198000,
    maxTokens: 16384,
    privacy: "private",
  },
  {
    id: "zai-org-glm-4.7",
    name: "GLM 4.7",
    reasoning: true,
    input: ["text"],
    contextWindow: 198000,
    maxTokens: 16384,
    privacy: "private",
  },

  // Llama models
  {
    id: "llama-3.3-70b",
    name: "Llama 3.3 70B",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 4096,
    privacy: "private",
  },
  {
    id: "llama-3.2-3b",
    name: "Llama 3.2 3B",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 4096,
    privacy: "private",
  },
  {
    id: "hermes-3-llama-3.1-405b",
    name: "Hermes 3 Llama 3.1 405B",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 16384,
    privacy: "private",
  },

  // Qwen models
  {
    id: "qwen-3-6-plus",
    name: "Qwen 3.6 Plus Uncensored",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 65536,
    privacy: "private",
  },
  {
    id: "qwen3-5-9b",
    name: "Qwen 3.5 9B",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 256000,
    maxTokens: 32768,
    privacy: "private",
  },
  {
    id: "qwen3-5-35b-a3b",
    name: "Qwen 3.5 35B",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 256000,
    maxTokens: 65536,
    privacy: "private",
  },
  {
    id: "qwen3-235b-a22b-thinking-2507",
    name: "Qwen3 235B Thinking",
    reasoning: true,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 16384,
    privacy: "private",
  },
  {
    id: "qwen3-235b-a22b-instruct-2507",
    name: "Qwen3 235B Instruct",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 16384,
    privacy: "private",
  },
  {
    id: "qwen3-coder-480b-a35b-instruct",
    name: "Qwen3 Coder 480B",
    reasoning: false,
    input: ["text"],
    contextWindow: 256000,
    maxTokens: 65536,
    privacy: "private",
  },
  {
    id: "qwen3-coder-480b-a35b-instruct-turbo",
    name: "Qwen3 Coder 480B Turbo",
    reasoning: false,
    input: ["text"],
    contextWindow: 256000,
    maxTokens: 65536,
    privacy: "private",
  },
  {
    id: "qwen3-next-80b",
    name: "Qwen3 Next 80B",
    reasoning: false,
    input: ["text"],
    contextWindow: 256000,
    maxTokens: 16384,
    privacy: "private",
  },
  {
    id: "qwen3-vl-235b-a22b",
    name: "Qwen3 VL 235B (Vision)",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 256000,
    maxTokens: 16384,
    privacy: "private",
  },

  // DeepSeek
  {
    id: "deepseek-v3.2",
    name: "DeepSeek V3.2",
    reasoning: true,
    input: ["text"],
    contextWindow: 160000,
    maxTokens: 32768,
    privacy: "private",
  },

  // Venice-specific models
  {
    id: "venice-uncensored",
    name: "Venice Uncensored 1.1",
    reasoning: false,
    input: ["text"],
    contextWindow: 32000,
    maxTokens: 8192,
    privacy: "private",
  },
  {
    id: "venice-uncensored-role-play",
    name: "Venice Role Play Uncensored",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 128000,
    maxTokens: 4096,
    privacy: "private",
  },

  // Mistral models
  {
    id: "mistral-small-3-2-24b-instruct",
    name: "Mistral Small 3.2 24B",
    reasoning: false,
    input: ["text"],
    contextWindow: 256000,
    maxTokens: 16384,
    privacy: "private",
  },
  {
    id: "mistral-small-2603",
    name: "Mistral Small 4",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 256000,
    maxTokens: 65536,
    privacy: "private",
  },

  // Google Gemma models
  {
    id: "google.gemma-4-26b-a4b-it",
    name: "Google Gemma 4 26B",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 256000,
    maxTokens: 8192,
    privacy: "private",
  },
  {
    id: "google.gemma-4-31b-it",
    name: "Google Gemma 4 31B",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 256000,
    maxTokens: 8192,
    privacy: "private",
  },
  {
    id: "google-gemma-3-27b-it",
    name: "Google Gemma 3 27B",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 198000,
    maxTokens: 16384,
    privacy: "private",
  },

  // Arcee
  {
    id: "arcee-trinity-large-thinking",
    name: "Arcee Trinity Large Thinking",
    reasoning: true,
    input: ["text"],
    contextWindow: 256000,
    maxTokens: 65536,
    privacy: "private",
  },

  // OpenAI open-source
  {
    id: "openai-gpt-oss-120b",
    name: "OpenAI GPT OSS 120B",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 16384,
    privacy: "private",
  },

  // Kimi models
  {
    id: "kimi-k2-thinking",
    name: "Kimi K2 Thinking",
    reasoning: true,
    input: ["text"],
    contextWindow: 256000,
    maxTokens: 65536,
    privacy: "private",
  },
  {
    id: "kimi-k2-5",
    name: "Kimi K2.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 256000,
    maxTokens: 65536,
    privacy: "private",
  },

  // MiniMax models
  {
    id: "minimax-m21",
    name: "MiniMax M2.1",
    reasoning: true,
    input: ["text"],
    contextWindow: 198000,
    maxTokens: 32768,
    privacy: "private",
  },
  {
    id: "minimax-m25",
    name: "MiniMax M2.5",
    reasoning: true,
    input: ["text"],
    contextWindow: 198000,
    maxTokens: 32768,
    privacy: "private",
  },

  // Nvidia models
  {
    id: "nvidia-nemotron-3-nano-30b-a3b",
    name: "NVIDIA Nemotron 3 Nano 30B",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 16384,
    privacy: "private",
  },
  {
    id: "nvidia-nemotron-cascade-2-30b-a3b",
    name: "NVIDIA Nemotron Cascade 2 30B",
    reasoning: true,
    input: ["text"],
    contextWindow: 256000,
    maxTokens: 32768,
    privacy: "private",
  },

  // xAI / Grok models
  {
    id: "grok-41-fast",
    name: "Grok 4.1 Fast",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 30000,
    privacy: "private",
  },
  {
    id: "grok-4-20-beta",
    name: "Grok 4.20 Beta",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 2000000,
    maxTokens: 128000,
    privacy: "private",
  },
  {
    id: "grok-4-20-multi-agent-beta",
    name: "Grok 4.20 Multi-Agent Beta",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 2000000,
    maxTokens: 128000,
    privacy: "private",
  },

  // ============================================
  // ANONYMIZED MODELS (Proxied through Venice)
  // ============================================

  // GLM (anonymized)
  {
    id: "z-ai-glm-5-turbo",
    name: "GLM 5 Turbo (via Venice)",
    reasoning: true,
    input: ["text"],
    contextWindow: 200000,
    maxTokens: 32768,
    privacy: "anonymized",
  },
  {
    id: "z-ai-glm-5v-turbo",
    name: "GLM 5V Turbo (via Venice)",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 32768,
    privacy: "anonymized",
  },

  // Qwen (anonymized)
  {
    id: "qwen3-5-397b-a17b",
    name: "Qwen 3.5 397B (via Venice)",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 128000,
    maxTokens: 32768,
    privacy: "anonymized",
  },

  // Anthropic (via Venice)
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6 (via Venice)",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 128000,
    privacy: "anonymized",
  },
  {
    id: "claude-opus-4-6-fast",
    name: "Claude Opus 4.6 Fast (via Venice)",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 128000,
    privacy: "anonymized",
  },
  {
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5 (via Venice)",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 198000,
    maxTokens: 32768,
    privacy: "anonymized",
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (via Venice)",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 64000,
    privacy: "anonymized",
  },
  {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5 (via Venice)",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 198000,
    maxTokens: 64000,
    privacy: "anonymized",
  },

  // OpenAI (via Venice)
  {
    id: "openai-gpt-52",
    name: "GPT-5.2 (via Venice)",
    reasoning: true,
    input: ["text"],
    contextWindow: 256000,
    maxTokens: 65536,
    privacy: "anonymized",
  },
  {
    id: "openai-gpt-52-codex",
    name: "GPT-5.2 Codex (via Venice)",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 256000,
    maxTokens: 65536,
    privacy: "anonymized",
  },
  {
    id: "openai-gpt-53-codex",
    name: "GPT-5.3 Codex (via Venice)",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 400000,
    maxTokens: 128000,
    privacy: "anonymized",
  },
  {
    id: "openai-gpt-54",
    name: "GPT-5.4 (via Venice)",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 131072,
    privacy: "anonymized",
  },
  {
    id: "openai-gpt-54-pro",
    name: "GPT-5.4 Pro (via Venice)",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 128000,
    privacy: "anonymized",
  },
  {
    id: "openai-gpt-54-mini",
    name: "GPT-5.4 Mini (via Venice)",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 400000,
    maxTokens: 128000,
    privacy: "anonymized",
  },
  {
    id: "openai-gpt-4o-2024-11-20",
    name: "GPT-4o (via Venice)",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 128000,
    maxTokens: 16384,
    privacy: "anonymized",
  },
  {
    id: "openai-gpt-4o-mini-2024-07-18",
    name: "GPT-4o Mini (via Venice)",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 128000,
    maxTokens: 16384,
    privacy: "anonymized",
  },

  // Google (via Venice)
  {
    id: "gemini-3-1-pro-preview",
    name: "Gemini 3.1 Pro (via Venice)",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 32768,
    privacy: "anonymized",
  },
  {
    id: "gemini-3-flash-preview",
    name: "Gemini 3 Flash (via Venice)",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 256000,
    maxTokens: 65536,
    privacy: "anonymized",
  },

  // MiniMax (anonymized)
  {
    id: "minimax-m27",
    name: "MiniMax M2.7 (via Venice)",
    reasoning: true,
    input: ["text"],
    contextWindow: 198000,
    maxTokens: 32768,
    privacy: "anonymized",
  },

  // Mercury
  {
    id: "mercury-2",
    name: "Mercury 2 (via Venice)",
    reasoning: true,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 50000,
    privacy: "anonymized",
  },

  // Aion
  {
    id: "aion-labs.aion-2-0",
    name: "Aion 2.0 (via Venice)",
    reasoning: true,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 32768,
    privacy: "anonymized",
  },
] as const;

export type VeniceCatalogEntry = (typeof VENICE_MODEL_CATALOG)[number];

/**
 * Build a ModelDefinitionConfig from a Venice catalog entry.
 *
 * Note: The `privacy` field from the catalog is not included in the output
 * as ModelDefinitionConfig doesn't support custom metadata fields. Privacy
 * mode is inherent to each model and documented in the catalog/docs.
 */
export function buildVeniceModelDefinition(entry: VeniceCatalogEntry): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: VENICE_DEFAULT_COST,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    // Avoid usage-only streaming chunks that can break OpenAI-compatible parsers.
    // See: https://github.com/openclaw/openclaw/issues/15819
    compat: {
      supportsUsageInStreaming: false,
    },
  };
}

// Venice API response types
interface VeniceModelSpec {
  name: string;
  privacy: "private" | "anonymized";
  availableContextTokens: number;
  maxCompletionTokens?: number;
  capabilities: {
    supportsReasoning: boolean;
    supportsVision: boolean;
    supportsFunctionCalling: boolean;
  };
}

interface VeniceModel {
  id: string;
  model_spec: VeniceModelSpec;
}

interface VeniceModelsResponse {
  data: VeniceModel[];
}

function coercePositiveNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  if (value <= 0) {
    return null;
  }
  return Math.floor(value);
}

function resolveVeniceMaxTokens(params: {
  maxCompletionTokens: unknown;
  contextWindow: unknown;
  fallbackMaxTokens: number;
}): number {
  const completionLimit = coercePositiveNumber(params.maxCompletionTokens);
  const contextWindow = coercePositiveNumber(params.contextWindow);
  const fallback = coercePositiveNumber(params.fallbackMaxTokens) ?? 8192;

  const raw = completionLimit ?? fallback;
  return contextWindow ? Math.min(raw, contextWindow) : raw;
}

/**
 * Discover models from Venice API with fallback to static catalog.
 * The /models endpoint is public and doesn't require authentication.
 */
export async function discoverVeniceModels(): Promise<ModelDefinitionConfig[]> {
  // Skip API discovery in test environment
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return VENICE_MODEL_CATALOG.map(buildVeniceModelDefinition);
  }

  async function attemptDiscovery(timeoutMs: number): Promise<ModelDefinitionConfig[] | null> {
    try {
      const response = await fetch(`${VENICE_BASE_URL}/models`, {
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        console.warn(`[venice-models] Failed to discover models: HTTP ${response.status}`);
        return null;
      }

      const data = (await response.json()) as VeniceModelsResponse;
      if (!Array.isArray(data.data) || data.data.length === 0) {
        console.warn("[venice-models] No models found from API");
        return null;
      }

      // Merge discovered models with catalog metadata
      const catalogById = new Map<string, VeniceCatalogEntry>(
        VENICE_MODEL_CATALOG.map((m) => [m.id, m]),
      );
      const models: ModelDefinitionConfig[] = [];

      for (const apiModel of data.data) {
        const catalogEntry = catalogById.get(apiModel.id);
        if (catalogEntry) {
          const contextWindow =
            coercePositiveNumber(apiModel.model_spec.availableContextTokens) ??
            catalogEntry.contextWindow;
          const maxTokens = resolveVeniceMaxTokens({
            maxCompletionTokens: apiModel.model_spec.maxCompletionTokens,
            contextWindow,
            fallbackMaxTokens: catalogEntry.maxTokens,
          });
          models.push({
            ...buildVeniceModelDefinition(catalogEntry),
            contextWindow,
            maxTokens,
          });
        } else {
          const isReasoning =
            apiModel.model_spec.capabilities.supportsReasoning ||
            apiModel.id.toLowerCase().includes("thinking") ||
            apiModel.id.toLowerCase().includes("reason") ||
            apiModel.id.toLowerCase().includes("r1");

          const hasVision = apiModel.model_spec.capabilities.supportsVision;

          models.push({
            id: apiModel.id,
            name: apiModel.model_spec.name || apiModel.id,
            reasoning: isReasoning,
            input: hasVision ? ["text", "image"] : ["text"],
            cost: VENICE_DEFAULT_COST,
            contextWindow:
              coercePositiveNumber(apiModel.model_spec.availableContextTokens) ?? 128000,
            maxTokens: resolveVeniceMaxTokens({
              maxCompletionTokens: apiModel.model_spec.maxCompletionTokens,
              contextWindow: apiModel.model_spec.availableContextTokens,
              fallbackMaxTokens: 8192,
            }),
            compat: {
              supportsUsageInStreaming: false,
            },
          });
        }
      }

      return models.length > 0 ? models : null;
    } catch (error) {
      console.warn(`[venice-models] Discovery attempt failed: ${String(error)}`);
      return null;
    }
  }

  // First attempt with 15s timeout
  const first = await attemptDiscovery(15_000);
  if (first) {
    return first;
  }

  // Retry once after 1s delay with 10s timeout
  console.warn("[venice-models] Retrying discovery in 1s...");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const second = await attemptDiscovery(10_000);
  if (second) {
    return second;
  }

  // Fall back to static catalog
  console.warn("[venice-models] All discovery attempts failed, using static catalog");
  return VENICE_MODEL_CATALOG.map(buildVeniceModelDefinition);
}
