import type { OpenClawConfig } from "../config/config.js";
import { toAgentModelListLike } from "../config/model-input.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import {
  applyAgentDefaultModelPrimary,
  applyOnboardAuthAgentModelsAndProviders,
} from "./onboard-auth.config-shared.js";
import {
  buildMinimaxApiModelDefinition,
  buildMinimaxModelDefinition,
  DEFAULT_MINIMAX_BASE_URL,
  DEFAULT_MINIMAX_CONTEXT_WINDOW,
  DEFAULT_MINIMAX_MAX_TOKENS,
  MINIMAX_API_BASE_URL,
  MINIMAX_CN_API_BASE_URL,
  MINIMAX_HOSTED_COST,
  MINIMAX_HOSTED_MODEL_ID,
  MINIMAX_HOSTED_MODEL_REF,
  MINIMAX_LM_STUDIO_COST,
} from "./onboard-auth.models.js";

export function applyMinimaxProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models["anthropic/claude-opus-4-6"] = {
    ...models["anthropic/claude-opus-4-6"],
    alias: models["anthropic/claude-opus-4-6"]?.alias ?? "Opus",
  };
  models["lmstudio/minimax-m2.1-gs32"] = {
    ...models["lmstudio/minimax-m2.1-gs32"],
    alias: models["lmstudio/minimax-m2.1-gs32"]?.alias ?? "Minimax",
  };

  const providers = { ...cfg.models?.providers };
  if (!providers.lmstudio) {
    providers.lmstudio = {
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "lmstudio",
      api: "openai-responses",
      models: [
        buildMinimaxModelDefinition({
          id: "minimax-m2.1-gs32",
          name: "MiniMax M2.1 GS32",
          reasoning: false,
          cost: MINIMAX_LM_STUDIO_COST,
          contextWindow: 196608,
          maxTokens: 8192,
        }),
      ],
    };
  }

  return applyOnboardAuthAgentModelsAndProviders(cfg, { agentModels: models, providers });
}

export function applyMinimaxHostedProviderConfig(
  cfg: OpenClawConfig,
  params?: { baseUrl?: string },
): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[MINIMAX_HOSTED_MODEL_REF] = {
    ...models[MINIMAX_HOSTED_MODEL_REF],
    alias: models[MINIMAX_HOSTED_MODEL_REF]?.alias ?? "Minimax",
  };

  const providers = { ...cfg.models?.providers };
  const hostedModel = buildMinimaxModelDefinition({
    id: MINIMAX_HOSTED_MODEL_ID,
    cost: MINIMAX_HOSTED_COST,
    contextWindow: DEFAULT_MINIMAX_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MINIMAX_MAX_TOKENS,
  });
  const existingProvider = providers.minimax;
  const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
  const hasHostedModel = existingModels.some((model) => model.id === MINIMAX_HOSTED_MODEL_ID);
  const mergedModels = hasHostedModel ? existingModels : [...existingModels, hostedModel];
  providers.minimax = {
    ...existingProvider,
    baseUrl: params?.baseUrl?.trim() || DEFAULT_MINIMAX_BASE_URL,
    apiKey: "minimax",
    api: "openai-completions",
    models: mergedModels.length > 0 ? mergedModels : [hostedModel],
  };

  return applyOnboardAuthAgentModelsAndProviders(cfg, { agentModels: models, providers });
}

export function applyMinimaxConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = applyMinimaxProviderConfig(cfg);
  return applyAgentDefaultModelPrimary(next, "lmstudio/minimax-m2.1-gs32");
}

export function applyMinimaxHostedConfig(
  cfg: OpenClawConfig,
  params?: { baseUrl?: string },
): OpenClawConfig {
  const next = applyMinimaxHostedProviderConfig(cfg, params);
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        model: {
          ...toAgentModelListLike(next.agents?.defaults?.model),
          primary: MINIMAX_HOSTED_MODEL_REF,
        },
      },
    },
  };
}

// MiniMax Anthropic-compatible API (platform.minimax.io/anthropic)
export function applyMinimaxApiProviderConfig(
  cfg: OpenClawConfig,
  modelId: string = "MiniMax-M2.5",
): OpenClawConfig {
  return applyMinimaxApiProviderConfigWithBaseUrl(cfg, {
    providerId: "minimax",
    modelId,
    baseUrl: MINIMAX_API_BASE_URL,
  });
}

export function applyMinimaxApiConfig(
  cfg: OpenClawConfig,
  modelId: string = "MiniMax-M2.5",
): OpenClawConfig {
  return applyMinimaxApiConfigWithBaseUrl(cfg, {
    providerId: "minimax",
    modelId,
    baseUrl: MINIMAX_API_BASE_URL,
  });
}

// MiniMax China API (api.minimaxi.com)
export function applyMinimaxApiProviderConfigCn(
  cfg: OpenClawConfig,
  modelId: string = "MiniMax-M2.5",
): OpenClawConfig {
  return applyMinimaxApiProviderConfigWithBaseUrl(cfg, {
    providerId: "minimax-cn",
    modelId,
    baseUrl: MINIMAX_CN_API_BASE_URL,
  });
}

export function applyMinimaxApiConfigCn(
  cfg: OpenClawConfig,
  modelId: string = "MiniMax-M2.5",
): OpenClawConfig {
  return applyMinimaxApiConfigWithBaseUrl(cfg, {
    providerId: "minimax-cn",
    modelId,
    baseUrl: MINIMAX_CN_API_BASE_URL,
  });
}

type MinimaxApiProviderConfigParams = {
  providerId: string;
  modelId: string;
  baseUrl: string;
};

function applyMinimaxApiProviderConfigWithBaseUrl(
  cfg: OpenClawConfig,
  params: MinimaxApiProviderConfigParams,
): OpenClawConfig {
  const providers = { ...cfg.models?.providers } as Record<string, ModelProviderConfig>;
  const existingProvider = providers[params.providerId];
  const existingModels = existingProvider?.models ?? [];
  const apiModel = buildMinimaxApiModelDefinition(params.modelId);
  const hasApiModel = existingModels.some((model) => model.id === params.modelId);
  const mergedModels = hasApiModel ? existingModels : [...existingModels, apiModel];
  const { apiKey: existingApiKey, ...existingProviderRest } = existingProvider ?? {
    baseUrl: params.baseUrl,
    models: [],
  };
  const resolvedApiKey = typeof existingApiKey === "string" ? existingApiKey : undefined;
  const normalizedApiKey = resolvedApiKey?.trim() === "minimax" ? "" : resolvedApiKey;
  providers[params.providerId] = {
    ...existingProviderRest,
    baseUrl: params.baseUrl,
    api: "anthropic-messages",
    authHeader: true,
    ...(normalizedApiKey?.trim() ? { apiKey: normalizedApiKey } : {}),
    models: mergedModels.length > 0 ? mergedModels : [apiModel],
  };

  const models = { ...cfg.agents?.defaults?.models };
  const modelRef = `${params.providerId}/${params.modelId}`;
  models[modelRef] = {
    ...models[modelRef],
    alias: "Minimax",
  };

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
      },
    },
    models: { mode: cfg.models?.mode ?? "merge", providers },
  };
}

function applyMinimaxApiConfigWithBaseUrl(
  cfg: OpenClawConfig,
  params: MinimaxApiProviderConfigParams,
): OpenClawConfig {
  const next = applyMinimaxApiProviderConfigWithBaseUrl(cfg, params);
  return applyAgentDefaultModelPrimary(next, `${params.providerId}/${params.modelId}`);
}
