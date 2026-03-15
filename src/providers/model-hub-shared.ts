import type { ModelDefinitionConfig } from "../config/types.models.js";

export const MODEL_HUB_BASE_URL = "https://api.model-hub.cn/v1";

export const MODEL_HUB_DEFAULT_MODEL_ID = "gemini-3-flash-preview";
export const MODEL_HUB_DEFAULT_MODEL_NAME = "Gemini 3 Flash Preview";

/** Zero-cost defaults: aggregator with unknown per-model costs. */
export const MODEL_HUB_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * Static catalog used as fallback when dynamic discovery is unavailable.
 */
export const MODEL_HUB_STATIC_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "gemini-3-flash-preview",
    name: "Gemini 3 Flash Preview",
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    cost: MODEL_HUB_DEFAULT_COST,
    reasoning: false,
    input: ["text"],
  },
  {
    id: "gpt-4.1",
    name: "GPT-4.1",
    contextWindow: 1_047_576,
    maxTokens: 32_768,
    cost: MODEL_HUB_DEFAULT_COST,
    reasoning: false,
    input: ["text"],
  },
  {
    id: "claude-sonnet-4-20250514",
    name: "Claude Sonnet 4",
    contextWindow: 200_000,
    maxTokens: 16_384,
    cost: MODEL_HUB_DEFAULT_COST,
    reasoning: false,
    input: ["text"],
  },
];
