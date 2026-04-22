import {
  fetchLmstudioModels,
  LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
  LMSTUDIO_DEFAULT_INFERENCE_BASE_URL,
  mapLmstudioWireEntry,
  resolveLmstudioInferenceBase,
  resolveLmstudioRequestContext,
} from "../../../extensions/lmstudio/runtime-api.js";
import {
  buildOllamaModelDefinition,
  OLLAMA_DEFAULT_BASE_URL,
  queryOllamaModelShowInfo,
} from "../../../extensions/ollama/api.js";
import {
  buildConfiguredAllowlistKeys,
  normalizeProviderId,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import {
  SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
  SELF_HOSTED_DEFAULT_COST,
  SELF_HOSTED_DEFAULT_MAX_TOKENS,
} from "../../agents/self-hosted-provider-defaults.js";
import {
  readConfigFileSnapshot,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../../config/config.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";

export type ModelAddAdapter = {
  providerId: string;
  bootstrapProviderConfig?: (cfg: OpenClawConfig) => ModelProviderConfig | null;
  detect?: (params: {
    cfg: OpenClawConfig;
    providerConfig: ModelProviderConfig;
    modelId: string;
  }) => Promise<{
    found: boolean;
    model?: ModelDefinitionConfig;
    warnings?: string[];
  }>;
};

type AddModelOutcome = {
  provider: string;
  modelId: string;
  existed: boolean;
  allowlistAdded: boolean;
  warnings: string[];
};

function buildDefaultModelDefinition(modelId: string): ModelDefinitionConfig {
  return {
    id: modelId,
    name: modelId,
    reasoning: false,
    input: ["text"],
    cost: SELF_HOSTED_DEFAULT_COST,
    contextWindow: SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
    maxTokens: SELF_HOSTED_DEFAULT_MAX_TOKENS,
  };
}

function resolveConfiguredProvider(
  cfg: OpenClawConfig,
  providerId: string,
): ModelProviderConfig | undefined {
  return cfg.models?.providers?.[providerId];
}

function buildDefaultLmstudioProviderConfig(): ModelProviderConfig {
  return {
    baseUrl: resolveLmstudioInferenceBase(LMSTUDIO_DEFAULT_INFERENCE_BASE_URL),
    api: "openai-completions",
    auth: "api-key",
    apiKey: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
    models: [],
  };
}

const MODEL_ADD_ADAPTERS: Record<string, ModelAddAdapter> = {
  ollama: {
    providerId: "ollama",
    bootstrapProviderConfig: () => ({
      baseUrl: OLLAMA_DEFAULT_BASE_URL,
      api: "ollama",
      apiKey: "ollama-local",
      models: [],
    }),
    detect: async ({ providerConfig, modelId }) => {
      const info = (await queryOllamaModelShowInfo(providerConfig.baseUrl, modelId)) ?? {};
      return {
        found: typeof info.contextWindow === "number" || (info.capabilities?.length ?? 0) > 0,
        model: buildOllamaModelDefinition(modelId, info.contextWindow, info.capabilities),
      };
    },
  },
  lmstudio: {
    providerId: "lmstudio",
    bootstrapProviderConfig: () => buildDefaultLmstudioProviderConfig(),
    detect: async ({ cfg, providerConfig, modelId }) => {
      try {
        const { apiKey, headers } = await resolveLmstudioRequestContext({
          config: {
            ...cfg,
            models: {
              ...cfg.models,
              providers: {
                ...cfg.models?.providers,
                lmstudio: providerConfig,
              },
            },
          },
          env: process.env,
          providerHeaders: providerConfig.headers,
        });
        const fetched = await fetchLmstudioModels({
          baseUrl: providerConfig.baseUrl,
          apiKey,
          headers,
        });
        const match = fetched.models.find(
          (entry) => normalizeOptionalString(entry.key) === modelId,
        );
        const base = match ? mapLmstudioWireEntry(match) : null;
        if (!base) {
          return { found: false };
        }
        return {
          found: true,
          model: {
            id: base.id,
            name: base.displayName,
            reasoning: base.reasoning,
            input: base.input,
            cost: base.cost,
            contextWindow: base.contextWindow,
            contextTokens: base.contextTokens,
            maxTokens: base.maxTokens,
          },
        };
      } catch (error) {
        return {
          found: false,
          warnings: [`LM Studio metadata detection failed; using defaults (${String(error)})`],
        };
      }
    },
  },
};

function canAddProvider(params: { cfg: OpenClawConfig; provider: string }): boolean {
  const provider = normalizeProviderId(params.provider);
  if (!provider) {
    return false;
  }
  if (resolveConfiguredProvider(params.cfg, provider)) {
    return true;
  }
  return !!MODEL_ADD_ADAPTERS[provider]?.bootstrapProviderConfig?.(params.cfg);
}

export function listAddableProviders(params: {
  cfg: OpenClawConfig;
  discoveredProviders?: readonly string[];
}): string[] {
  const providers = new Set<string>();
  for (const provider of params.discoveredProviders ?? []) {
    const normalized = normalizeProviderId(provider);
    if (normalized && canAddProvider({ cfg: params.cfg, provider: normalized })) {
      providers.add(normalized);
    }
  }
  for (const provider of Object.keys(params.cfg.models?.providers ?? {})) {
    const normalized = normalizeProviderId(provider);
    if (normalized) {
      providers.add(normalized);
    }
  }
  for (const provider of Object.keys(MODEL_ADD_ADAPTERS)) {
    providers.add(provider);
  }
  return [...providers].toSorted();
}

export function validateAddProvider(params: {
  cfg: OpenClawConfig;
  provider: string;
  discoveredProviders?: readonly string[];
}): { ok: true; provider: string } | { ok: false; providers: string[] } {
  const provider = normalizeProviderId(params.provider);
  const providers = listAddableProviders({
    cfg: params.cfg,
    discoveredProviders: params.discoveredProviders,
  });
  if (!provider || !providers.includes(provider)) {
    return { ok: false, providers };
  }
  return { ok: true, provider };
}

function ensureProviderConfig(params: {
  cfg: OpenClawConfig;
  provider: string;
}): { ok: true; providerConfig: ModelProviderConfig; bootstrapped: boolean } | { ok: false } {
  const providerConfig = resolveConfiguredProvider(params.cfg, params.provider);
  if (providerConfig) {
    return { ok: true, providerConfig, bootstrapped: false };
  }
  const bootstrapped = MODEL_ADD_ADAPTERS[params.provider]?.bootstrapProviderConfig?.(params.cfg);
  if (!bootstrapped) {
    return { ok: false };
  }
  return { ok: true, providerConfig: bootstrapped, bootstrapped: true };
}

async function detectModelDefinition(params: {
  cfg: OpenClawConfig;
  provider: string;
  providerConfig: ModelProviderConfig;
  modelId: string;
}): Promise<{ model: ModelDefinitionConfig; warnings: string[] }> {
  const adapter = MODEL_ADD_ADAPTERS[params.provider];
  if (!adapter?.detect) {
    return {
      model: buildDefaultModelDefinition(params.modelId),
      warnings: ["Model metadata could not be auto-detected; saved with default capabilities."],
    };
  }
  const detected = await adapter.detect(params);
  if (detected.found && detected.model) {
    return {
      model: detected.model,
      warnings: detected.warnings ?? [],
    };
  }
  return {
    model: buildDefaultModelDefinition(params.modelId),
    warnings: [
      ...(detected.warnings ?? []),
      "Model metadata could not be auto-detected; saved with default capabilities.",
    ],
  };
}

export async function detectProviderModelDefinition(params: {
  cfg: OpenClawConfig;
  provider: string;
  modelId: string;
}): Promise<{
  supported: boolean;
  found: boolean;
  model?: ModelDefinitionConfig;
  warnings: string[];
}> {
  const provider = normalizeProviderId(params.provider);
  const modelId = normalizeOptionalString(params.modelId) ?? "";
  if (!provider || !modelId) {
    return { supported: false, found: false, warnings: [] };
  }
  const adapter = MODEL_ADD_ADAPTERS[provider];
  if (!adapter?.detect) {
    return { supported: false, found: false, warnings: [] };
  }
  const providerResolution = ensureProviderConfig({
    cfg: params.cfg,
    provider,
  });
  if (!providerResolution.ok) {
    return { supported: true, found: false, warnings: [] };
  }
  const detected = await adapter.detect({
    cfg: params.cfg,
    providerConfig: providerResolution.providerConfig,
    modelId,
  });
  return {
    supported: true,
    found: detected.found && !!detected.model,
    model: detected.model,
    warnings: detected.warnings ?? [],
  };
}

function upsertModelEntry(params: {
  cfg: OpenClawConfig;
  provider: string;
  providerConfig: ModelProviderConfig;
  model: ModelDefinitionConfig;
}): { nextConfig: OpenClawConfig; existed: boolean } {
  const nextConfig = structuredClone(params.cfg);
  nextConfig.models ??= {};
  nextConfig.models.providers ??= {};
  const existingProvider = nextConfig.models.providers[params.provider];
  const providerConfig = existingProvider
    ? {
        ...existingProvider,
        models: Array.isArray(existingProvider.models) ? [...existingProvider.models] : [],
      }
    : {
        ...params.providerConfig,
        models: Array.isArray(params.providerConfig.models)
          ? [...params.providerConfig.models]
          : [],
      };
  const modelKey = normalizeLowercaseStringOrEmpty(params.model.id);
  const existingIndex = providerConfig.models.findIndex(
    (entry) => normalizeLowercaseStringOrEmpty(entry?.id) === modelKey,
  );
  const existed = existingIndex !== -1;
  if (!existed) {
    providerConfig.models.push(params.model);
  }
  nextConfig.models.providers[params.provider] = providerConfig;
  return { nextConfig, existed };
}

function maybeAddAllowlistEntry(params: {
  cfg: OpenClawConfig;
  provider: string;
  modelId: string;
}): { nextConfig: OpenClawConfig; added: boolean } {
  const allowlistKeys = buildConfiguredAllowlistKeys({
    cfg: params.cfg,
    defaultProvider: resolveDefaultModelForAgent({ cfg: params.cfg }).provider,
  });
  if (!allowlistKeys || allowlistKeys.size === 0) {
    return { nextConfig: params.cfg, added: false };
  }
  const rawRef = `${params.provider}/${params.modelId}`;
  const resolved = resolveModelRefFromString({
    raw: rawRef,
    defaultProvider: resolveDefaultModelForAgent({ cfg: params.cfg }).provider,
  });
  if (!resolved) {
    return { nextConfig: params.cfg, added: false };
  }
  const normalizedKey = `${resolved.ref.provider}/${resolved.ref.model}`.toLowerCase();
  if (allowlistKeys.has(normalizedKey)) {
    return { nextConfig: params.cfg, added: false };
  }
  const nextConfig = structuredClone(params.cfg);
  nextConfig.agents ??= {};
  nextConfig.agents.defaults ??= {};
  nextConfig.agents.defaults.models ??= {};
  nextConfig.agents.defaults.models[`${params.provider}/${params.modelId}`] = {};
  return { nextConfig, added: true };
}

export async function addModelToConfig(params: {
  cfg: OpenClawConfig;
  provider: string;
  modelId: string;
}): Promise<{ ok: true; result: AddModelOutcome } | { ok: false; error: string }> {
  const provider = normalizeProviderId(params.provider);
  const modelId = normalizeOptionalString(params.modelId) ?? "";
  if (!provider || !modelId) {
    return { ok: false, error: "Provider and model id are required." };
  }

  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid || !snapshot.parsed || typeof snapshot.parsed !== "object") {
    return { ok: false, error: "Config file is invalid; fix it before using /models add." };
  }

  const currentConfig = structuredClone(snapshot.parsed as OpenClawConfig);
  const providerResolution = ensureProviderConfig({
    cfg: currentConfig,
    provider,
  });
  if (!providerResolution.ok) {
    return {
      ok: false,
      error: `Provider "${provider}" is not configured for custom models yet. Configure the provider first, then retry /models add.`,
    };
  }

  const detected = await detectModelDefinition({
    cfg: currentConfig,
    provider,
    providerConfig: providerResolution.providerConfig,
    modelId,
  });
  const upserted = upsertModelEntry({
    cfg: currentConfig,
    provider,
    providerConfig: providerResolution.providerConfig,
    model: detected.model,
  });
  const allowlisted = maybeAddAllowlistEntry({
    cfg: upserted.nextConfig,
    provider,
    modelId,
  });

  const changed = !upserted.existed || allowlisted.added || providerResolution.bootstrapped;
  if (!changed) {
    return {
      ok: true,
      result: {
        provider,
        modelId,
        existed: true,
        allowlistAdded: false,
        warnings: detected.warnings,
      },
    };
  }

  const validated = validateConfigObjectWithPlugins(allowlisted.nextConfig);
  if (!validated.ok) {
    const issue = validated.issues[0];
    return {
      ok: false,
      error: `Config invalid after /models add (${issue.path}: ${issue.message}).`,
    };
  }

  await writeConfigFile(validated.config);
  return {
    ok: true,
    result: {
      provider,
      modelId,
      existed: upserted.existed,
      allowlistAdded: allowlisted.added,
      warnings: detected.warnings,
    },
  };
}
