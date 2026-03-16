import type { OpenClawConfig } from "../../config/config.js";
import { normalizeResolvedSecretInputString } from "../../config/types.secrets.js";
import { logVerbose } from "../../globals.js";
import { resolvePluginWebSearchProviders } from "../../plugins/web-search-providers.js";
import type { RuntimeWebSearchMetadata } from "../../secrets/runtime-web-tools.types.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { __testing as coreTesting } from "./web-search-core.js";

type WebSearchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { search?: infer Search }
    ? Search
    : undefined
  : undefined;

function resolveSearchConfig(cfg?: OpenClawConfig): WebSearchConfig {
  const search = cfg?.tools?.web?.search;
  if (!search || typeof search !== "object") {
    return undefined;
  }
  return search as WebSearchConfig;
}

function resolveSearchEnabled(params: { search?: WebSearchConfig; sandboxed?: boolean }): boolean {
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

function hasProviderCredential(providerId: string, search: WebSearchConfig | undefined): boolean {
  const providers = resolvePluginWebSearchProviders({
    bundledAllowlistCompat: true,
  });
  const provider = providers.find((entry) => entry.id === providerId);
  if (!provider) {
    return false;
  }
  const rawValue = provider.getCredentialValue(search as Record<string, unknown> | undefined);
  const fromConfig = normalizeSecretInput(
    normalizeResolvedSecretInputString({
      value: rawValue,
      path:
        providerId === "brave"
          ? "tools.web.search.apiKey"
          : `tools.web.search.${providerId}.apiKey`,
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
      if (!hasProviderCredential(provider.id, search)) {
        continue;
      }
      logVerbose(
        `web_search: no provider configured, auto-detected "${provider.id}" from available API keys`,
      );
      return provider.id;
    }
  }

  return providers[0]?.id ?? "brave";
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
  ...coreTesting,
  resolveSearchProvider,
};
