/**
 * Registry of known LLM providers.
 * Based on model-auth.ts provider mappings.
 */

import type { ProviderCostRates, ProviderDefinition } from "./types.js";

/**
 * All known LLM providers with their configuration.
 */
export const PROVIDER_REGISTRY: ProviderDefinition[] = [
  {
    id: "openai",
    name: "OpenAI",
    envVars: ["OPENAI_API_KEY"],
    authModes: ["api-key", "oauth"],
    defaultBaseUrl: "https://api.openai.com/v1",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    envVars: ["ANTHROPIC_API_KEY"],
    altEnvVars: ["ANTHROPIC_OAUTH_TOKEN"],
    authModes: ["api-key", "oauth"],
  },
  {
    id: "google",
    name: "Google AI",
    envVars: ["GEMINI_API_KEY"],
    authModes: ["api-key"],
  },
  {
    id: "google-antigravity",
    name: "Google Antigravity",
    envVars: ["ANTIGRAVITY_API_KEY"],
    authModes: ["oauth", "api-key"],
  },
  {
    id: "google-gemini-cli",
    name: "Google Gemini CLI",
    envVars: [],
    authModes: ["oauth"],
  },
  {
    id: "google-vertex",
    name: "Google Vertex AI",
    envVars: [],
    authModes: ["oauth"],
    requiresConfig: true,
  },
  {
    id: "groq",
    name: "Groq",
    envVars: ["GROQ_API_KEY"],
    authModes: ["api-key"],
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    models: ["groq/deepseek-r1-distill-llama-70b"],
  },
  {
    id: "mistral",
    name: "Mistral",
    envVars: ["MISTRAL_API_KEY"],
    authModes: ["api-key"],
    defaultBaseUrl: "https://api.mistral.ai/v1",
    models: [
      "mistral/mistral-large-latest",
      "mistral/mistral-small-latest",
      "mistral/codestral-latest",
    ],
  },
  {
    id: "xai",
    name: "xAI",
    envVars: ["XAI_API_KEY"],
    authModes: ["api-key"],
    models: ["xai/grok-2", "xai/grok-2-mini"],
  },
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    envVars: [],
    altEnvVars: ["CODEX_API_KEY"],
    authModes: ["oauth"],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    envVars: ["OPENROUTER_API_KEY"],
    authModes: ["api-key"],
    defaultBaseUrl: "https://openrouter.ai/api/v1",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    envVars: ["CEREBRAS_API_KEY"],
    authModes: ["api-key"],
  },
  {
    id: "deepgram",
    name: "Deepgram",
    envVars: ["DEEPGRAM_API_KEY"],
    authModes: ["api-key"],
  },
  {
    id: "amazon-bedrock",
    name: "Amazon Bedrock",
    envVars: ["AWS_ACCESS_KEY_ID", "AWS_BEARER_TOKEN_BEDROCK"],
    altEnvVars: ["AWS_SECRET_ACCESS_KEY", "AWS_PROFILE"],
    authModes: ["aws-sdk"],
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    envVars: ["COPILOT_GITHUB_TOKEN"],
    altEnvVars: ["GH_TOKEN", "GITHUB_TOKEN"],
    authModes: ["token"],
  },
  {
    id: "ollama",
    name: "Ollama",
    envVars: ["OLLAMA_API_KEY"],
    authModes: ["api-key"],
    defaultBaseUrl: "http://localhost:11434",
    isLocal: true,
  },
  {
    id: "minimax",
    name: "MiniMax",
    envVars: ["MINIMAX_API_KEY"],
    altEnvVars: ["MINIMAX_OAUTH_TOKEN"],
    authModes: ["api-key", "oauth"],
  },
  {
    id: "moonshot",
    name: "Moonshot",
    envVars: ["MOONSHOT_API_KEY"],
    authModes: ["api-key"],
  },
  {
    id: "qwen-portal",
    name: "Qwen Portal",
    envVars: ["QWEN_PORTAL_API_KEY"],
    altEnvVars: ["QWEN_OAUTH_TOKEN"],
    authModes: ["api-key", "oauth"],
  },
  {
    id: "venice",
    name: "Venice",
    envVars: ["VENICE_API_KEY"],
    authModes: ["api-key"],
  },
  {
    id: "vercel-ai-gateway",
    name: "Vercel AI Gateway",
    envVars: ["AI_GATEWAY_API_KEY"],
    authModes: ["api-key"],
  },
  {
    id: "xiaomi",
    name: "Xiaomi",
    envVars: ["XIAOMI_API_KEY"],
    authModes: ["api-key"],
  },
  {
    id: "chutes",
    name: "Chutes",
    envVars: ["CHUTES_API_KEY"],
    altEnvVars: ["CHUTES_OAUTH_TOKEN"],
    authModes: ["api-key", "oauth"],
  },
  {
    id: "zai",
    name: "Z.AI",
    envVars: ["ZAI_API_KEY"],
    altEnvVars: ["Z_AI_API_KEY"],
    authModes: ["api-key"],
  },
  {
    id: "opencode",
    name: "OpenCode",
    envVars: ["OPENCODE_API_KEY"],
    altEnvVars: ["OPENCODE_ZEN_API_KEY"],
    authModes: ["api-key"],
  },
  {
    id: "kimi-coding",
    name: "Kimi Coding",
    envVars: ["KIMI_API_KEY"],
    altEnvVars: ["KIMICODE_API_KEY"],
    authModes: ["api-key"],
  },
  {
    id: "synthetic",
    name: "Synthetic",
    envVars: ["SYNTHETIC_API_KEY"],
    authModes: ["api-key"],
  },
  {
    id: "azure-openai",
    name: "Azure OpenAI",
    envVars: ["AZURE_OPENAI_API_KEY"],
    altEnvVars: ["AZURE_OPENAI_ENDPOINT"],
    authModes: ["api-key"],
    requiresConfig: true,
    models: [
      "azure-openai/gpt-4o",
      "azure-openai/gpt-4o-mini",
      "azure-openai/gpt-4-turbo",
      "azure-openai/o1",
      "azure-openai/o3-mini",
    ],
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    envVars: ["HUGGINGFACE_API_KEY"],
    altEnvVars: ["HF_TOKEN", "HF_API_KEY"],
    authModes: ["api-key"],
    defaultBaseUrl: "https://api-inference.huggingface.co/v1",
    models: [
      "huggingface/meta-llama/Llama-3.3-70B-Instruct",
      "huggingface/Qwen/Qwen2.5-72B-Instruct",
      "huggingface/mistralai/Mistral-7B-Instruct-v0.3",
      "huggingface/microsoft/Phi-3.5-mini-instruct",
    ],
  },
];

