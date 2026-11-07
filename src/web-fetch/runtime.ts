import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveRuntimeConfigCacheKey } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.js";
import { sortPluginEntriesForAutoDetect } from "../plugins/plugin-entry-order.js";
import { getActivePluginRegistryVersion } from "../plugins/runtime.js";
import type {
  PluginWebFetchProviderEntry,
  WebFetchProviderToolDefinition,
} from "../plugins/types.js";
import {
  resolvePluginWebFetchProviders,
  resolveRuntimeWebFetchProviders,
} from "../plugins/web-fetch-providers.runtime.js";
import { getActiveRuntimeWebToolsMetadataFromState } from "../secrets/runtime-web-tools-state.js";
import type { RuntimeWebFetchMetadata } from "../secrets/runtime-web-tools.types.js";
import {
  hasWebProviderEntryCredential,
  providerRequiresCredential,
  readWebProviderEnvValue,
  resolveWebProviderConfig,
  type WebProviderWithCredential,
} from "../web/provider-runtime-shared.js";

type WebFetchConfig = NonNullable<NonNullable<OpenClawConfig["tools"]>["web"]>["fetch"];

type ResolveWebFetchDefinitionParams = {
  config?: OpenClawConfig;
  sandboxed?: boolean;
  runtimeWebFetch?: RuntimeWebFetchMetadata;
  providerId?: string;
  preferRuntimeProviders?: boolean;
};
type WebFetchDefinitionResolution = {
  provider: PluginWebFetchProviderEntry;
  definition: WebFetchProviderToolDefinition;
} | null;
type WebFetchProviderCacheEntry = {
  cacheKey: string;
  configFingerprint: string;
  providers: PluginWebFetchProviderEntry[];
};

const webFetchProviderCache = new WeakMap<OpenClawConfig, WebFetchProviderCacheEntry>();

function hasEntryCredential(
  provider: WebProviderWithCredential,
  config: OpenClawConfig | undefined,
): boolean {
  return hasWebProviderEntryCredential({
    provider,
    config,
    resolveEnvValue: () => readWebProviderEnvValue(provider.envVars),
  });
}

export function isWebFetchProviderConfigured(params: {
  provider: Pick<
    PluginWebFetchProviderEntry,
    | "envVars"
    | "getConfiguredCredentialFallback"
    | "getConfiguredCredentialValue"
    | "getCredentialValue"
    | "requiresCredential"
  >;
  config?: OpenClawConfig;
}): boolean {
  return hasEntryCredential(params.provider, params.config);
}

export function listWebFetchProviders(params?: {
  config?: OpenClawConfig;
}): PluginWebFetchProviderEntry[] {
  return resolvePluginWebFetchProviders({
    config: params?.config,
  });
}

export function resolveWebFetchDefinition(
  options?: ResolveWebFetchDefinitionParams,
): WebFetchDefinitionResolution {
  /** Auto-detects a web_fetch provider after explicit selections have been resolved. */
  function resolveAutoWebFetchProviderId(): string {
    const config = options?.config;
    for (const provider of providers) {
      const requiresCredential = providerRequiresCredential(provider);
      if (
        !hasEntryCredential(
          requiresCredential ? provider : { ...provider, requiresCredential: true },
          config,
        )
      ) {
        continue;
      }
      return provider.id;
    }

    return "";
  }

  function resolveWebFetchProvidersForOptions(): PluginWebFetchProviderEntry[] {
    const config = options?.config;
    const cacheKey = config
      ? JSON.stringify([
          getActivePluginRegistryVersion(),
          options?.sandboxed === true,
          options?.preferRuntimeProviders === true,
        ])
      : "";
    const configFingerprint = config ? resolveRuntimeConfigCacheKey(config) : "";
    const cached = config ? webFetchProviderCache.get(config) : undefined;
    if (cached?.cacheKey === cacheKey && cached.configFingerprint === configFingerprint) {
      return cached.providers;
    }
    const entries = sortPluginEntriesForAutoDetect(
      options?.sandboxed
        ? resolvePluginWebFetchProviders({
            config: options?.config,
            sandboxed: true,
          })
        : options?.preferRuntimeProviders
          ? resolveRuntimeWebFetchProviders({
              config: options?.config,
            })
          : resolvePluginWebFetchProviders({
              config: options?.config,
            }),
    );
    if (config && entries.length > 0) {
      webFetchProviderCache.set(config, { cacheKey, configFingerprint, providers: entries });
    }
    return entries;
  }

  const fetch = resolveWebProviderConfig(options?.config, "fetch") as WebFetchConfig;
  if (fetch?.enabled === false) {
    return null;
  }
  const runtimeWebFetch =
    options?.runtimeWebFetch ?? getActiveRuntimeWebToolsMetadataFromState()?.fetch;
  const providers = resolveWebFetchProvidersForOptions();
  if (providers.length === 0) {
    return null;
  }
  const configuredProviderId = normalizeLowercaseStringOrEmpty(fetch?.provider);
  // An explicitly supplied provider id (including a blank one) never falls
  // through to configured, runtime, or automatic selection: the original
  // explicit-selection contract resolves it against the provider list or
  // returns no definition. Exact registered ids win before the
  // case-insensitive match, like config selection.
  const explicitProviderId =
    typeof options?.providerId === "string" ? options.providerId.trim() : undefined;
  const resolveExplicitProviderId = (): string | undefined =>
    explicitProviderId === undefined
      ? undefined
      : (
          providers.find((entry) => entry.id === explicitProviderId) ??
          providers.find((entry) => entry.id.toLowerCase() === explicitProviderId.toLowerCase())
        )?.id;
  const providerId =
    explicitProviderId !== undefined
      ? resolveExplicitProviderId()
      : ((configuredProviderId
          ? providers.find((entry) => entry.id === configuredProviderId)?.id
          : undefined) ??
        runtimeWebFetch?.selectedProvider ??
        resolveAutoWebFetchProviderId());
  const provider = providerId ? providers.find((entry) => entry.id === providerId) : undefined;
  if (!provider) {
    return null;
  }
  const definition = provider.createTool({
    config: options?.config,
    fetchConfig: fetch as Record<string, unknown> | undefined,
    runtimeMetadata: runtimeWebFetch,
  });
  return definition ? { provider, definition } : null;
}
