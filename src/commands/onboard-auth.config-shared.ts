import type { OpenClawConfig } from "../config/config.js";
import type { AgentModelEntryConfig } from "../config/types.agent-defaults.js";
import type {
  ModelApi,
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "../config/types.models.js";

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
  const providers = { ...cfg.models?.providers } as Record<string, ModelProviderConfig>;
  const existingProvider = providers[params.providerId] as ModelProviderConfig | undefined;

  const existingModels: ModelDefinitionConfig[] = Array.isArray(existingProvider?.models)
    ? existingProvider.models
    : [];

  const defaultModelId = params.defaultModelId ?? params.defaultModel.id;
  const hasDefaultModel = existingModels.some((model) => model.id === defaultModelId);
  const mergedModels = hasDefaultModel ? existingModels : [...existingModels, params.defaultModel];

  const { apiKey: existingApiKey, ...existingProviderRest } = (existingProvider ?? {}) as {
    apiKey?: string;
  };

  const normalizedApiKey = typeof existingApiKey === "string" ? existingApiKey.trim() : undefined;

  providers[params.providerId] = {
    ...existingProviderRest,
    baseUrl: params.baseUrl,
    api: params.api,
    ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
    models: mergedModels.length > 0 ? mergedModels : [params.defaultModel],
  };

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
      providers,
    },
  };
}
