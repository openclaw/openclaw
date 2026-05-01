import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  selectApplicableRuntimeConfig,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logVerbose } from "../globals.js";
import type {
  PluginWebSearchProviderEntry,
  WebSearchProviderToolDefinition,
} from "../plugins/types.js";
import {
  resolvePluginWebSearchProviders,
  resolveRuntimeWebSearchProviders,
} from "../plugins/web-search-providers.runtime.js";
import { sortWebSearchProvidersForAutoDetect } from "../plugins/web-search-providers.shared.js";
import { getActiveRuntimeWebToolsMetadata } from "../secrets/runtime-web-tools-state.js";
import type { RuntimeWebSearchMetadata } from "../secrets/runtime-web-tools.types.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";
import {
  hasWebProviderEntryCredential,
  providerRequiresCredential,
  readWebProviderEnvValue,
  resolveWebProviderConfig,
  resolveWebProviderDefinition,
} from "../web/provider-runtime-shared.js";
import type {
  ResolveWebSearchDefinitionParams,
  RunWebSearchParams,
  RunWebSearchResult,
  RuntimeWebSearchConfig as WebSearchConfig,
} from "./runtime-types.js";

export type {
  ListWebSearchProvidersParams,
  ResolveWebSearchDefinitionParams,
  RunWebSearchParams,
  RunWebSearchResult,
  RuntimeWebSearchConfig,
  RuntimeWebSearchProviderEntry,
  RuntimeWebSearchToolDefinition,
} from "./runtime-types.js";

type ResolvedWebSearchDefinition = {
  provider: PluginWebSearchProviderEntry;
  definition: WebSearchProviderToolDefinition;
};

let preparedWebSearchDefinitionsByConfig = new WeakMap<
  OpenClawConfig,
  Map<string, ResolvedWebSearchDefinition>
>();
const preparedWebSearchDefinitionsWithoutConfig = new Map<string, ResolvedWebSearchDefinition>();

function resolveSearchConfig(cfg?: OpenClawConfig): WebSearchConfig {
  return resolveWebProviderConfig(cfg, "search") as NonNullable<WebSearchConfig> | undefined;
}

function resolveWebSearchRuntimeConfig(config?: OpenClawConfig): OpenClawConfig | undefined {
  return selectApplicableRuntimeConfig({
    inputConfig: config,
    runtimeConfig: getRuntimeConfigSnapshot(),
    runtimeSourceConfig: getRuntimeConfigSourceSnapshot(),
  });
}

export function resolveWebSearchEnabled(params: {
  search?: WebSearchConfig;
  sandboxed?: boolean;
}): boolean {
  if (typeof params.search?.enabled === "boolean") {
    return params.search.enabled;
  }
  if (params.sandboxed) {
    return true;
  }
  return true;
}

function hasEntryCredential(
  provider: Pick<
    PluginWebSearchProviderEntry,
    | "credentialPath"
    | "id"
    | "envVars"
    | "getConfiguredCredentialValue"
    | "getCredentialValue"
    | "requiresCredential"
  >,
  config: OpenClawConfig | undefined,
  search: WebSearchConfig | undefined,
): boolean {
  return hasWebProviderEntryCredential({
    provider,
    config,
    toolConfig: search as Record<string, unknown> | undefined,
    resolveRawValue: ({ provider: currentProvider, config: currentConfig }) =>
      currentProvider.getConfiguredCredentialValue?.(currentConfig),
    resolveEnvValue: ({ provider: currentProvider, configuredEnvVarId }) =>
      (configuredEnvVarId ? readWebProviderEnvValue([configuredEnvVarId]) : undefined) ??
      readWebProviderEnvValue(currentProvider.envVars),
  });
}

export function isWebSearchProviderConfigured(params: {
  provider: Pick<
    PluginWebSearchProviderEntry,
    | "credentialPath"
    | "id"
    | "envVars"
    | "getConfiguredCredentialValue"
    | "getCredentialValue"
    | "requiresCredential"
  >;
  config?: OpenClawConfig;
}): boolean {
  const config = resolveWebSearchRuntimeConfig(params.config);
  return hasEntryCredential(params.provider, config, resolveSearchConfig(config));
}

export function listWebSearchProviders(params?: {
  config?: OpenClawConfig;
}): PluginWebSearchProviderEntry[] {
  const config = resolveWebSearchRuntimeConfig(params?.config);
  return resolveRuntimeWebSearchProviders({
    config,
    bundledAllowlistCompat: true,
  });
}

