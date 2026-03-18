import type { OpenClawConfig } from "../../config/config.js";
import { normalizeResolvedSecretInputString } from "../../config/types.secrets.js";
import { logVerbose } from "../../globals.js";
import { resolvePluginWebSearchProviders } from "../../plugins/web-search-providers.js";
import type { PluginWebSearchProviderEntry } from "../../plugins/types.js";
import type { RuntimeWebSearchMetadata } from "../../secrets/runtime-web-tools.types.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { SEARCH_CACHE } from "./web-search-provider-common.js";
import {
  resolveSearchConfig,
  resolveSearchEnabled,
  type WebSearchConfig,
} from "./web-search-provider-config.js";

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
  provider: PluginWebSearchProviderEntry,
  search: WebSearchConfig | undefined,
): boolean {
  const rawValue = provider.getCredentialValue(search as Record<string, unknown> | undefined);
  const fromConfig = normalizeSecretInput(
    normalizeResolvedSecretInputString({
      value: rawValue,
      path: provider.credentialPath,
    }),
  );
  return Boolean(fromConfig || readProviderEnvValue(provider.envVars));
}

function resolveSearchProvider(search?: WebSearchConfig): string {
  const providers = resolvePluginWebSearchProviders({
    bundledAllowlistCompat: true,
  });
  const raw =
    search && "provider" in search && typeof search.provider === "string"
      ? search.provider.trim().toLowerCase()
      : "";

  if (raw) {
    const explicit = providers.find((provider) => provider.id === raw);
    if (explicit) {
      return explicit.id;
    }
  }

  if (!raw) {
    for (const provider of providers) {
      if (!hasProviderCredential(provider, search)) {
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

export function createWebSearchTool(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
}): AnyAgentTool | null {
  const search = resolveSearchConfig(options?.config);
  if (!resolveSearchEnabled({ search, sandboxed: options?.sandboxed })) {
    return null;
  }

  const providers = resolvePluginWebSearchProviders({
    config: options?.config,
    bundledAllowlistCompat: true,
  });
  if (providers.length === 0) {
    return null;
  }

  const providerId =
    options?.runtimeWebSearch?.selectedProvider ??
    options?.runtimeWebSearch?.providerConfigured ??
    resolveSearchProvider(search);
  const provider =
    providers.find((entry) => entry.id === providerId) ??
    providers.find((entry) => entry.id === resolveSearchProvider(search)) ??
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

  return {
    label: "Web Search",
    name: "web_search",
    description: definition.description,
    parameters: definition.parameters,
    execute: async (_toolCallId, args) => jsonResult(await definition.execute(args)),
  };
}

export const __testing = {
  SEARCH_CACHE,
  resolveSearchProvider,
};
