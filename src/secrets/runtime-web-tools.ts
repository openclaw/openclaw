import {
  BUILTIN_WEB_SEARCH_PROVIDER_IDS,
  type BuiltinWebSearchProviderId,
  normalizeBuiltinWebSearchProvider,
} from "../agents/tools/web-search-provider-catalog.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import type { SearchProviderLegacyConfigMetadata, SearchProviderPlugin } from "../plugins/types.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
import { secretRefKey } from "./ref-contract.js";
import { resolveSecretRefValues } from "./resolve.js";
import {
  pushInactiveSurfaceWarning,
  pushWarning,
  type ResolverContext,
  type SecretDefaults,
} from "./runtime-shared.js";

type WebSearchProvider = BuiltinWebSearchProviderId;

type SecretResolutionSource = "config" | "secretRef" | "env" | "missing"; // pragma: allowlist secret
type RuntimeWebProviderSource = "configured" | "auto-detect" | "none";

export type RuntimeWebDiagnosticCode =
  | "WEB_SEARCH_PROVIDER_INVALID_AUTODETECT"
  | "WEB_SEARCH_AUTODETECT_SELECTED"
  | "WEB_SEARCH_KEY_UNRESOLVED_FALLBACK_USED"
  | "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK"
  | "WEB_FETCH_FIRECRAWL_KEY_UNRESOLVED_FALLBACK_USED"
  | "WEB_FETCH_FIRECRAWL_KEY_UNRESOLVED_NO_FALLBACK";

export type RuntimeWebDiagnostic = {
  code: RuntimeWebDiagnosticCode;
  message: string;
  path?: string;
};

export type RuntimeWebSearchMetadata = {
  providerConfigured?: WebSearchProvider;
  providerSource: RuntimeWebProviderSource;
  selectedProvider?: WebSearchProvider;
  selectedProviderKeySource?: SecretResolutionSource;
  perplexityTransport?: "search_api" | "chat_completions";
  diagnostics: RuntimeWebDiagnostic[];
};

export type RuntimeWebFetchFirecrawlMetadata = {
  active: boolean;
  apiKeySource: SecretResolutionSource;
  diagnostics: RuntimeWebDiagnostic[];
};

export type RuntimeWebToolsMetadata = {
  search: RuntimeWebSearchMetadata;
  fetch: {
    firecrawl: RuntimeWebFetchFirecrawlMetadata;
  };
  diagnostics: RuntimeWebDiagnostic[];
};

type FetchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { fetch?: infer Fetch }
    ? Fetch
    : undefined
  : undefined;