export function listConfiguredWebSearchProviders(params?: {
  config?: OpenClawConfig;
}): PluginWebSearchProviderEntry[] {
  const config = resolveWebSearchRuntimeConfig(params?.config);
  return resolvePluginWebSearchProviders({
    config,
    bundledAllowlistCompat: true,
  });
}

export function resolveWebSearchProviderId(params: {
  search?: WebSearchConfig;
  config?: OpenClawConfig;
  providers?: PluginWebSearchProviderEntry[];
}): string {
  const config = resolveWebSearchRuntimeConfig(params.config);
  const search = params.search ?? resolveSearchConfig(config);
  const providers = sortWebSearchProvidersForAutoDetect(
    params.providers ??
      resolvePluginWebSearchProviders({
        config,
        bundledAllowlistCompat: true,
        origin: "bundled",
      }),
  );
  const raw =
    search && "provider" in search ? normalizeLowercaseStringOrEmpty(search.provider) : "";

  if (raw) {
    const explicit = providers.find((provider) => provider.id === raw);
    if (explicit) {
      return explicit.id;
    }
  }

  if (!raw) {
    let keylessFallbackProviderId = "";
    for (const provider of providers) {
      if (!providerRequiresCredential(provider)) {
        keylessFallbackProviderId ||= provider.id;
        continue;
      }
      if (!hasEntryCredential(provider, config, search)) {
        continue;
      }
      logVerbose(
        `web_search: no provider configured, auto-detected "${provider.id}" from available API keys`,
      );
      return provider.id;
    }
    if (keylessFallbackProviderId) {
      logVerbose(
        `web_search: no provider configured and no credentials found, falling back to keyless provider "${keylessFallbackProviderId}"`,
      );
      return keylessFallbackProviderId;
    }
  }

  return providers[0]?.id ?? "";
}

function getPreparedWebSearchDefinitionCache(
  config: OpenClawConfig | undefined,
): Map<string, ResolvedWebSearchDefinition> {
  if (!config) {
    return preparedWebSearchDefinitionsWithoutConfig;
  }
  let cache = preparedWebSearchDefinitionsByConfig.get(config);
  if (!cache) {
    cache = new Map<string, ResolvedWebSearchDefinition>();
    preparedWebSearchDefinitionsByConfig.set(config, cache);
  }
  return cache;
}

function createPreparedWebSearchDefinitionCacheKey(params: {
  providerId?: string;
  sandboxed?: boolean;
  preferRuntimeProviders?: boolean;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
}): string {
  return JSON.stringify({
    providerId: normalizeLowercaseStringOrEmpty(params.providerId),
    sandboxed: params.sandboxed === true,
    preferRuntimeProviders: params.preferRuntimeProviders === true,
    runtimeSelectedProvider: normalizeLowercaseStringOrEmpty(
      params.runtimeWebSearch?.selectedProvider,
    ),
    runtimeProviderConfigured: normalizeLowercaseStringOrEmpty(
      params.runtimeWebSearch?.providerConfigured,
    ),
    runtimeProviderSource: params.runtimeWebSearch?.providerSource ?? "",
    runtimeSelectedProviderKeySource: params.runtimeWebSearch?.selectedProviderKeySource ?? "",
    runtimePerplexityTransport: params.runtimeWebSearch?.perplexityTransport ?? "",
  });
}

function readPreparedWebSearchDefinition(params: {
  config?: OpenClawConfig;
  providerId?: string;
  sandboxed?: boolean;
  preferRuntimeProviders?: boolean;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
}): ResolvedWebSearchDefinition | undefined {
  return getPreparedWebSearchDefinitionCache(params.config).get(
    createPreparedWebSearchDefinitionCacheKey(params),
  );
}

function storePreparedWebSearchDefinition(params: {
  config?: OpenClawConfig;
  providerId?: string;
  sandboxed?: boolean;
  preferRuntimeProviders?: boolean;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
  resolved: ResolvedWebSearchDefinition;
}): ResolvedWebSearchDefinition {
  const cache = getPreparedWebSearchDefinitionCache(params.config);
  cache.set(createPreparedWebSearchDefinitionCacheKey(params), params.resolved);
  return params.resolved;
}

