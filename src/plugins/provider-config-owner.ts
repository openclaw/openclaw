// Resolves provider config ownership between core and plugins.
import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import { normalizeUniqueSingleOrTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord } from "./manifest-registry.types.js";
import type { PluginManifestProviderEndpoint } from "./manifest-types.js";
import {
  matchesPluginProviderEndpoint,
  normalizePluginProviderBaseUrl,
} from "./plugin-metadata-provider-facts.js";

/** Limits implicit catalogs to endpoints declared by their provider owner. */
export function isProviderCatalogSourceAllowed(params: {
  provider: string;
  config?: OpenClawConfig;
  plugin?: Pick<PluginManifestRecord, "modelCatalog"> & {
    providerEndpoints?: readonly PluginManifestProviderEndpoint[];
  };
}): boolean {
  const configuredBaseUrl = findNormalizedProviderValue(
    params.config?.models?.providers,
    params.provider,
  )?.baseUrl;
  if (!configuredBaseUrl || !params.plugin) {
    return true;
  }
  const catalog = params.plugin.modelCatalog;
  const alias = findNormalizedProviderValue(catalog?.aliases, params.provider);
  const provider = findNormalizedProviderValue(
    catalog?.providers,
    alias?.provider ?? params.provider,
  );
  const baseUrls = [
    alias?.baseUrl,
    provider?.baseUrl,
    ...(provider?.models ?? []).map((model) => model.baseUrl),
  ].filter((baseUrl): baseUrl is string => Boolean(baseUrl));
  const endpoints = params.plugin.providerEndpoints ?? [];
  // Adapters without native declarations keep their existing discovery contract.
  // Authored rows do not pass through this implicit-source decision.
  if (baseUrls.length === 0 && endpoints.length === 0) {
    return true;
  }
  const normalizedBaseUrl = normalizePluginProviderBaseUrl(configuredBaseUrl);
  if (!normalizedBaseUrl) {
    return false;
  }
  const host = new URL(normalizedBaseUrl).hostname;
  return (
    baseUrls.some((baseUrl) => normalizePluginProviderBaseUrl(baseUrl) === normalizedBaseUrl) ||
    endpoints.some((endpoint) =>
      matchesPluginProviderEndpoint(endpoint, { host, normalizedBaseUrl }),
    )
  );
}

/** Core built-in model API ids that do not imply plugin ownership of a provider config. */
export const CORE_BUILT_IN_MODEL_APIS = new Set([
  "anthropic-messages",
  "azure-openai-responses",
  "google-generative-ai",
  "google-vertex",
  "mistral-conversations",
  "openai-chatgpt-responses",
  "openai-completions",
  "openai-responses",
]);

/** Returns the plugin API id that owns a provider config when it is not core built-in. */
export function resolveProviderConfigApiOwnerHint(params: {
  provider: string;
  config?: OpenClawConfig;
}): string | undefined {
  const providers = params.config?.models?.providers;
  if (!providers) {
    return undefined;
  }
  const normalizedProvider = normalizeProviderId(params.provider);
  if (!normalizedProvider) {
    return undefined;
  }
  const providerConfig =
    providers[params.provider] ??
    Object.entries(providers).find(
      ([candidateId]) => normalizeProviderId(candidateId) === normalizedProvider,
    )?.[1];
  const api =
    typeof providerConfig?.api === "string" ? normalizeProviderId(providerConfig.api) : "";
  if (!api || api === normalizedProvider || CORE_BUILT_IN_MODEL_APIS.has(api)) {
    return undefined;
  }
  return api;
}

function providerConfigDeclaresModel(
  providerConfig: { models?: readonly { id?: string }[] } | undefined,
  model: string,
): boolean {
  const trimmedModel = model.trim();
  return Boolean(
    trimmedModel &&
    providerConfig?.models?.some((candidate) => candidate.id?.trim() === trimmedModel),
  );
}

/** Resolves provider/model refs used to scope model catalog discovery. */
export function resolveModelCatalogScope(params: {
  cfg?: OpenClawConfig;
  provider: string;
  model: string;
}): { providerRefs: string[]; modelRefs: string[] } {
  const provider = params.provider.trim();
  const model = params.model.trim();
  const providerConfig = findNormalizedProviderValue(params.cfg?.models?.providers, provider);
  const modelRefs = providerConfigDeclaresModel(providerConfig, model)
    ? [provider && model ? `${provider}/${model}` : model]
    : [provider && model ? `${provider}/${model}` : model, model];
  // Scope ordering feeds deterministic discovery and prompt/cache inputs.
  return {
    providerRefs: normalizeUniqueSingleOrTrimmedStringList([provider, providerConfig?.api]),
    modelRefs: normalizeUniqueSingleOrTrimmedStringList(modelRefs),
  };
}
