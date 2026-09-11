import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { stripSelfProviderModelPrefix } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import type { ProviderRouteOverridePresence } from "../plugin-sdk/provider-model-types.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "./types.models.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type MergedModelProviderEntry = {
  providerKey: string;
  providerConfig: ModelProviderConfig;
};

/** Uses the same authored row for transport materialization and early auth selection. */
export function findConfiguredProviderModel<T extends { id: string }>(
  providerConfig: { models?: readonly T[] } | undefined,
  provider: string,
  modelId: string,
  canonicalizeModelId?: (modelId: string) => string,
) {
  return createConfiguredProviderModelResolver(
    providerConfig,
    provider,
    canonicalizeModelId,
  )(modelId);
}

const BUILT_IN_MODEL_PROVIDER_OVERLAY_IDS = new Set([
  "amazon-bedrock",
  "amazon-bedrock-mantle",
  "anthropic",
  "anthropic-vertex",
  "arcee",
  "azure-openai-responses",
  "byteplus",
  "byteplus-plan",
  "cerebras",
  "chutes",
  "claude-cli",
  "clawrouter",
  "cloudflare-ai-gateway",
  "codex",
  "comfy",
  "copilot-proxy",
  "dashscope",
  "deepinfra",
  "deepseek",
  "fal",
  "fireworks",
  "github-copilot",
  "gmi",
  "gmi-cloud",
  "gmicloud",
  "google",
  "google-antigravity",
  "google-gemini-cli",
  "google-vertex",
  "groq",
  "huggingface",
  "kilocode",
  "kimi",
  "kimi-coding",
  "litellm",
  "lmstudio",
  "meta",
  "microsoft-foundry",
  "minimax",
  "minimax-portal",
  "mistral",
  "modelstudio",
  "moonshot",
  "moonshot-ai",
  "moonshotai",
  "nvidia",
  "novita",
  "novita-ai",
  "novitaai",
  "ollama",
  "ollama-cloud",
  "openai",
  "opencode",
  "opencode-go",
  "openrouter",
  "qianfan",
  "qwen",
  "qwen-token-plan",
  "qwencloud",
  "sglang",
  "stepfun",
  "stepfun-plan",
  "synthetic",
  "tencent-tokenhub",
  "tencent-tokenplan",
  "together",
  "venice",
  "vercel-ai-gateway",
  "vllm",
  "volcengine",
  "volcengine-plan",
  "vydra",
  "x-ai",
  "xai",
  "xiaomi",
  "xiaomi-token-plan",
  "z.ai",
  "z-ai",
  "zai",
]);

/** Identifies provider overlays already known to the bundled config contract. */
export function isBuiltInModelProviderOverlayId(providerId: string): boolean {
  return BUILT_IN_MODEL_PROVIDER_OVERLAY_IDS.has(normalizeProviderId(providerId));
}

/** Indexes configured model rows after caller-owned model-id normalization. */
export function resolveMergedModelProviderModels<T extends { id: string }>(params: {
  models: readonly T[] | undefined;
  normalizeModelId: (modelId: string) => string | undefined;
}): ReadonlyMap<string, T> {
  const models = new Map<string, T>();
  for (const model of params.models ?? []) {
    const modelId = params.normalizeModelId(model.id);
    if (!modelId) {
      continue;
    }
    const existing = models.get(modelId);
    // Earlier rows stay authoritative, including explicit empty objects;
    // later duplicates only supply top-level fields the first row omitted.
    models.set(modelId, existing ? { ...model, ...existing } : model);
  }
  return models;
}

function createConfiguredProviderModelResolver<T extends { id: string }>(
  providerConfig: { models?: readonly T[] } | undefined,
  provider: string,
  canonicalizeModelId?: (modelId: string) => string,
): (modelId: string) => T | undefined {
  const canonicalize = (id: string) =>
    stripSelfProviderModelPrefix(provider, id) !== id ? id : canonicalizeModelId?.(id).trim() || id;
  let configuredModels: Map<string, T> | undefined;
  return (modelId) => {
    const id = modelId.trim();
    if (!configuredModels) {
      const exactRows = resolveMergedModelProviderModels({
        models: providerConfig?.models,
        normalizeModelId: (candidate) => candidate.trim(),
      });
      configuredModels = new Map();
      for (const [candidate, row] of exactRows) {
        const canonical = canonicalize(candidate);
        if (!configuredModels.has(canonical)) {
          configuredModels.set(canonical, row);
        }
      }
      // Literal selection owns its row; equivalents never donate omitted fields.
      for (const [candidate, row] of exactRows) {
        configuredModels.set(candidate, row);
      }
    }
    const rows = configuredModels;
    const canonicalId = canonicalize(id);
    const exact = rows.get(id) ?? rows.get(canonicalId);
    if (exact) {
      return exact;
    }
    // Declared equivalents precede legacy self-provider prefixes. The selected
    // namespace itself is never stripped or merged with a legacy row.
    for (const [candidate, row] of rows) {
      const legacy = stripSelfProviderModelPrefix(provider, candidate);
      if (legacy !== candidate && (legacy === id || canonicalize(legacy.trim()) === canonicalId)) {
        return row;
      }
    }
    return undefined;
  };
}