function resolveWebSearchDefinitionUncached(params: {
  config?: OpenClawConfig;
  providerId?: string;
  sandboxed?: boolean;
  preferRuntimeProviders?: boolean;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
}): ResolvedWebSearchDefinition | null {
  const search = resolveSearchConfig(params.config);
  const providers = sortWebSearchProvidersForAutoDetect(
    params.preferRuntimeProviders
      ? resolveRuntimeWebSearchProviders({
          config: params.config,
          bundledAllowlistCompat: true,
        })
      : resolvePluginWebSearchProviders({
          config: params.config,
          bundledAllowlistCompat: true,
          origin: "bundled",
        }),
  );
  return resolveWebProviderDefinition({
    config: params.config,
    toolConfig: search as Record<string, unknown> | undefined,
    runtimeMetadata: params.runtimeWebSearch,
    sandboxed: params.sandboxed,
    providerId: params.providerId,
    providers,
    resolveEnabled: ({ toolConfig, sandboxed }) =>
      resolveWebSearchEnabled({
        search: toolConfig as WebSearchConfig | undefined,
        sandboxed,
      }),
    resolveAutoProviderId: ({ config, toolConfig, providers }) =>
      resolveWebSearchProviderId({
        config,
        search: toolConfig as WebSearchConfig | undefined,
        providers,
      }),
    resolveFallbackProviderId: ({ config, toolConfig, providers }) =>
      resolveWebSearchProviderId({
        config,
        search: toolConfig as WebSearchConfig | undefined,
        providers,
      }) || providers[0]?.id,
    createTool: ({ provider, config, toolConfig, runtimeMetadata }) =>
      provider.createTool({
        config,
        searchConfig: toolConfig,
        runtimeMetadata,
      }),
  });
}

export function prepareWebSearchDefinition(
  options?: ResolveWebSearchDefinitionParams,
): ResolvedWebSearchDefinition | null {
  const config = resolveWebSearchRuntimeConfig(options?.config);
  const runtimeWebSearch = options?.runtimeWebSearch ?? getActiveRuntimeWebToolsMetadata()?.search;
  const prepared = readPreparedWebSearchDefinition({
    config,
    providerId: options?.providerId,
    sandboxed: options?.sandboxed,
    preferRuntimeProviders: options?.preferRuntimeProviders,
    runtimeWebSearch,
  });
  if (prepared) {
    return prepared;
  }
  const resolved = resolveWebSearchDefinitionUncached({
    config,
    providerId: options?.providerId,
    sandboxed: options?.sandboxed,
    preferRuntimeProviders: options?.preferRuntimeProviders,
    runtimeWebSearch,
  });
  if (!resolved) {
    return null;
  }
  return storePreparedWebSearchDefinition({
    config,
    providerId: options?.providerId,
    sandboxed: options?.sandboxed,
    preferRuntimeProviders: options?.preferRuntimeProviders,
    runtimeWebSearch,
    resolved,
  });
}

export function resolveWebSearchDefinition(
  options?: ResolveWebSearchDefinitionParams,
): ResolvedWebSearchDefinition | null {
  const config = resolveWebSearchRuntimeConfig(options?.config);
  const runtimeWebSearch = options?.runtimeWebSearch ?? getActiveRuntimeWebToolsMetadata()?.search;
  return (
    readPreparedWebSearchDefinition({
      config,
      providerId: options?.providerId,
      sandboxed: options?.sandboxed,
      preferRuntimeProviders: options?.preferRuntimeProviders,
      runtimeWebSearch,
    }) ??
    resolveWebSearchDefinitionUncached({
      config,
      providerId: options?.providerId,
      sandboxed: options?.sandboxed,
      preferRuntimeProviders: options?.preferRuntimeProviders,
      runtimeWebSearch,
    })
  );
}

function resolveWebSearchCandidates(
  options?: ResolveWebSearchDefinitionParams,
): PluginWebSearchProviderEntry[] {
  const config = resolveWebSearchRuntimeConfig(options?.config);
  const search = resolveSearchConfig(config);
  const runtimeWebSearch = options?.runtimeWebSearch ?? getActiveRuntimeWebToolsMetadata()?.search;
  if (!resolveWebSearchEnabled({ search, sandboxed: options?.sandboxed })) {
    return [];
  }

  const providers = sortWebSearchProvidersForAutoDetect(
    options?.preferRuntimeProviders
      ? resolveRuntimeWebSearchProviders({
          config,
          bundledAllowlistCompat: true,
        })
      : resolvePluginWebSearchProviders({
          config,
          bundledAllowlistCompat: true,
          origin: "bundled",
        }),
  ).filter(Boolean);
  if (providers.length === 0) {
    return [];
  }

  const preferredIds = [
    options?.providerId,
    runtimeWebSearch?.selectedProvider,
    runtimeWebSearch?.providerConfigured,
    resolveWebSearchProviderId({ config, search, providers }),
  ].filter(
    (value, index, array): value is string => Boolean(value) && array.indexOf(value) === index,
  );

  const explicitProviderId = options?.providerId?.trim();
  if (explicitProviderId && !providers.some((entry) => entry.id === explicitProviderId)) {
    throw new Error(`Unknown web_search provider "${explicitProviderId}".`);
  }

  const orderedProviders = [
    ...preferredIds
      .map((id) => providers.find((entry) => entry.id === id))
      .filter((entry): entry is PluginWebSearchProviderEntry => Boolean(entry)),
    ...providers.filter((entry) => !preferredIds.includes(entry.id)),
  ];
  return orderedProviders;
}

