import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveRuntimeConfigCacheKey } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.js";
import { logVerbose } from "../globals.js";
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

/** Reports whether a web_fetch provider has usable credentials. */
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

/** Lists web_fetch providers available to runtime selection. */
export function listWebFetchProviders(params?: {
  config?: OpenClawConfig;
}): PluginWebFetchProviderEntry[] {
  return resolvePluginWebFetchProviders({
    config: params?.config,
  });
}

/** Auto-detects a web_fetch provider after explicit selections have been resolved. */
function resolveAutoWebFetchProviderId(params: {
  configuredProviderId: string;
  config?: OpenClawConfig;
  providers: PluginWebFetchProviderEntry[];
}): string {
  for (const provider of params.providers) {
    const requiresCredential = providerRequiresCredential(provider);
    if (
      !hasEntryCredential(
        requiresCredential ? provider : { ...provider, requiresCredential: true },
        params.config,
      )
    ) {
      continue;
    }
    const source = requiresCredential
      ? `"${provider.id}" from available API keys`
      : `keyless provider "${provider.id}"`;
    logVerbose(
      `web_fetch: ${params.configuredProviderId ? `invalid configured provider "${params.configuredProviderId}", ` : ""}auto-detected ${source}`,
    );
    return provider.id;
  }

  return "";
}

function resolveWebFetchProvidersForOptions(
  options?: ResolveWebFetchDefinitionParams,
): PluginWebFetchProviderEntry[] {
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
  const providers = sortPluginEntriesForAutoDetect(
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
  if (config && providers.length > 0) {
    webFetchProviderCache.set(config, { cacheKey, configFingerprint, providers });
  }
  return providers;
}

/** Resolves the executable web_fetch provider tool definition. */
export function resolveWebFetchDefinition(
  options?: ResolveWebFetchDefinitionParams,
): WebFetchDefinitionResolution {
  const fetch = resolveWebProviderConfig(options?.config, "fetch") as WebFetchConfig;
  if (fetch?.enabled === false) {
    return null;
  }
  const runtimeWebFetch =
    options?.runtimeWebFetch ?? getActiveRuntimeWebToolsMetadataFromState()?.fetch;
  const providers = resolveWebFetchProvidersForOptions(options);
  if (providers.length === 0) {
    return null;
  }
  const configuredProviderId = normalizeLowercaseStringOrEmpty(fetch?.provider);
  const providerId =
    options?.providerId ??
    (configuredProviderId
      ? providers.find((entry) => entry.id === configuredProviderId)?.id
      : undefined) ??
    runtimeWebFetch?.selectedProvider ??
    resolveAutoWebFetchProviderId({ config: options?.config, configuredProviderId, providers });
  const provider = providers.find((entry) => entry.id === providerId);
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
