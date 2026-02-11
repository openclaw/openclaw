import type { ModelApi, OpenClawConfig } from "../config/types.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { ensureAuthProfileStore, resolveAuthProfileOrder } from "../agents/auth-profiles.js";
import { resolveEnvApiKey } from "../agents/model-auth.js";
import {
  formatApiKeyPreview,
  normalizeApiKeyInput,
  validateApiKeyInput,
} from "./auth-choice.api-key.js";
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
            : undefined),
          primary: DIGITALOCEAN_GRADIENT_DEFAULT_MODEL_REF,
        },
      },
    },
  };
}

export async function applyDigitalOceanGradientAuthChoice(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  let nextConfig = params.config;
  let agentModelOverride: string | undefined;
  const noteAgentModel = async (model: string) => {
    if (!params.agentId) {
      return;
    }
    await params.prompter.note(
      `Default model set to ${model} for agent "${params.agentId}".`,
      "Model configured",
    );
  };

  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const profileOrder = resolveAuthProfileOrder({
    cfg: nextConfig,
    store,
    provider: "digitalocean",
  });
  const existingProfileId = profileOrder.find((profileId) => Boolean(store.profiles[profileId]));
  const existingCred = existingProfileId ? store.profiles[existingProfileId] : undefined;
  let profileId = "digitalocean:default";
  let mode: "api_key" | "oauth" | "token" = "api_key";
  let hasCredential = false;

  if (existingProfileId && existingCred?.type) {
    profileId = existingProfileId;
    mode =
      existingCred.type === "oauth" ? "oauth" : existingCred.type === "token" ? "token" : "api_key";
    hasCredential = true;
  }

  if (!hasCredential && params.opts?.token && params.opts?.tokenProvider === "digitalocean") {
    setDigitalOceanGradientApiKey(normalizeApiKeyInput(params.opts.token), params.agentDir);
    hasCredential = true;
  }

  if (!hasCredential) {
    const envKey = resolveEnvApiKey("digitalocean");
    if (envKey) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing DIGITALOCEAN_API_KEY from environment? ${formatApiKeyPreview(envKey.apiKey)}`,
        initialValue: true,
      });
      if (useExisting) {
        setDigitalOceanGradientApiKey(envKey.apiKey, params.agentDir);
        hasCredential = true;
      }
    }
  }

  if (!hasCredential) {
    const apiKey = await params.prompter.text({
      message: "Enter DigitalOcean Gradient API key",
      validate: validateApiKeyInput,
    });
    if (!apiKey || !apiKey.trim()) {
      return { config: nextConfig };
    }
    setDigitalOceanGradientApiKey(normalizeApiKeyInput(apiKey), params.agentDir);
  }

  nextConfig = applyDigitalOceanGradientProviderConfig(nextConfig);
  nextConfig = applyAuthProfileConfig(nextConfig, { profileId, provider: "digitalocean", mode });

  if (params.setDefaultModel) {
    nextConfig = applyDigitalOceanGradientConfig(nextConfig);
    agentModelOverride = DIGITALOCEAN_GRADIENT_DEFAULT_MODEL_REF;
    await noteAgentModel(DIGITALOCEAN_GRADIENT_DEFAULT_MODEL_REF);
  } else {
    nextConfig = await applyDefaultModelChoice({
      config: nextConfig,
      setDefaultModel: false,
      defaultModel: DIGITALOCEAN_GRADIENT_DEFAULT_MODEL_REF,
      applyDefaultConfig: applyDigitalOceanGradientConfig,
      applyProviderConfig: applyDigitalOceanGradientProviderConfig,
      noteDefault: DIGITALOCEAN_GRADIENT_DEFAULT_MODEL_REF,
      noteAgentModel,
      prompter: params.prompter,
    }).then((applied) => applied.config);
  }

  return { config: nextConfig, agentModelOverride };
}
