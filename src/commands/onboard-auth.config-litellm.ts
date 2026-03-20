import type { OpenClawConfig } from "../config/config.js";
import { LITELLM_DEFAULT_MODEL_REF } from "../plugins/provider-auth-storage.js";
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithDefaultModel,
} from "../plugins/provider-onboarding-config.js";

export const LITELLM_BASE_URL = "http://localhost:4000";
export const LITELLM_DEFAULT_MODEL_ID = "claude-opus-4-6";
const LITELLM_DEFAULT_CONTEXT_WINDOW = 128_000;
const LITELLM_DEFAULT_MAX_TOKENS = 8_192;
const LITELLM_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

// Model info returned by LiteLLM /v1/model/info endpoint
type LiteLLMModelInfoResponse = {
  data?: Array<{
    model_name?: string;
    model_info?: {
      max_input_tokens?: number;
      max_output_tokens?: number;
    };
  }>;
};

/**
 * Query LiteLLM /v1/model/info to get actual context window and max output
 * tokens for a specific model. Falls back to defaults on any failure.
 */
export async function fetchLitellmModelInfo(
  baseUrl: string,
  modelId: string,
): Promise<{ contextWindow: number; maxTokens: number }> {
  const defaults = {
    contextWindow: LITELLM_DEFAULT_CONTEXT_WINDOW,
    maxTokens: LITELLM_DEFAULT_MAX_TOKENS,
  };
  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/v1/model/info`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return defaults;
    }
    const data = (await response.json()) as LiteLLMModelInfoResponse;
    for (const entry of data.data ?? []) {
      if (entry.model_name !== modelId) continue;
      const info = entry.model_info;
      if (!info) continue;
      return {
        contextWindow:
          typeof info.max_input_tokens === "number"
            ? info.max_input_tokens
            : defaults.contextWindow,
        maxTokens:
          typeof info.max_output_tokens === "number"
            ? info.max_output_tokens
            : defaults.maxTokens,
      };
    }
  } catch {
    // LiteLLM might not be running yet during onboard — fall back silently
  }
  return defaults;
}

function buildLitellmModelDefinition(overrides?: {
  contextWindow?: number;
  maxTokens?: number;
}): {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
} {
  return {
    id: LITELLM_DEFAULT_MODEL_ID,
    name: "Claude Opus 4.6",
    reasoning: true,
    input: ["text", "image"],
    cost: LITELLM_DEFAULT_COST,
    contextWindow: overrides?.contextWindow ?? LITELLM_DEFAULT_CONTEXT_WINDOW,
    maxTokens: overrides?.maxTokens ?? LITELLM_DEFAULT_MAX_TOKENS,
  };
}

export function applyLitellmProviderConfig(
  cfg: OpenClawConfig,
  modelInfoOverrides?: { contextWindow?: number; maxTokens?: number },
): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[LITELLM_DEFAULT_MODEL_REF] = {
    ...models[LITELLM_DEFAULT_MODEL_REF],
    alias: models[LITELLM_DEFAULT_MODEL_REF]?.alias ?? "LiteLLM",
  };

  const defaultModel = buildLitellmModelDefinition(modelInfoOverrides);

  const existingProvider = cfg.models?.providers?.litellm as { baseUrl?: unknown } | undefined;
  const resolvedBaseUrl =
    typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl.trim() : "";

  return applyProviderConfigWithDefaultModel(cfg, {
    agentModels: models,
    providerId: "litellm",
    api: "openai-completions",
    baseUrl: resolvedBaseUrl || LITELLM_BASE_URL,
    defaultModel,
    defaultModelId: LITELLM_DEFAULT_MODEL_ID,
  });
}

export function applyLitellmConfig(
  cfg: OpenClawConfig,
  modelInfoOverrides?: { contextWindow?: number; maxTokens?: number },
): OpenClawConfig {
  const next = applyLitellmProviderConfig(cfg, modelInfoOverrides);
  return applyAgentDefaultModelPrimary(next, LITELLM_DEFAULT_MODEL_REF);
}
