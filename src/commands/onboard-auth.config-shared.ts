import type { OpenClawConfig } from "../config/config.js";
import type { AgentModelEntryConfig } from "../config/types.agent-defaults.js";
import type {
  ModelApi,
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "../config/types.models.js";

function extractAgentDefaultModelFallbacks(model: unknown): string[] | undefined {
  if (!model || typeof model !== "object") {
    return undefined;
  }
  if (!("fallbacks" in model)) {
    return undefined;
  }
  const fallbacks = (model as { fallbacks?: unknown }).fallbacks;
  return Array.isArray(fallbacks) ? fallbacks.map((v) => String(v)) : undefined;
}

export function applyOnboardAuthAgentModelsAndProviders(
  cfg: OpenClawConfig,
  params: {
    agentModels: Record<string, AgentModelEntryConfig>;
    providers: Record<string, ModelProviderConfig>;
  },
): OpenClawConfig {
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models: params.agentModels,
      },
    },
    models: {
      mode: cfg.models?.mode ?? "merge",
      providers: params.providers,
    },
  };
}

export function applyAgentDefaultModelPrimary(
  cfg: OpenClawConfig,
  primary: string,
): OpenClawConfig {
  const existingFallbacks = extractAgentDefaultModelFallbacks(cfg.agents?.defaults?.model);
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        model: {
          ...(existingFallbacks ? { fallbacks: existingFallbacks } : undefined),
          primary,
        },
      },
    },
  };
}

export function applyProviderConfigWithDefaultModels(
  cfg: OpenClawConfig,
  params: {
    agentModels: Record<string, AgentModelEntryConfig>;
    providerId: string;
    api: ModelApi;
    baseUrl: string;
    defaultModels: ModelDefinitionConfig[];
    defaultModelId?: string;
  },
): OpenClawConfig {
  const providers = { ...cfg.models?.providers } as Record<string, ModelProviderConfig>;
  const existingProvider = providers[params.providerId] as ModelProviderConfig | undefined;

  const existingModels: ModelDefinitionConfig[] = Array.isArray(existingProvider?.models)
    ? existingProvider.models
    : [];

  const defaultModels = params.defaultModels;
  const defaultModelId = params.defaultModelId ?? defaultModels[0]?.id;
  const hasDefaultModel = defaultModelId
    ? existingModels.some((model) => model.id === defaultModelId)
    : true;
  const mergedModels =
    existingModels.length > 0
      ? hasDefaultModel || defaultModels.length === 0
        ? existingModels
        : [...existingModels, ...defaultModels]
      : defaultModels;

  const { apiKey: existingApiKey, ...existingProviderRest } = (existingProvider ?? {}) as {
    apiKey?: string;
  };

  const normalizedApiKey = typeof existingApiKey === "string" ? existingApiKey.trim() : undefined;

  providers[params.providerId] = {
    ...existingProviderRest,
    baseUrl: params.baseUrl,
    api: params.api,
    ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
    models: mergedModels.length > 0 ? mergedModels : defaultModels,
  };

  return applyOnboardAuthAgentModelsAndProviders(cfg, {
    agentModels: params.agentModels,
    providers,
  });
}

export function applyProviderConfigWithDefaultModel(
  cfg: OpenClawConfig,
  params: {
    agentModels: Record<string, AgentModelEntryConfig>;
    providerId: string;
    api: ModelApi;
    baseUrl: string;
    defaultModel: ModelDefinitionConfig;
    defaultModelId?: string;
  },
): OpenClawConfig {
  return applyProviderConfigWithDefaultModels(cfg, {
    agentModels: params.agentModels,
    providerId: params.providerId,
    api: params.api,
    baseUrl: params.baseUrl,
    defaultModels: [params.defaultModel],
    defaultModelId: params.defaultModelId ?? params.defaultModel.id,
  });
}

export function applyProviderConfigWithModelCatalog(
  cfg: OpenClawConfig,
  params: {
    agentModels: Record<string, AgentModelEntryConfig>;
    providerId: string;
    api: ModelApi;
    baseUrl: string;
    catalogModels: ModelDefinitionConfig[];
  },
): OpenClawConfig {
  const providers = { ...cfg.models?.providers } as Record<string, ModelProviderConfig>;
  const existingProvider = providers[params.providerId] as ModelProviderConfig | undefined;
  const existingModels: ModelDefinitionConfig[] = Array.isArray(existingProvider?.models)
    ? existingProvider.models
    : [];

  const catalogModels = params.catalogModels;
  const mergedModels =
    existingModels.length > 0
      ? [
          ...existingModels,
          ...catalogModels.filter(
            (model) => !existingModels.some((existing) => existing.id === model.id),
          ),
        ]
      : catalogModels;

  const { apiKey: existingApiKey, ...existingProviderRest } = (existingProvider ?? {}) as {
    apiKey?: string;
  };

  const normalizedApiKey = typeof existingApiKey === "string" ? existingApiKey.trim() : undefined;

  providers[params.providerId] = {
    ...existingProviderRest,
    baseUrl: params.baseUrl,
    api: params.api,
    ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
    models: mergedModels.length > 0 ? mergedModels : catalogModels,
  };

  return applyOnboardAuthAgentModelsAndProviders(cfg, {
    agentModels: params.agentModels,
    providers,
  });
}