function hasExplicitWebSearchSelection(params: {
  search?: WebSearchConfig;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
  providerId?: string;
  providers?: PluginWebSearchProviderEntry[];
}): boolean {
  if (params.providerId?.trim()) {
    return true;
  }
  const availableProviderIds = new Set(
    (params.providers ?? []).map((provider) => normalizeLowercaseStringOrEmpty(provider.id)),
  );
  const configuredProviderId =
    params.search && "provider" in params.search && typeof params.search.provider === "string"
      ? normalizeLowercaseStringOrEmpty(params.search.provider)
      : "";
  if (configuredProviderId && availableProviderIds.has(configuredProviderId)) {
    return true;
  }
  const runtimeConfiguredId = normalizeOptionalLowercaseString(
    params.runtimeWebSearch?.selectedProvider ?? params.runtimeWebSearch?.providerConfigured,
  );
  if (
    params.runtimeWebSearch?.providerSource === "configured" &&
    runtimeConfiguredId &&
    availableProviderIds.has(runtimeConfiguredId)
  ) {
    return true;
  }
  return false;
}

function isStructuredAvailabilityError(result: unknown): result is { error: string } {
  if (!result || typeof result !== "object" || !("error" in result)) {
    return false;
  }
  const error = (result as { error?: unknown }).error;
  return typeof error === "string" && /^missing_[a-z0-9_]*api_key$/i.test(error);
}

export async function runWebSearch(params: RunWebSearchParams): Promise<RunWebSearchResult> {
  const config = resolveWebSearchRuntimeConfig(params.config);
  const search = resolveSearchConfig(config);
  const runtimeWebSearch = params.runtimeWebSearch ?? getActiveRuntimeWebToolsMetadata()?.search;
  const candidates = resolveWebSearchCandidates({
    ...params,
    config,
    runtimeWebSearch,
    preferRuntimeProviders: params.preferRuntimeProviders ?? true,
  });
  if (candidates.length === 0) {
    throw new Error("web_search is disabled or no provider is available.");
  }
  const allowFallback = !hasExplicitWebSearchSelection({
    search,
    runtimeWebSearch,
    providerId: params.providerId,
    providers: candidates,
  });
  let lastError: unknown;
  let sawUnavailableProvider = false;

  for (const candidate of candidates) {
    try {
      const definition = resolveWebSearchDefinition({
        config,
        providerId: candidate.id,
        sandboxed: params.sandboxed,
        preferRuntimeProviders: params.preferRuntimeProviders ?? true,
        runtimeWebSearch,
      });
      if (!definition) {
        if (!allowFallback) {
          throw new Error(`web_search provider "${candidate.id}" is not available.`);
        }
        sawUnavailableProvider = true;
        continue;
      }
      const executed = await definition.definition.execute(params.args);
      if (allowFallback && isStructuredAvailabilityError(executed)) {
        lastError = new Error(`web_search provider "${candidate.id}" returned ${executed.error}`);
        continue;
      }
      return {
        provider: candidate.id,
        result: executed,
      };
    } catch (error) {
      lastError = error;
      if (!allowFallback) {
        throw error;
      }
    }
  }

  if (sawUnavailableProvider && lastError === undefined) {
    throw new Error("web_search is enabled but no provider is currently available.");
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export const __testing = {
  clearPreparedWebSearchDefinitionCache(): void {
    preparedWebSearchDefinitionsByConfig = new WeakMap<
      OpenClawConfig,
      Map<string, ResolvedWebSearchDefinition>
    >();
    preparedWebSearchDefinitionsWithoutConfig.clear();
  },
  createPreparedWebSearchDefinitionCacheKey,
  resolveSearchConfig,
  resolveSearchProvider: resolveWebSearchProviderId,
  resolveWebSearchProviderId,
  resolveWebSearchCandidates,
  hasExplicitWebSearchSelection,
};