function hasNonEmptyRecord(value: unknown): boolean {
  const record = readRecord(value);
  return record !== undefined && Object.keys(record).length > 0;
}

function hasRequestCompatOverrides(compat: ModelDefinitionConfig["compat"]): boolean {
  return Object.entries(compat ?? {}).some(([key, value]) => {
    // Native runtimes consume affirmative reasoning capabilities as turn controls.
    // Disabling reasoning, custom labels, and payload shaping still require the authored adapter.
    if (key === "supportsReasoningEffort") {
      return value !== true;
    }
    if (key === "supportedReasoningEfforts") {
      return !(
        Array.isArray(value) &&
        value.length > 0 &&
        value.every(
          (effort) =>
            typeof effort === "string" &&
            /^(minimal|low|medium|high|xhigh|max|ultra)$/u.test(effort),
        )
      );
    }
    return true;
  });
}

/** Prepares row lookups within one stable authored config view. */
export function createModelProviderRouteOverrideResolver(params: {
  provider: string;
  authoredConfig?: OpenClawConfig;
  canonicalizeModelId?: (modelId: string) => string;
}): (modelId?: string) => ProviderRouteOverridePresence {
  const providerConfig = resolveMergedModelProviderConfig(params.authoredConfig, params.provider);
  if (!providerConfig) {
    return () => "none";
  }
  if (
    readRecord(providerConfig.localService) !== undefined ||
    hasNonEmptyRecord(providerConfig.headers) ||
    hasNonEmptyRecord(providerConfig.request) ||
    hasNonEmptyRecord(providerConfig.params) ||
    typeof providerConfig.authHeader === "boolean" ||
    typeof providerConfig.timeoutSeconds === "number"
  ) {
    return () => "present";
  }
  const findModel = createConfiguredProviderModelResolver(
    providerConfig,
    params.provider,
    params.canonicalizeModelId,
  );
  return (modelId) => {
    if (!modelId) {
      return "none";
    }
    const configuredModel = findModel(modelId);
    return configuredModel &&
      (hasNonEmptyRecord(configuredModel.headers) ||
        hasNonEmptyRecord(configuredModel.params) ||
        hasRequestCompatOverrides(configuredModel.compat))
      ? "present"
      : "none";
  };
}

/** Resolves the provider entry produced by models-config key normalization. */
export function resolveMergedModelProviderEntry(
  config: OpenClawConfig | undefined,
  provider: string,
): MergedModelProviderEntry | undefined {
  const requestedProvider = provider.trim();
  const normalizedProvider = normalizeProviderId(requestedProvider);
  if (!normalizedProvider) {
    return undefined;
  }
  const providers = Object.entries(config?.models?.providers ?? {});
  // normalizeProviders trims keys but does not lowercase them. Preserve its
  // exact-key precedence, then use the existing case-insensitive fallback.
  const exactKey = providers.find(([providerId]) => providerId.trim() === requestedProvider)?.[0];
  const fallbackKey = providers.find(
    ([providerId]) => normalizeProviderId(providerId) === normalizedProvider,
  )?.[0];
  const providerKey = (exactKey ?? fallbackKey)?.trim();
  if (!providerKey) {
    return undefined;
  }
  let matched: ModelProviderConfig | undefined;
  for (const [providerId, providerConfig] of providers) {
    if (providerId.trim() !== providerKey) {
      continue;
    }
    // Match normalizeProviders: later fields win, while omitted model rows keep
    // the earlier catalog instead of erasing it from route/auth decisions.
    matched = matched
      ? {
          ...matched,
          ...providerConfig,
          models: providerConfig.models ?? matched.models,
        }
      : providerConfig;
  }
  return matched ? { providerKey, providerConfig: matched } : undefined;
}

/** Resolves only the merged provider config when its canonical key is not needed. */
export function resolveMergedModelProviderConfig(
  config: OpenClawConfig | undefined,
  provider: string,
): ModelProviderConfig | undefined {
  return resolveMergedModelProviderEntry(config, provider)?.providerConfig;
}

/** Projects a resolved request onto one transient canonical provider entry. */
export function projectModelProviderConfig(
  config: OpenClawConfig | undefined,
  providerId: string,
  overrides: Pick<ModelProviderConfig, "baseUrl"> &
    Partial<Pick<ModelProviderConfig, "api" | "auth">>,
): OpenClawConfig {
  const provider = normalizeProviderId(providerId);
  const entry = resolveMergedModelProviderEntry(config, provider);
  const providerKey = entry?.providerKey ?? provider;
  const providers = Object.fromEntries(
    Object.entries(config?.models?.providers ?? {}).filter(
      ([candidate]) => normalizeProviderId(candidate) !== provider || candidate === providerKey,
    ),
  );
  return {
    ...config,
    models: {
      ...config?.models,
      providers: {
        ...providers,
        [providerKey]: { ...(entry?.providerConfig ?? { models: [] }), ...overrides },
      },
    },
  };
}