/**
 * Get provider definition by ID.
 */
export function getProviderById(id: string): ProviderDefinition | undefined {
  const normalized = id.toLowerCase().trim();
  return PROVIDER_REGISTRY.find((p) => p.id === normalized || p.id === id);
}

/**
 * Get all provider IDs.
 */
export function getAllProviderIds(): string[] {
  return PROVIDER_REGISTRY.map((p) => p.id);
}

/**
 * Get all environment variables used by providers.
 */
export function getAllProviderEnvVars(): string[] {
  const envVars = new Set<string>();
  for (const provider of PROVIDER_REGISTRY) {
    for (const envVar of provider.envVars) {
      envVars.add(envVar);
    }
    for (const envVar of provider.altEnvVars ?? []) {
      envVars.add(envVar);
    }
  }
  return Array.from(envVars);
}

/**
 * Cost rates per 1M tokens for common models.
 * Prices as of January 2025, may need updates.
 */
export const MODEL_COST_RATES: ProviderCostRates[] = [
  // OpenAI
  { providerId: "openai", modelId: "gpt-4o", inputPer1M: 2.5, outputPer1M: 10 },
  { providerId: "openai", modelId: "gpt-4o-mini", inputPer1M: 0.15, outputPer1M: 0.6 },
  { providerId: "openai", modelId: "gpt-4-turbo", inputPer1M: 10, outputPer1M: 30 },
  { providerId: "openai", modelId: "gpt-3.5-turbo", inputPer1M: 0.5, outputPer1M: 1.5 },
  { providerId: "openai", modelId: "o1", inputPer1M: 15, outputPer1M: 60 },
  { providerId: "openai", modelId: "o1-mini", inputPer1M: 3, outputPer1M: 12 },

  // Anthropic
  {
    providerId: "anthropic",
    modelId: "claude-3-5-sonnet-20241022",
    inputPer1M: 3,
    outputPer1M: 15,
    cacheReadPer1M: 0.3,
    cacheWritePer1M: 3.75,
  },
  {
    providerId: "anthropic",
    modelId: "claude-3-5-haiku-20241022",
    inputPer1M: 0.8,
    outputPer1M: 4,
    cacheReadPer1M: 0.08,
    cacheWritePer1M: 1,
  },
  {
    providerId: "anthropic",
    modelId: "claude-3-opus-20240229",
    inputPer1M: 15,
    outputPer1M: 75,
    cacheReadPer1M: 1.5,
    cacheWritePer1M: 18.75,
  },
  {
    providerId: "anthropic",
    modelId: "claude-sonnet-4-20250514",
    inputPer1M: 3,
    outputPer1M: 15,
    cacheReadPer1M: 0.3,
    cacheWritePer1M: 3.75,
  },
  {
    providerId: "anthropic",
    modelId: "claude-opus-4-20250514",
    inputPer1M: 15,
    outputPer1M: 75,
    cacheReadPer1M: 1.5,
    cacheWritePer1M: 18.75,
  },

  // Google
  { providerId: "google", modelId: "gemini-2.0-flash", inputPer1M: 0.1, outputPer1M: 0.4 },
  { providerId: "google", modelId: "gemini-1.5-pro", inputPer1M: 1.25, outputPer1M: 5 },
  { providerId: "google", modelId: "gemini-1.5-flash", inputPer1M: 0.075, outputPer1M: 0.3 },

  // Groq
  { providerId: "groq", modelId: "llama-3.3-70b-versatile", inputPer1M: 0.59, outputPer1M: 0.79 },
  { providerId: "groq", modelId: "mixtral-8x7b-32768", inputPer1M: 0.24, outputPer1M: 0.24 },

  // Mistral
  { providerId: "mistral", modelId: "mistral-large-latest", inputPer1M: 2, outputPer1M: 6 },
  { providerId: "mistral", modelId: "mistral-small-latest", inputPer1M: 0.2, outputPer1M: 0.6 },

  // xAI
  { providerId: "xai", modelId: "grok-2", inputPer1M: 2, outputPer1M: 10 },
  { providerId: "xai", modelId: "grok-2-mini", inputPer1M: 0.2, outputPer1M: 1 },
];

