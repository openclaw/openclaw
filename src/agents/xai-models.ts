import type { ModelDefinitionConfig } from "../config/types.js";

export const XAI_BASE_URL = "https://api.x.ai/v1";
export const XAI_DEFAULT_MODEL_ID = "grok-4-1-fast-reasoning";
export const XAI_DEFAULT_MODEL_REF = `xai/${XAI_DEFAULT_MODEL_ID}`;

export const XAI_MODEL_CATALOG = [
  {
    id: "grok-4-1-fast-reasoning",
    name: "Grok 4.1 Fast Reasoning",
    reasoning: true,
    input: ["text"] as const,
    contextWindow: 2000000, // 2M context
    maxTokens: 30000, // Up to 30K output
    cost: { input: 0.2, output: 0.5, cacheRead: 0, cacheWrite: 0 }, // Official xAI pricing per 1M tokens
    compat: { supportsReasoningEffort: false } as const, // CRITICAL: doesn't support parameter
  },
  {
    id: "grok-4-1-fast-non-reasoning",
    name: "Grok 4.1 Fast Non-Reasoning",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 2000000, // 2M context
    maxTokens: 30000, // Up to 30K output
    cost: { input: 0.2, output: 0.5, cacheRead: 0, cacheWrite: 0 }, // Official xAI pricing per 1M tokens
  },
  {
    id: "grok-code-fast-1",
    name: "Grok Code Fast 1",
    reasoning: true,
    input: ["text"] as const,
    contextWindow: 256000, // 256K context
    maxTokens: 10000, // 10K output
    cost: { input: 0.2, output: 1.5, cacheRead: 0.02, cacheWrite: 0 }, // Official xAI pricing per 1M tokens
    compat: { supportsReasoningEffort: false } as const, // Agentic coding model
  },
  {
    id: "grok-3",
    name: "Grok 3",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 1000000, // 1M context
    maxTokens: 4096, // ~4K output
    cost: { input: 3.0, output: 15.0, cacheRead: 0, cacheWrite: 0 }, // Official xAI pricing per 1M tokens
    compat: { supportsReasoningEffort: true } as const, // Supports reasoning_effort parameter
  },
  {
    id: "grok-3-mini",
    name: "Grok 3 Mini",
    reasoning: true,
    input: ["text"] as const,
    contextWindow: 131072, // 131K context
    maxTokens: 8192, // Estimated
    cost: { input: 0.3, output: 0.5, cacheRead: 0, cacheWrite: 0 }, // From Oracle/third-party
    compat: { supportsReasoningEffort: true } as const, // Supports reasoning_effort parameter
  },
] as const;

export type XaiCatalogEntry = (typeof XAI_MODEL_CATALOG)[number];

export function buildXaiModelDefinition(entry: XaiCatalogEntry): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: entry.cost,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    ...("compat" in entry ? { compat: entry.compat } : {}),
  };
}
