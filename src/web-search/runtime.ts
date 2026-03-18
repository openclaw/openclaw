import type { OpenClawConfig } from "../config/config.js";
import { normalizeResolvedSecretInputString } from "../config/types.secrets.js";
import { logVerbose } from "../globals.js";
import type {
  PluginWebSearchProviderEntry,
  WebSearchProviderToolDefinition,
} from "../plugins/types.js";
import {
  resolvePluginWebSearchProviders,
  resolveRuntimeWebSearchProviders,
} from "../plugins/web-search-providers.js";
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

function hasProviderCredential(
  providerId: string,
  config: OpenClawConfig | undefined,
  search: WebSearchConfig | undefined,
): boolean {
  const providers = resolvePluginWebSearchProviders({
    config,
    bundledAllowlistCompat: true,
  });
  const provider = providers.find((entry) => entry.id === providerId);
  if (!provider) {
    return false;
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

export function resolveWebSearchProviderId(params: {
  search?: WebSearchConfig;
  config?: OpenClawConfig;
  providers?: PluginWebSearchProviderEntry[];
}): string {
  const providers =
    params.providers ??
    resolvePluginWebSearchProviders({
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
    for (const provider of providers) {
      if (!hasProviderCredential(provider.id, params.config, params.search)) {
        continue;
      }
      logVerbose(
        `web_search: no provider configured, auto-detected "${provider.id}" from available API keys`,
      );
      return provider.id;
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
      : resolvePluginWebSearchProviders({
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
