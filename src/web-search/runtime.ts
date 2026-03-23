import type { OpenClawConfig } from "../config/config.js";
import { normalizeResolvedSecretInputString } from "../config/types.secrets.js";
import { logVerbose } from "../globals.js";
import type {
  PluginWebSearchProviderEntry,
  WebSearchProviderToolDefinition,
} from "../plugins/types.js";
import { resolveBundledPluginWebSearchProviders } from "../plugins/web-search-providers.js";
import { resolvePluginWebSearchProviders } from "../plugins/web-search-providers.runtime.js";
import { resolveRuntimeWebSearchProviders } from "../plugins/web-search-providers.runtime.js";
import type { RuntimeWebSearchMetadata } from "../secrets/runtime-web-tools.types.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";

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
  const search = cfg?.tools?.web?.search;
  if (!search || typeof search !== "object") {
    return undefined;
  }
  return search as WebSearchConfig;
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

function readProviderEnvValue(envVars: string[]): string | undefined {
  for (const envVar of envVars) {
    const value = normalizeSecretInput(process.env[envVar]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function providerRequiresCredential(
  provider: Pick<PluginWebSearchProviderEntry, "requiresCredential">,
): boolean {
  return provider.requiresCredential !== false;
}

function hasEntryCredential(
  provider: Pick<
    PluginWebSearchProviderEntry,
    | "credentialPath"
    | "envVars"
    | "getConfiguredCredentialValue"
    | "getCredentialValue"
    | "requiresCredential"
  >,
  config: OpenClawConfig | undefined,
  search: WebSearchConfig | undefined,
): boolean {
  if (!providerRequiresCredential(provider)) {
    return true;
  }
  const rawValue =
    provider.getConfiguredCredentialValue?.(config) ??
    provider.getCredentialValue(search as Record<string, unknown> | undefined);
  const fromConfig = normalizeSecretInput(
    normalizeResolvedSecretInputString({
      value: rawValue,
      path: provider.credentialPath,
    }),
  );
  return Boolean(fromConfig || readProviderEnvValue(provider.envVars));
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
  const providers =
    params.providers ??
    resolveBundledPluginWebSearchProviders({
      config: params.config,
      bundledAllowlistCompat: true,
    });
  const raw =
    params.search && "provider" in params.search && typeof params.search.provider === "string"
      ? params.search.provider.trim().toLowerCase()
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
  if (!resolveWebSearchEnabled({ search, sandboxed: options?.sandboxed })) {
    return null;
  }

  const providers = (
    options?.preferRuntimeProviders
      ? resolveRuntimeWebSearchProviders({
          config: options?.config,
          bundledAllowlistCompat: true,
        })
      : resolveBundledPluginWebSearchProviders({
          config: options?.config,
          bundledAllowlistCompat: true,
        })
  ).filter(Boolean);
  if (providers.length === 0) {
    return null;
  }

  const providerId =
    options?.providerId ??
    options?.runtimeWebSearch?.selectedProvider ??
    options?.runtimeWebSearch?.providerConfigured ??
    resolveWebSearchProviderId({ config: options?.config, search, providers });
  const provider =
    providers.find((entry) => entry.id === providerId) ??
    providers.find(
      (entry) =>
        entry.id === resolveWebSearchProviderId({ config: options?.config, search, providers }),
    ) ??
    providers[0];
  if (!provider) {
    return null;
  }

  const definition = provider.createTool({
    config: options?.config,
    searchConfig: search as Record<string, unknown> | undefined,
    runtimeMetadata: options?.runtimeWebSearch,
  });
  if (!definition) {
    return null;
  }

  return { provider, definition };
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
