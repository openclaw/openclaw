import type { OpenClawConfig } from "../config/config.js";
import { normalizeSecretInputString, resolveSecretInputRef } from "../config/types.secrets.js";
import { logVerbose } from "../globals.js";
import type {
  PluginWebFetchProviderEntry,
  WebFetchProviderToolDefinition,
} from "../plugins/types.js";
import { resolvePluginWebFetchProviders } from "../plugins/web-fetch-providers.runtime.js";
import { sortWebFetchProvidersForAutoDetect } from "../plugins/web-fetch-providers.shared.js";
import type { RuntimeWebFetchMetadata } from "../secrets/runtime-web-tools.types.js";
import { getActiveRuntimeWebToolsMetadata } from "../secrets/runtime-web-tools-state.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";

type WebFetchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { fetch?: infer Fetch }
    ? Fetch
    : undefined
  : undefined;

export type ResolveWebFetchDefinitionParams = {
  config?: OpenClawConfig;
  sandboxed?: boolean;
  runtimeWebFetch?: RuntimeWebFetchMetadata;
  providerId?: string;
  preferRuntimeProviders?: boolean;
};

function resolveFetchConfig(cfg?: OpenClawConfig): WebFetchConfig {
  const fetch = cfg?.tools?.web?.fetch;
  if (!fetch || typeof fetch !== "object") {
    return undefined;
  }
  return fetch as WebFetchConfig;
}

export function resolveWebFetchEnabled(params: {
  fetch?: WebFetchConfig;
  sandboxed?: boolean;
}): boolean {
  if (typeof params.fetch?.enabled === "boolean") {
    return params.fetch.enabled;
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
  provider: Pick<PluginWebFetchProviderEntry, "requiresCredential">,
): boolean {
  return provider.requiresCredential !== false;
}

function hasEntryCredential(
  provider: Pick<
    PluginWebFetchProviderEntry,
    "envVars" | "getConfiguredCredentialValue" | "getCredentialValue" | "requiresCredential"
  >,
  config: OpenClawConfig | undefined,
  fetch: WebFetchConfig | undefined,
): boolean {
  if (!providerRequiresCredential(provider)) {
    return true;
  }
  const configuredValue = provider.getConfiguredCredentialValue?.(config);
  const rawValue = configuredValue ?? provider.getCredentialValue(fetch as Record<string, unknown>);
  const configuredRef = resolveSecretInputRef({
    value: rawValue,
  }).ref;
  if (configuredRef && configuredRef.source !== "env") {
    return true;
  }
  const fromConfig = normalizeSecretInput(normalizeSecretInputString(rawValue));
  return Boolean(fromConfig || readProviderEnvValue(provider.envVars));
}

export function listWebFetchProviders(params?: {
  config?: OpenClawConfig;
}): PluginWebFetchProviderEntry[] {
  return resolvePluginWebFetchProviders({
    config: params?.config,
    bundledAllowlistCompat: true,
    origin: "bundled",
  });
}

export function listConfiguredWebFetchProviders(params?: {
  config?: OpenClawConfig;
}): PluginWebFetchProviderEntry[] {
  return resolvePluginWebFetchProviders({
    config: params?.config,
    bundledAllowlistCompat: true,
  });
}

export function resolveWebFetchProviderId(params: {
  fetch?: WebFetchConfig;
  config?: OpenClawConfig;
  providers?: PluginWebFetchProviderEntry[];
}): string {
  const providers = sortWebFetchProvidersForAutoDetect(
    params.providers ??
      resolvePluginWebFetchProviders({
        config: params.config,
        bundledAllowlistCompat: true,
        origin: "bundled",
      }),
  );
  const raw =
    params.fetch && "provider" in params.fetch && typeof params.fetch.provider === "string"
      ? params.fetch.provider.trim().toLowerCase()
      : "";

  if (raw) {
    const explicit = providers.find((provider) => provider.id === raw);
    if (explicit) {
      return explicit.id;
    }
  }

  for (const provider of providers) {
    if (!providerRequiresCredential(provider)) {
      logVerbose(
        `web_fetch: ${raw ? `invalid configured provider "${raw}", ` : ""}auto-detected keyless provider "${provider.id}"`,
      );
      return provider.id;
    }
    if (!hasEntryCredential(provider, params.config, params.fetch)) {
      continue;
    }
    logVerbose(
      `web_fetch: ${raw ? `invalid configured provider "${raw}", ` : ""}auto-detected "${provider.id}" from available API keys`,
    );
    return provider.id;
  }

  return "";
}

export function resolveWebFetchDefinition(
  options?: ResolveWebFetchDefinitionParams,
): { provider: PluginWebFetchProviderEntry; definition: WebFetchProviderToolDefinition } | null {
  const fetch = resolveFetchConfig(options?.config);
  const runtimeWebFetch = options?.runtimeWebFetch ?? getActiveRuntimeWebToolsMetadata()?.fetch;
  if (!resolveWebFetchEnabled({ fetch, sandboxed: options?.sandboxed })) {
    return null;
  }

  const providers = sortWebFetchProvidersForAutoDetect(
    resolvePluginWebFetchProviders({
      config: options?.config,
      bundledAllowlistCompat: true,
      origin: "bundled",
    }),
  ).filter(Boolean);
  if (providers.length === 0) {
    return null;
  }

  const providerId =
    options?.providerId ??
    runtimeWebFetch?.selectedProvider ??
    runtimeWebFetch?.providerConfigured ??
    resolveWebFetchProviderId({ config: options?.config, fetch, providers });
  if (!providerId) {
    return null;
  }
  const provider = providers.find((entry) => entry.id === providerId);
  if (!provider) {
    return null;
  }

  const definition = provider.createTool({
    config: options?.config,
    fetchConfig: fetch as Record<string, unknown> | undefined,
    runtimeMetadata: runtimeWebFetch,
  });
  if (!definition) {
    return null;
  }

  return { provider, definition };
}