/**
 * Get cost rates for a specific model.
 */
export function getModelCostRates(
  providerId: string,
  modelId: string,
): ProviderCostRates | undefined {
  // Try exact match first
  let rates = MODEL_COST_RATES.find((r) => r.providerId === providerId && r.modelId === modelId);
  if (rates) {
    return rates;
  }

  // Try partial match (model ID contains the pattern)
  rates = MODEL_COST_RATES.find((r) => r.providerId === providerId && modelId.includes(r.modelId));
  if (rates) {
    return rates;
  }

  // Try reverse partial match
  rates = MODEL_COST_RATES.find((r) => r.providerId === providerId && r.modelId.includes(modelId));
  return rates;
}

/**
 * Calculate cost for token usage.
 */
export function calculateCost(params: {
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): number {
  const rates = getModelCostRates(params.providerId, params.modelId);
  if (!rates) {
    return 0;
  }

  let cost = 0;
  cost += (params.inputTokens / 1_000_000) * rates.inputPer1M;
  cost += (params.outputTokens / 1_000_000) * rates.outputPer1M;

  if (params.cacheReadTokens && rates.cacheReadPer1M) {
    cost += (params.cacheReadTokens / 1_000_000) * rates.cacheReadPer1M;
  }
  if (params.cacheWriteTokens && rates.cacheWritePer1M) {
    cost += (params.cacheWriteTokens / 1_000_000) * rates.cacheWritePer1M;
  }

  return cost;
}
