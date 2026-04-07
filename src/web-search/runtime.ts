import type { OpenClawConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import type {
  PluginWebSearchProviderEntry,
  WebSearchProviderToolDefinition,
} from "../plugins/types.js";
import { resolvePluginWebSearchProviders } from "../plugins/web-search-providers.runtime.js";
import { resolveRuntimeWebSearchProviders } from "../plugins/web-search-providers.runtime.js";
import { sortWebSearchProvidersForAutoDetect } from "../plugins/web-search-providers.shared.js";
import { getActiveRuntimeWebToolsMetadata } from "../secrets/runtime-web-tools-state.js";
import type { RuntimeWebSearchMetadata } from "../secrets/runtime-web-tools.types.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import {
  hasWebProviderEntryCredential,
  providerRequiresCredential,
  readWebProviderEnvValue,
  resolveWebProviderConfig,
  resolveWebProviderDefinition,
} from "../web/provider-runtime-shared.js";

type WebSearchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { search?: infer Search }
    ? Search
    : undefined
  : undefined;

export type ResolveWebSearchDefinitionParams = {
  config?: OpenClawConfig;
  sandboxed?: boolean;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
  providerId?: string;
  preferRuntimeProviders?: boolean;
};

export type RunWebSearchParams = ResolveWebSearchDefinitionParams & {
  args: Record<string, unknown>;
};

function resolveSearchConfig(cfg?: OpenClawConfig): WebSearchConfig {
  return resolveWebProviderConfig<"search", NonNullable<WebSearchConfig>>(cfg, "search");
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
    resolveRawValue: ({ provider: currentProvider, config: currentConfig, toolConfig }) =>
      currentProvider.getConfiguredCredentialValue?.(currentConfig) ??
      (currentProvider.id === "brave" ? currentProvider.getCredentialValue(toolConfig) : undefined),
    resolveEnvValue: ({ provider: currentProvider, configuredEnvVarId }) =>
      (configuredEnvVarId ? readWebProviderEnvValue([configuredEnvVarId]) : undefined) ??
      readWebProviderEnvValue(currentProvider.envVars),
  });
}

export function listWebSearchProviders(params?: {
  config?: OpenClawConfig;
}): PluginWebSearchProviderEntry[] {
  return resolveRuntimeWebSearchProviders({
    config: params?.config,
    bundledAllowlistCompat: true,
  });
}

export function listConfiguredWebSearchProviders(params?: {
  config?: OpenClawConfig;
}): PluginWebSearchProviderEntry[] {
  return resolvePluginWebSearchProviders({
    config: params?.config,
    bundledAllowlistCompat: true,
  });
}

export function resolveWebSearchProviderId(params: {
  search?: WebSearchConfig;
  config?: OpenClawConfig;
  providers?: PluginWebSearchProviderEntry[];
}): string {
  const providers = sortWebSearchProvidersForAutoDetect(
    params.providers ??
      resolvePluginWebSearchProviders({
        config: params.config,
        bundledAllowlistCompat: true,
        origin: "bundled",
      }),
  );
  const raw =
    params.search && "provider" in params.search
      ? normalizeLowercaseStringOrEmpty(params.search.provider)
      : "";

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
      if (!hasEntryCredential(provider, params.config, params.search)) {
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

export function resolveWebSearchDefinition(
  options?: ResolveWebSearchDefinitionParams,
): { provider: PluginWebSearchProviderEntry; definition: WebSearchProviderToolDefinition } | null {
  const search = resolveSearchConfig(options?.config);
  const runtimeWebSearch = options?.runtimeWebSearch ?? getActiveRuntimeWebToolsMetadata()?.search;
  const providers = sortWebSearchProvidersForAutoDetect(
    options?.preferRuntimeProviders
      ? resolveRuntimeWebSearchProviders({
          config: options?.config,
          bundledAllowlistCompat: true,
        })
      : resolvePluginWebSearchProviders({
          config: options?.config,
          bundledAllowlistCompat: true,
          origin: "bundled",
        }),
  );
  return resolveWebProviderDefinition({
    config: options?.config,
    toolConfig: search as Record<string, unknown> | undefined,
    runtimeMetadata: runtimeWebSearch,
    sandboxed: options?.sandboxed,
    providerId: options?.providerId,
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

export async function runWebSearch(
  params: RunWebSearchParams,
): Promise<{ provider: string; result: Record<string, unknown> }> {
  const resolved = resolveWebSearchDefinition({ ...params, preferRuntimeProviders: true });
  if (!resolved) {
    throw new Error("web_search is disabled or no provider is available.");
  }
  return {
    provider: resolved.provider.id,
    result: await resolved.definition.execute(params.args),
  };
}

export const __testing = {
  resolveSearchConfig,
  resolveSearchProvider: resolveWebSearchProviderId,
  resolveWebSearchProviderId,
};
