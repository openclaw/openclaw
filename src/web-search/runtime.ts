import { coerceToFailoverError } from "../agents/failover-error.js";
import type { OpenClawConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import type {
  PluginWebSearchProviderEntry,
  WebSearchProviderToolDefinition,
} from "../plugins/types.js";
import {
  normalizeLowercaseStringOrEmpty,
} from "../shared/string-coerce.js";
import {
  resolvePluginWebSearchProviders,
  resolveRuntimeWebSearchProviders,
} from "../plugins/web-search-providers.runtime.js";
import { sortWebSearchProvidersForAutoDetect } from "../plugins/web-search-providers.shared.js";
import { getActiveRuntimeWebToolsMetadata } from "../secrets/runtime-web-tools-state.js";
import type { RuntimeWebSearchMetadata } from "../secrets/runtime-web-tools.types.js";
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
  return hasEntryCredential(params.provider, params.config, resolveSearchConfig(params.config));
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
  const raw = normalizeLowercaseStringOrEmpty(
    params.search && "provider" in params.search ? params.search.provider : undefined,
  );

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
  const search = resolveSearchConfig(params.config);

  const configuredFallbacks: string[] =
    search && "fallbacks" in search && Array.isArray(search.fallbacks)
      ? search.fallbacks
          .filter((id): id is string => typeof id === "string")
          .map((id) => id.trim())
          .filter((id) => id.length > 0)
      : [];

  // If caller passed an explicit providerId, normalize it early so mixed-case
  // inputs (e.g. --provider Grok) are handled consistently throughout.
  // Validate the id exists in the registry WITHOUT calling createTool —
  // that is deferred to the execution loop so broken providers don't prevent
  // configured fallbacks from being tried.
  const runtimePref = params.preferRuntimeProviders ?? true;
  if (params.providerId !== undefined) {
    const normalizedExplicit = normalizeLowercaseStringOrEmpty(params.providerId);
    const registry = runtimePref
      ? resolveRuntimeWebSearchProviders({ config: params.config, bundledAllowlistCompat: true })
      : resolvePluginWebSearchProviders({
          config: params.config,
          bundledAllowlistCompat: true,
          origin: "bundled",
        });
    if (!registry.some((p) => p.id.toLowerCase() === normalizedExplicit)) {
      throw new Error(`Unknown web_search provider "${params.providerId}".`);
    }
  }

  // Auto-detect the primary provider to seed the fallback chain.
  // Use trimmed providerId (preserve original casing) so resolveWebProviderDefinition
  // finds it correctly — provider lookup already normalizes internally.
  const trimmedPrimaryId = params.providerId?.trim();
  let primaryProviderId = "";
  let primaryInitError: unknown;
  // Store the primary's resolved definition so it is not resolved again in the loop.
  let primaryDefinition:
    | { provider: PluginWebSearchProviderEntry; definition: WebSearchProviderToolDefinition }
    | null
    | undefined;
  try {
    const primaryResolved = resolveWebSearchDefinition({
      ...params,
      providerId: trimmedPrimaryId,
      preferRuntimeProviders: runtimePref,
    });
    primaryProviderId = primaryResolved?.provider.id ?? "";
    primaryDefinition = primaryResolved;
    // When an explicit providerId is given and resolution returns null, fail fast
    // rather than silently falling through to a generic "no provider" error.
    if (params.providerId !== undefined && primaryResolved === null) {
      throw new Error(
        `Web search provider "${trimmedPrimaryId}" is not available (tool returned null).`,
      );
    }
  } catch (err) {
    // Non-retryable init errors from the primary should fail fast — do not
    // silently continue and risk masking with a fallback provider.
    const normalized = coerceToFailoverError(err, { provider: trimmedPrimaryId ?? "auto" });
    if (normalized) {
      const reason = normalized.reason;
      if (reason !== "rate_limit" && reason !== "billing") {
        throw err;
      }
    }
    primaryInitError = err;
  }

  // Build ordered provider chain from raw ids only. Do NOT call resolveWebSearchDefinition
  // here — that invokes createTool which has side effects and defeats lazy init.
  // Chain building only needs the primary provider id; all other resolution is
  // deferred until that provider is actually needed in the execution loop.
  const seenProviderIds = new Set<string>();
  const allProviderIds: string[] = [];

  // allProviderIds stores normalized fallback ids (lowercased) but original
  // casing for the primary provider id. The execution loop matches casing
  // exactly for the primary and lowercased for fallbacks. Duplicates are
  // detected case-insensitively.
  if (primaryProviderId && !seenProviderIds.has(primaryProviderId.toLowerCase())) {
    seenProviderIds.add(primaryProviderId.toLowerCase());
    allProviderIds.push(primaryProviderId);
  }

  // Only apply configured fallbacks when the caller has not pinned an explicit providerId.
  // An explicit providerId means "run only this provider" — fallbacks would override that intent.
  if (params.providerId === undefined) {
    for (const fallbackId of configuredFallbacks) {
      if (!fallbackId) {
        continue;
      }
      const normalizedFallbackId = normalizeLowercaseStringOrEmpty(fallbackId);
      if (seenProviderIds.has(normalizedFallbackId)) {
        continue;
      }
      seenProviderIds.add(normalizedFallbackId);
      // Push trimmed casing (not lowercased) so resolveWebSearchDefinition
      // can match it case-sensitively as registered.
      allProviderIds.push(fallbackId.trim());
    }
  }

  let lastError: unknown;

  // Cache the registry once for case-insensitive fallback ID pre-validation.
  // This avoids calling resolveWebSearchDefinition (which invokes createTool)
  // for unknown typoed fallback ids, preventing init errors from aborting
  // the chain before valid fallbacks are reached.
  const registry = runtimePref
    ? resolveRuntimeWebSearchProviders({ config: params.config, bundledAllowlistCompat: true })
    : resolvePluginWebSearchProviders({
        config: params.config,
        bundledAllowlistCompat: true,
        origin: "bundled",
      });

  for (const providerId of allProviderIds) {
    // Pre-validate: skip unknown fallback ids before calling resolveWebSearchDefinition.
    // This prevents a typoed fallback like "typo" from triggering createTool of a
    // wrong provider and throwing a non-retryable init error that aborts the chain.
    if (!registry.some((p) => p.id.toLowerCase() === providerId.toLowerCase())) {
      continue;
    }

    // Reuse the primary definition if this iteration is the primary — avoids double init.
    const isPrimary = providerId === primaryProviderId && primaryDefinition !== undefined;
    let resolved:
      | { provider: PluginWebSearchProviderEntry; definition: WebSearchProviderToolDefinition }
      | null
      | undefined;
    if (isPrimary) {
      resolved = primaryDefinition;
    } else {
      try {
        resolved = resolveWebSearchDefinition({
          ...params,
          providerId,
          preferRuntimeProviders: runtimePref,
        });
      } catch (err) {
        // Init-time errors: save the most recent error so the final failure
        // reflects the terminal error from the last attempted provider.
        // For non-retryable FailoverError (not rate_limit/billing), throw immediately
        // so hard config/auth errors don't silently switch to a different provider.
        const normalized = coerceToFailoverError(err, { provider: providerId });
        if (normalized) {
          const reason = normalized.reason;
          if (reason !== "rate_limit" && reason !== "billing") {
            throw err;
          }
        }
        lastError = err;
        // Definition init failed (e.g. provider createTool throws) — skip without stopping the chain
        continue;
      }
    }
    if (!resolved) {
      continue;
    }

    // Skip if the resolved provider does not match the requested id.
    // resolveWebSearchDefinition may substitute an auto-selected provider for
    // unknown ids (e.g. a typo'd fallback), which would cause duplicate retries
    // against the same failing primary instead of progressing to a valid fallback.
    // Normalize both sides since provider ids can be mixed-case (only trimmed, not lowercased on registration).
    if (resolved.provider.id.toLowerCase() !== providerId.toLowerCase()) {
      continue;
    }

    try {
      return {
        provider: resolved.provider.id,
        result: await resolved.definition.execute(params.args),
      };
    } catch (err) {
      lastError = err;
      const normalized = coerceToFailoverError(err, { provider: providerId });

      // Only retry on rate_limit or billing errors; throw all others immediately
      if (normalized) {
        const reason = normalized.reason;
        if (reason === "rate_limit" || reason === "billing") {
          logVerbose(
            `web_search: provider "${providerId}" failed with ${reason}, trying next fallback`,
          );
          continue;
        }
      }

      throw err;
    }
  }

  throw (
    lastError ??
    primaryInitError ??
    new Error("web_search is disabled or no provider is available.")
  );
}

export const __testing = {
  resolveSearchConfig,
  resolveSearchProvider: resolveWebSearchProviderId,
  resolveWebSearchProviderId,
};