type SecretResolutionResult = {
  value?: string;
  source: SecretResolutionSource;
  secretRefConfigured: boolean;
  unresolvedRefReason?: string;
  fallbackEnvVar?: string;
  fallbackUsedAfterRefFailure: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeProvider(value: unknown): WebSearchProvider | undefined {
  return normalizeBuiltinWebSearchProvider(value);
}

type RegisteredSearchProviderRuntimeSupport = {
  legacyConfig: SearchProviderLegacyConfigMetadata;
  resolveRuntimeMetadata?: SearchProviderPlugin["resolveRuntimeMetadata"];
};

function resolveRegisteredSearchProviderMetadata(
  config: OpenClawConfig,
): Map<WebSearchProvider, RegisteredSearchProviderRuntimeSupport> {
  try {
    const registry = loadOpenClawPlugins({
      config,
      cache: false,
      suppressOpenAllowlistWarning: true,
    });
    return new Map(
      registry.searchProviders
        .filter(
          (
            entry,
          ): entry is typeof entry & {
            provider: typeof entry.provider & { legacyConfig: SearchProviderLegacyConfigMetadata };
          } =>
            normalizeProvider(entry.provider.id) !== undefined &&
            Boolean(entry.provider.legacyConfig),
        )
        .map((entry) => [
          entry.provider.id as WebSearchProvider,
          {
            legacyConfig: entry.provider.legacyConfig,
            resolveRuntimeMetadata: entry.provider.resolveRuntimeMetadata,
          },
        ]),
    );
  } catch {
    return new Map();
  }
}

function readNonEmptyEnvValue(
  env: NodeJS.ProcessEnv,
  names: string[],
): { value?: string; envVar?: string } {
  for (const envVar of names) {
    const value = normalizeSecretInput(env[envVar]);
    if (value) {
      return { value, envVar };
    }
  }
  return {};
}

function buildUnresolvedReason(params: {
  path: string;
  kind: "unresolved" | "non-string" | "empty";
  refLabel: string;
}): string {
  if (params.kind === "non-string") {
    return `${params.path} SecretRef resolved to a non-string value.`;
  }
  if (params.kind === "empty") {
    return `${params.path} SecretRef resolved to an empty value.`;
  }
  return `${params.path} SecretRef is unresolved (${params.refLabel}).`;
}

async function resolveSecretInputWithEnvFallback(params: {
  sourceConfig: OpenClawConfig;
  context: ResolverContext;
  defaults: SecretDefaults | undefined;
  value: unknown;
  path: string;
  envVars: string[];
}): Promise<SecretResolutionResult> {
  const { ref } = resolveSecretInputRef({
    value: params.value,
    defaults: params.defaults,
  });

  if (!ref) {
    const configValue = normalizeSecretInput(params.value);
    if (configValue) {
      return {
        value: configValue,
        source: "config",
        secretRefConfigured: false,
        fallbackUsedAfterRefFailure: false,
      };
    }
    const fallback = readNonEmptyEnvValue(params.context.env, params.envVars);
    if (fallback.value) {
      return {
        value: fallback.value,
        source: "env",
        fallbackEnvVar: fallback.envVar,
        secretRefConfigured: false,
        fallbackUsedAfterRefFailure: false,
      };
    }
    return {
      source: "missing",
      secretRefConfigured: false,
      fallbackUsedAfterRefFailure: false,
    };
  }

  const refLabel = `${ref.source}:${ref.provider}:${ref.id}`;
  let resolvedFromRef: string | undefined;
  let unresolvedRefReason: string | undefined;

  try {
    const resolved = await resolveSecretRefValues([ref], {
      config: params.sourceConfig,
      env: params.context.env,
      cache: params.context.cache,
    });
    const resolvedValue = resolved.get(secretRefKey(ref));
    if (typeof resolvedValue !== "string") {
      unresolvedRefReason = buildUnresolvedReason({
        path: params.path,
        kind: "non-string",
        refLabel,
      });
    } else {
      resolvedFromRef = normalizeSecretInput(resolvedValue);
      if (!resolvedFromRef) {
        unresolvedRefReason = buildUnresolvedReason({
          path: params.path,
          kind: "empty",
          refLabel,
        });
      }
    }
  } catch {
    unresolvedRefReason = buildUnresolvedReason({
      path: params.path,
      kind: "unresolved",
      refLabel,
    });
  }

  if (resolvedFromRef) {
    return {
      value: resolvedFromRef,
      source: "secretRef",
      secretRefConfigured: true,
      fallbackUsedAfterRefFailure: false,
    };
  }

  const fallback = readNonEmptyEnvValue(params.context.env, params.envVars);
  if (fallback.value) {
    return {
      value: fallback.value,
      source: "env",
      fallbackEnvVar: fallback.envVar,
      unresolvedRefReason,
      secretRefConfigured: true,
      fallbackUsedAfterRefFailure: true,
    };
  }

  return {
    source: "missing",
    unresolvedRefReason,
    secretRefConfigured: true,
    fallbackUsedAfterRefFailure: false,
  };
}

function ensureObject(target: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = target[key];
  if (isRecord(current)) {
    return current;
  }
  const next: Record<string, unknown> = {};
  target[key] = next;
  return next;
}

function setResolvedWebSearchApiKey(params: {
  resolvedConfig: OpenClawConfig;
  provider: WebSearchProvider;
  metadata: RegisteredSearchProviderRuntimeSupport;
  value: string;
}): void {
  const tools = ensureObject(params.resolvedConfig as Record<string, unknown>, "tools");
  const web = ensureObject(tools, "web");
  const search = ensureObject(web, "search");
  params.metadata.legacyConfig.writeApiKeyValue?.(search, params.value);
}

function setResolvedFirecrawlApiKey(params: {
  resolvedConfig: OpenClawConfig;
  value: string;
}): void {
  const tools = ensureObject(params.resolvedConfig as Record<string, unknown>, "tools");
  const web = ensureObject(tools, "web");
  const fetch = ensureObject(web, "fetch");
  const firecrawl = ensureObject(fetch, "firecrawl");
  firecrawl.apiKey = params.value;
}

function envVarsForProvider(
  metadataByProvider: Map<WebSearchProvider, RegisteredSearchProviderRuntimeSupport>,
  provider: WebSearchProvider,
): string[] {
  return [...(metadataByProvider.get(provider)?.legacyConfig.envKeys ?? [])];
}

function resolveProviderKeyValue(
  metadataByProvider: Map<WebSearchProvider, RegisteredSearchProviderRuntimeSupport>,
  search: Record<string, unknown>,
  provider: WebSearchProvider,
): unknown {
  return metadataByProvider.get(provider)?.legacyConfig.readApiKeyValue?.(search);
}

function providerConfigPath(
  metadataByProvider: Map<WebSearchProvider, RegisteredSearchProviderRuntimeSupport>,
  provider: WebSearchProvider,
): string {
  return (
    metadataByProvider.get(provider)?.legacyConfig.apiKeyConfigPath ?? "tools.web.search.provider"
  );
}

function hasConfiguredSecretRef(value: unknown, defaults: SecretDefaults | undefined): boolean {
  return Boolean(
    resolveSecretInputRef({
      value,
      defaults,
    }).ref,
  );
}

export async function resolveRuntimeWebTools(params: {
  sourceConfig: OpenClawConfig;
  resolvedConfig: OpenClawConfig;
  context: ResolverContext;
}): Promise<RuntimeWebToolsMetadata> {
  const defaults = params.sourceConfig.secrets?.defaults;
  const diagnostics: RuntimeWebDiagnostic[] = [];

  const tools = isRecord(params.sourceConfig.tools) ? params.sourceConfig.tools : undefined;
  const web = isRecord(tools?.web) ? tools.web : undefined;
  const search = isRecord(web?.search) ? web.search : undefined;
  const searchProviderMetadata = resolveRegisteredSearchProviderMetadata(params.sourceConfig);

  const searchMetadata: RuntimeWebSearchMetadata = {
    providerSource: "none",
    diagnostics: [],
  };

  const searchEnabled = search?.enabled !== false;
  const rawProvider =
    typeof search?.provider === "string" ? search.provider.trim().toLowerCase() : "";
  const configuredProvider = normalizeProvider(rawProvider);

  if (rawProvider && !configuredProvider) {
    const diagnostic: RuntimeWebDiagnostic = {
      code: "WEB_SEARCH_PROVIDER_INVALID_AUTODETECT",
      message: `tools.web.search.provider is "${rawProvider}". Falling back to auto-detect precedence.`,
      path: "tools.web.search.provider",
    };
    diagnostics.push(diagnostic);
    searchMetadata.diagnostics.push(diagnostic);
    pushWarning(params.context, {
      code: "WEB_SEARCH_PROVIDER_INVALID_AUTODETECT",
      path: "tools.web.search.provider",
      message: diagnostic.message,
    });
  }

  if (configuredProvider) {
    searchMetadata.providerConfigured = configuredProvider;
    searchMetadata.providerSource = "configured";
  }

  if (searchEnabled && search) {
    const candidates = configuredProvider
      ? [configuredProvider]
      : [...BUILTIN_WEB_SEARCH_PROVIDER_IDS];
    const unresolvedWithoutFallback: Array<{
      provider: WebSearchProvider;
      path: string;
      reason: string;
    }> = [];

    let selectedProvider: WebSearchProvider | undefined;
    let selectedResolution: SecretResolutionResult | undefined;

    for (const provider of candidates) {
      const path = providerConfigPath(searchProviderMetadata, provider);
      const value = resolveProviderKeyValue(searchProviderMetadata, search, provider);
      const resolution = await resolveSecretInputWithEnvFallback({
        sourceConfig: params.sourceConfig,
        context: params.context,
        defaults,
        value,
        path,
        envVars: envVarsForProvider(searchProviderMetadata, provider),
      });

      if (resolution.secretRefConfigured && resolution.fallbackUsedAfterRefFailure) {
        const diagnostic: RuntimeWebDiagnostic = {
          code: "WEB_SEARCH_KEY_UNRESOLVED_FALLBACK_USED",
          message:
            `${path} SecretRef could not be resolved; using ${resolution.fallbackEnvVar ?? "env fallback"}. ` +
            (resolution.unresolvedRefReason ?? "").trim(),
          path,
        };
        diagnostics.push(diagnostic);
        searchMetadata.diagnostics.push(diagnostic);
        pushWarning(params.context, {
          code: "WEB_SEARCH_KEY_UNRESOLVED_FALLBACK_USED",
          path,
          message: diagnostic.message,
        });
      }

      if (resolution.secretRefConfigured && !resolution.value && resolution.unresolvedRefReason) {
        unresolvedWithoutFallback.push({
          provider,
          path,
          reason: resolution.unresolvedRefReason,
        });
      }

      if (configuredProvider) {
        selectedProvider = provider;
        selectedResolution = resolution;
        if (resolution.value) {
          const metadata = searchProviderMetadata.get(provider);
          setResolvedWebSearchApiKey({
            resolvedConfig: params.resolvedConfig,
            provider,
            metadata: metadata ?? { legacyConfig: {} },
            value: resolution.value,
          });
        }
        break;
      }

      if (resolution.value) {
        selectedProvider = provider;
        selectedResolution = resolution;
        const metadata = searchProviderMetadata.get(provider);
        setResolvedWebSearchApiKey({
          resolvedConfig: params.resolvedConfig,
          provider,
          metadata: metadata ?? { legacyConfig: {} },
          value: resolution.value,
        });
        break;
      }
    }

    const failUnresolvedSearchNoFallback = (unresolved: { path: string; reason: string }) => {
      const diagnostic: RuntimeWebDiagnostic = {
        code: "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
        message: unresolved.reason,
        path: unresolved.path,
      };
      diagnostics.push(diagnostic);
      searchMetadata.diagnostics.push(diagnostic);
      pushWarning(params.context, {
        code: "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
        path: unresolved.path,
        message: unresolved.reason,
      });
      throw new Error(`[WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK] ${unresolved.reason}`);
    };

    if (configuredProvider) {
      const unresolved = unresolvedWithoutFallback[0];
      if (unresolved) {
        failUnresolvedSearchNoFallback(unresolved);
      }
    } else {
      if (!selectedProvider && unresolvedWithoutFallback.length > 0) {
        failUnresolvedSearchNoFallback(unresolvedWithoutFallback[0]);
      }

      if (selectedProvider) {
        const diagnostic: RuntimeWebDiagnostic = {
          code: "WEB_SEARCH_AUTODETECT_SELECTED",
          message: `tools.web.search auto-detected provider "${selectedProvider}" from available credentials.`,
          path: "tools.web.search.provider",
        };
        diagnostics.push(diagnostic);
        searchMetadata.diagnostics.push(diagnostic);
      }
    }

    if (selectedProvider) {
      searchMetadata.selectedProvider = selectedProvider;
      searchMetadata.selectedProviderKeySource = selectedResolution?.source;
      if (!configuredProvider) {
        searchMetadata.providerSource = "auto-detect";
      }
      const runtimeMetadata = searchProviderMetadata
        .get(selectedProvider)
        ?.resolveRuntimeMetadata?.({
          search,
          keyValue: selectedResolution?.value,
          keySource: selectedResolution?.source ?? "missing",
          fallbackEnvVar: selectedResolution?.fallbackEnvVar,
        });
      const perplexityTransport =
        runtimeMetadata && typeof runtimeMetadata.perplexityTransport === "string"
          ? runtimeMetadata.perplexityTransport
          : undefined;
      if (perplexityTransport === "search_api" || perplexityTransport === "chat_completions") {
        searchMetadata.perplexityTransport = perplexityTransport;
      }
    }
  }

  if (searchEnabled && search && !configuredProvider && searchMetadata.selectedProvider) {
    for (const provider of BUILTIN_WEB_SEARCH_PROVIDER_IDS) {
      if (provider === searchMetadata.selectedProvider) {
        continue;
      }
      const path = providerConfigPath(searchProviderMetadata, provider);
      const value = resolveProviderKeyValue(searchProviderMetadata, search, provider);
      if (!hasConfiguredSecretRef(value, defaults)) {
        continue;
      }
      pushInactiveSurfaceWarning({
        context: params.context,
        path,
        details: `tools.web.search auto-detected provider is "${searchMetadata.selectedProvider}".`,
      });
    }
  } else if (search && !searchEnabled) {
    for (const provider of BUILTIN_WEB_SEARCH_PROVIDER_IDS) {
      const path = providerConfigPath(searchProviderMetadata, provider);
      const value = resolveProviderKeyValue(searchProviderMetadata, search, provider);
      if (!hasConfiguredSecretRef(value, defaults)) {
        continue;
      }
      pushInactiveSurfaceWarning({
        context: params.context,
        path,
        details: "tools.web.search is disabled.",
      });
    }
  }

  if (searchEnabled && search && configuredProvider) {
    for (const provider of BUILTIN_WEB_SEARCH_PROVIDER_IDS) {
      if (provider === configuredProvider) {
        continue;
      }
      const path = providerConfigPath(searchProviderMetadata, provider);
      const value = resolveProviderKeyValue(searchProviderMetadata, search, provider);
      if (!hasConfiguredSecretRef(value, defaults)) {
        continue;
      }
      pushInactiveSurfaceWarning({
        context: params.context,
        path,
        details: `tools.web.search.provider is "${configuredProvider}".`,
      });
    }
  }

  const fetch = isRecord(web?.fetch) ? (web.fetch as FetchConfig) : undefined;
  const firecrawl = isRecord(fetch?.firecrawl) ? fetch.firecrawl : undefined;
  const fetchEnabled = fetch?.enabled !== false;
  const firecrawlEnabled = firecrawl?.enabled !== false;
  const firecrawlActive = Boolean(fetchEnabled && firecrawlEnabled);
  const firecrawlPath = "tools.web.fetch.firecrawl.apiKey";
  let firecrawlResolution: SecretResolutionResult = {
    source: "missing",
    secretRefConfigured: false,
    fallbackUsedAfterRefFailure: false,
  };

  const firecrawlDiagnostics: RuntimeWebDiagnostic[] = [];

  if (firecrawlActive) {
    firecrawlResolution = await resolveSecretInputWithEnvFallback({
      sourceConfig: params.sourceConfig,
      context: params.context,
      defaults,
      value: firecrawl?.apiKey,
      path: firecrawlPath,
      envVars: ["FIRECRAWL_API_KEY"],
    });

    if (firecrawlResolution.value) {
      setResolvedFirecrawlApiKey({
        resolvedConfig: params.resolvedConfig,
        value: firecrawlResolution.value,
      });
    }

    if (firecrawlResolution.secretRefConfigured) {
      if (firecrawlResolution.fallbackUsedAfterRefFailure) {
        const diagnostic: RuntimeWebDiagnostic = {
          code: "WEB_FETCH_FIRECRAWL_KEY_UNRESOLVED_FALLBACK_USED",
          message:
            `${firecrawlPath} SecretRef could not be resolved; using ${firecrawlResolution.fallbackEnvVar ?? "env fallback"}. ` +
            (firecrawlResolution.unresolvedRefReason ?? "").trim(),
          path: firecrawlPath,
        };
        diagnostics.push(diagnostic);
        firecrawlDiagnostics.push(diagnostic);
        pushWarning(params.context, {
          code: "WEB_FETCH_FIRECRAWL_KEY_UNRESOLVED_FALLBACK_USED",
          path: firecrawlPath,
          message: diagnostic.message,
        });
      }

      if (!firecrawlResolution.value && firecrawlResolution.unresolvedRefReason) {
        const diagnostic: RuntimeWebDiagnostic = {
          code: "WEB_FETCH_FIRECRAWL_KEY_UNRESOLVED_NO_FALLBACK",
          message: firecrawlResolution.unresolvedRefReason,
          path: firecrawlPath,
        };
        diagnostics.push(diagnostic);
        firecrawlDiagnostics.push(diagnostic);
        pushWarning(params.context, {
          code: "WEB_FETCH_FIRECRAWL_KEY_UNRESOLVED_NO_FALLBACK",
          path: firecrawlPath,
          message: firecrawlResolution.unresolvedRefReason,
        });
        throw new Error(
          `[WEB_FETCH_FIRECRAWL_KEY_UNRESOLVED_NO_FALLBACK] ${firecrawlResolution.unresolvedRefReason}`,
        );
      }
    }
  } else {
    if (hasConfiguredSecretRef(firecrawl?.apiKey, defaults)) {
      pushInactiveSurfaceWarning({
        context: params.context,
        path: firecrawlPath,
        details: !fetchEnabled
          ? "tools.web.fetch is disabled."
          : "tools.web.fetch.firecrawl.enabled is false.",
      });
      firecrawlResolution = {
        source: "secretRef",
        secretRefConfigured: true,
        fallbackUsedAfterRefFailure: false,
      };
    } else {
      const configuredInlineValue = normalizeSecretInput(firecrawl?.apiKey);
      if (configuredInlineValue) {
        firecrawlResolution = {
          value: configuredInlineValue,
          source: "config",
          secretRefConfigured: false,
          fallbackUsedAfterRefFailure: false,
        };
      } else {
        const envFallback = readNonEmptyEnvValue(params.context.env, ["FIRECRAWL_API_KEY"]);
        if (envFallback.value) {
          firecrawlResolution = {
            value: envFallback.value,
            source: "env",
            fallbackEnvVar: envFallback.envVar,
            secretRefConfigured: false,
            fallbackUsedAfterRefFailure: false,
          };
        }
      }
    }
  }

  return {
    search: searchMetadata,
    fetch: {
      firecrawl: {
        active: firecrawlActive,
        apiKeySource: firecrawlResolution.source,
        diagnostics: firecrawlDiagnostics,
      },
    },
    diagnostics,
  };
}
