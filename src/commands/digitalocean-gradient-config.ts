import { ensureAuthProfileStore, resolveAuthProfileOrder } from "../agents/auth-profiles.js";
import { resolveEnvApiKey } from "../agents/model-auth.js";
import type { ModelApi, OpenClawConfig } from "../config/types.js";
import {
  formatApiKeyPreview,
  normalizeApiKeyInput,
  validateApiKeyInput,
} from "./auth-choice.api-key.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyDefaultModelChoice } from "./auth-choice.default-model.js";
import { applyAuthProfileConfig } from "./onboard-auth.config-core.js";
import { setDigitalOceanGradientApiKey } from "./onboard-auth.credentials.js";
import {
  DIGITALOCEAN_GRADIENT_BASE_URL,
  DIGITALOCEAN_GRADIENT_DEFAULT_MODEL_REF,
  buildDigitalOceanGradientModels,
} from "./onboard-auth.models.js";

export function applyDigitalOceanGradientProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  const modelRef = DIGITALOCEAN_GRADIENT_DEFAULT_MODEL_REF;
  models[modelRef] = {
    ...models[modelRef],
    alias: models[modelRef]?.alias ?? "DigitalOcean Gradient",
  };

  const providers = { ...cfg.models?.providers };
  const existingProvider = providers.digitalocean;
  const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
  const defaultModels = buildDigitalOceanGradientModels();

  // Merge existing models with default models, avoiding duplicates
  const existingModelIds = new Set(existingModels.map((m) => m.id));
  const newModels = defaultModels.filter((m) => !existingModelIds.has(m.id));
  const mergedModels =
    existingModels.length > 0 ? [...existingModels, ...newModels] : defaultModels;

  const { apiKey: existingApiKey, ...existingProviderRest } = (existingProvider ?? {}) as Record<
    string,
    unknown
  > as { apiKey?: string };
  const resolvedApiKey = typeof existingApiKey === "string" ? existingApiKey : undefined;
  const normalizedApiKey = resolvedApiKey?.trim();
  providers.digitalocean = {
    ...existingProviderRest,
    baseUrl: DIGITALOCEAN_GRADIENT_BASE_URL,
    api: "openai-completions" as ModelApi,
    ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
    models: mergedModels,
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
    models: {
      mode: cfg.models?.mode ?? "merge",
      providers,
    },
  };
}

export function applyDigitalOceanGradientConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = applyDigitalOceanGradientProviderConfig(cfg);
  const existingModel = next.agents?.defaults?.model;
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        model: {
          ...(existingModel && "fallbacks" in (existingModel as Record<string, unknown>)
            ? {
                fallbacks: (existingModel as { fallbacks?: string[] }).fallbacks,
              }
            : {}),
          primary: DIGITALOCEAN_GRADIENT_DEFAULT_MODEL_REF,
        },
      },
    },
  };
}

export async function applyDigitalOceanGradientAuthChoice(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult> {
  let nextConfig = params.config;
  let hasCredential = false;

  if (!hasCredential && params.opts?.token && params.opts?.tokenProvider === "digitalocean") {
    setDigitalOceanGradientApiKey(normalizeApiKeyInput(params.opts.token), params.agentDir);
    hasCredential = true;
  }

  if (!hasCredential) {
    const store = ensureAuthProfileStore();
    const profiles = resolveAuthProfileOrder({
      provider: "digitalocean",
      store,
      preferredProfileId: params.config.agents?.defaults?.authProfile?.profileId,
    });
    if (profiles.length > 0) {
      const profileId = profiles[0];
      nextConfig = applyAuthProfileConfig(nextConfig, {
        profileId,
        provider: "digitalocean",
        mode: "api_key",
      });
      hasCredential = true;
    }
  }

  if (!hasCredential) {
    await params.prompter.note(
      "Get your API key at: https://cloud.digitalocean.com/account/api/tokens",
      "DigitalOcean Gradient AI",
    );
  }

  const envKey = resolveEnvApiKey("digitalocean");
  if (envKey) {
    const useExisting = await params.prompter.confirm({
      message: `Use existing DIGITALOCEAN_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
      initialValue: true,
    });
    if (useExisting) {
      setDigitalOceanGradientApiKey(envKey.apiKey, params.agentDir);
      hasCredential = true;
    }
  }

  if (!hasCredential) {
    const key = await params.prompter.text({
      message: "Enter DigitalOcean API key",
      validate: validateApiKeyInput,
    });
    setDigitalOceanGradientApiKey(normalizeApiKeyInput(String(key ?? "")), params.agentDir);
  }

  nextConfig = applyAuthProfileConfig(nextConfig, {
    profileId: "digitalocean:default",
    provider: "digitalocean",
    mode: "api_key",
  });

  const applied = await applyDefaultModelChoice({
    config: nextConfig,
    setDefaultModel: params.setDefaultModel,
    defaultModel: DIGITALOCEAN_GRADIENT_DEFAULT_MODEL_REF,
    applyDefaultConfig: applyDigitalOceanGradientConfig,
    applyProviderConfig: applyDigitalOceanGradientProviderConfig,
    noteDefault: DIGITALOCEAN_GRADIENT_DEFAULT_MODEL_REF,
    noteAgentModel: async (model: string) => {
      if (!params.agentId) {
        return;
      }
      await params.prompter.note(
        `Default model set to ${model} for agent "${params.agentId}".`,
        "Model configured",
      );
    },
    prompter: params.prompter,
  });

  return {
    config: applied.config,
    agentModelOverride: applied.agentModelOverride,
  };
}
