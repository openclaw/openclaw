import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
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

/** Result from probing the LiteLLM /v1/model/info endpoint. */
export type LiteLLMModelInfoResult = {
  contextWindow: number;
  maxTokens: number;
  /** True when the values came from the proxy; false when using fallback defaults. */
  discovered: boolean;
};

/**
 * Strip a trailing `/v1` suffix from a base URL so callers can safely
 * append `/v1/model/info` without producing `/v1/v1/model/info`.
 */
function stripV1Suffix(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}

/**
 * Query LiteLLM /v1/model/info to get actual context window and max output
 * tokens for a specific model. Falls back to defaults on any failure.
 *
 * @param baseUrl - LiteLLM proxy base URL (with or without trailing /v1)
 * @param modelId - model name to look up
 * @param apiKey - optional API key for authenticated proxies
 */
export async function fetchLitellmModelInfo(
  baseUrl: string,
  modelId: string,
  apiKey?: string,
): Promise<LiteLLMModelInfoResult> {
  const defaults: LiteLLMModelInfoResult = {
    contextWindow: LITELLM_DEFAULT_CONTEXT_WINDOW,
    maxTokens: LITELLM_DEFAULT_MAX_TOKENS,
    discovered: false,
  };
  try {
    const url = `${stripV1Suffix(baseUrl)}/v1/model/info`;
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return defaults;
    }
    const data = (await response.json()) as LiteLLMModelInfoResponse;
    for (const entry of data.data ?? []) {
      if (entry.model_name !== modelId) {
        continue;
      }
      const info = entry.model_info;
      if (!info) {
        continue;
      }
      return {
        contextWindow:
          typeof info.max_input_tokens === "number"
            ? info.max_input_tokens
            : defaults.contextWindow,
        maxTokens:
          typeof info.max_output_tokens === "number" ? info.max_output_tokens : defaults.maxTokens,
        discovered: true,
      };
    }
  } catch {
    // LiteLLM might not be running yet during onboard — fall back silently
  }
  return defaults;
}

function buildLitellmModelDefinition(overrides?: { contextWindow?: number; maxTokens?: number }): {
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

/**
 * Patch contextWindow/maxTokens on an existing model entry in the provider
 * config. `applyProviderConfigWithDefaultModel` preserves existing model
 * entries when the defaultModelId is already present, so a re-auth/upgrade
 * would otherwise keep stale 128k/8192 values. This post-apply patch
 * overwrites only the two capability fields on the matching model.
 */
function patchExistingModelLimits(
  cfg: OpenClawConfig,
  providerId: string,
  modelId: string,
  overrides: { contextWindow: number; maxTokens: number },
): OpenClawConfig {
  const provider = cfg.models?.providers?.[providerId];
  if (!provider) {
    return cfg;
  }
  const models = (provider as { models?: ModelDefinitionConfig[] }).models;
  if (!models) {
    return cfg;
  }
  const idx = models.findIndex((m) => m.id === modelId);
  if (idx < 0) {
    return cfg;
  }
  const existing = models[idx];
  if (
    existing.contextWindow === overrides.contextWindow &&
    existing.maxTokens === overrides.maxTokens
  ) {
    return cfg; // already up to date
  }
  const updatedModels = [...models];
  updatedModels[idx] = { ...existing, ...overrides };
  return {
    ...cfg,
    models: {
      ...cfg.models,
      providers: {
        ...cfg.models?.providers,
        [providerId]: { ...provider, models: updatedModels },
      },
    },
  };
}

export function applyLitellmProviderConfig(
  cfg: OpenClawConfig,
  modelInfo?: LiteLLMModelInfoResult,
): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[LITELLM_DEFAULT_MODEL_REF] = {
    ...models[LITELLM_DEFAULT_MODEL_REF],
    alias: models[LITELLM_DEFAULT_MODEL_REF]?.alias ?? "LiteLLM",
  };

  const defaultModel = buildLitellmModelDefinition(modelInfo);

  const existingProvider = cfg.models?.providers?.litellm as { baseUrl?: unknown } | undefined;
  const resolvedBaseUrl =
    typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl.trim() : "";

  let next = applyProviderConfigWithDefaultModel(cfg, {
    agentModels: models,
    providerId: "litellm",
    api: "openai-completions",
    baseUrl: resolvedBaseUrl || LITELLM_BASE_URL,
    defaultModel,
    defaultModelId: LITELLM_DEFAULT_MODEL_ID,
  });

  // Only patch existing model entries when the probe actually discovered real
  // values from the proxy. When the probe falls back to defaults (proxy down,
  // 401, model not found), skip the patch to preserve any previously discovered
  // limits already stored in the config.
  if (modelInfo?.discovered) {
    next = patchExistingModelLimits(next, "litellm", LITELLM_DEFAULT_MODEL_ID, {
      contextWindow: modelInfo.contextWindow,
      maxTokens: modelInfo.maxTokens,
    });
  }

  return next;
}

export function applyLitellmConfig(
  cfg: OpenClawConfig,
  modelInfo?: LiteLLMModelInfoResult,
): OpenClawConfig {
  const next = applyLitellmProviderConfig(cfg, modelInfo);
  return applyAgentDefaultModelPrimary(next, LITELLM_DEFAULT_MODEL_REF);
}
