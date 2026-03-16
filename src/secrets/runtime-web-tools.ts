import type { OpenClawConfig } from "../config/config.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { resolvePluginWebSearchProviders } from "../plugins/web-search-providers.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
import { secretRefKey } from "./ref-contract.js";
import { resolveSecretRefValues } from "./resolve.js";
import {
  pushInactiveSurfaceWarning,
  pushWarning,
  type ResolverContext,
  type SecretDefaults,
} from "./runtime-shared.js";
import type {
  RuntimeWebDiagnostic,
  RuntimeWebDiagnosticCode,
  RuntimeWebFetchFirecrawlMetadata,
  RuntimeWebSearchMetadata,
  RuntimeWebToolsMetadata,
} from "./runtime-web-tools.types.js";

const PERPLEXITY_DIRECT_BASE_URL = "https://api.perplexity.ai";
const DEFAULT_PERPLEXITY_BASE_URL = "https://openrouter.ai/api/v1";
const PERPLEXITY_KEY_PREFIXES = ["pplx-"];
const OPENROUTER_KEY_PREFIXES = ["sk-or-"];

type WebSearchProvider = string;

type SecretResolutionSource = "config" | "secretRef" | "env" | "missing"; // pragma: allowlist secret
export type {
  RuntimeWebDiagnostic,
  RuntimeWebDiagnosticCode,
  RuntimeWebFetchFirecrawlMetadata,
  RuntimeWebSearchMetadata,
  RuntimeWebToolsMetadata,
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

function normalizeProvider(
  value: unknown,
  providers: ReturnType<typeof resolvePluginWebSearchProviders>,
): WebSearchProvider | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (providers.some((provider) => provider.id === normalized)) {
    return normalized;
  }
  return undefined;
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

function inferPerplexityBaseUrlFromApiKey(apiKey?: string): "direct" | "openrouter" | undefined {
  if (!apiKey) {
    return undefined;
  }
  const normalized = apiKey.toLowerCase();
  if (PERPLEXITY_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "direct";
  }
  if (OPENROUTER_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "openrouter";
  }
  return undefined;
}

function resolvePerplexityRuntimeTransport(params: {
  keyValue?: string;
  keySource: SecretResolutionSource;
  fallbackEnvVar?: string;
  configValue: unknown;
}): "search_api" | "chat_completions" | undefined {
  const config = isRecord(params.configValue) ? params.configValue : undefined;
  const configuredBaseUrl = typeof config?.baseUrl === "string" ? config.baseUrl.trim() : "";
  const configuredModel = typeof config?.model === "string" ? config.model.trim() : "";

  const baseUrl = (() => {
    if (configuredBaseUrl) {
      return configuredBaseUrl;
    }
    if (params.keySource === "env") {
      if (params.fallbackEnvVar === "PERPLEXITY_API_KEY") {
        return PERPLEXITY_DIRECT_BASE_URL;
      }
      if (params.fallbackEnvVar === "OPENROUTER_API_KEY") {
        return DEFAULT_PERPLEXITY_BASE_URL;
      }
    }
    if ((params.keySource === "config" || params.keySource === "secretRef") && params.keyValue) {
      const inferred = inferPerplexityBaseUrlFromApiKey(params.keyValue);
      return inferred === "openrouter" ? DEFAULT_PERPLEXITY_BASE_URL : PERPLEXITY_DIRECT_BASE_URL;
    }
    return DEFAULT_PERPLEXITY_BASE_URL;
  })();

  const hasLegacyOverride = Boolean(configuredBaseUrl || configuredModel);
  const direct = (() => {
    try {
      return new URL(baseUrl).hostname.toLowerCase() === "api.perplexity.ai";
    } catch {
      return false;
    }
  })();
  return hasLegacyOverride || !direct ? "chat_completions" : "search_api";
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
  value: string;
  sourceConfig: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): void {
  const tools = ensureObject(params.resolvedConfig as Record<string, unknown>, "tools");
  const web = ensureObject(tools, "web");
  const search = ensureObject(web, "search");
  const provider = resolvePluginWebSearchProviders({
    config: params.sourceConfig,
    env: params.env,
    bundledAllowlistCompat: true,
  }).find((entry) => entry.id === params.provider);
  provider?.setCredentialValue(search, params.value);
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

function keyPathForProvider(provider: WebSearchProvider): string {
  return provider === "brave" ? "tools.web.search.apiKey" : `tools.web.search.${provider}.apiKey`;
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
  const providers = resolvePluginWebSearchProviders({
    config: params.sourceConfig,
    env: params.context.env,
    bundledAllowlistCompat: true,
  });

  const searchMetadata: RuntimeWebSearchMetadata = {
    providerSource: "none",
    diagnostics: [],
  };

  const searchEnabled = search?.enabled !== false;
  const rawProvider =
    typeof search?.provider === "string" ? search.provider.trim().toLowerCase() : "";
  const configuredProvider = normalizeProvider(rawProvider, providers);

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
      ? providers.filter((provider) => provider.id === configuredProvider)
      : providers;
    const unresolvedWithoutFallback: Array<{
      provider: WebSearchProvider;
      path: string;
      reason: string;
    }> = [];

    let selectedProvider: WebSearchProvider | undefined;
    let selectedResolution: SecretResolutionResult | undefined;

    for (const provider of candidates) {
      const path = keyPathForProvider(provider.id);
      const value = provider.getCredentialValue(search);
      const resolution = await resolveSecretInputWithEnvFallback({
        sourceConfig: params.sourceConfig,
        context: params.context,
        defaults,
        value,
        path,
        envVars: provider.envVars,
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
          provider: provider.id,
          path,
          reason: resolution.unresolvedRefReason,
        });
      }

      if (configuredProvider) {
        selectedProvider = provider.id;
        selectedResolution = resolution;
        if (resolution.value) {
          setResolvedWebSearchApiKey({
            resolvedConfig: params.resolvedConfig,
            provider: provider.id,
            value: resolution.value,
            sourceConfig: params.sourceConfig,
            env: params.context.env,
          });
        }
        break;
      }

      if (resolution.value) {
        selectedProvider = provider.id;
        selectedResolution = resolution;
        setResolvedWebSearchApiKey({
          resolvedConfig: params.resolvedConfig,
          provider: provider.id,
          value: resolution.value,
          sourceConfig: params.sourceConfig,
          env: params.context.env,
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
      if (selectedProvider === "perplexity") {
        searchMetadata.perplexityTransport = resolvePerplexityRuntimeTransport({
          keyValue: selectedResolution?.value,
          keySource: selectedResolution?.source ?? "missing",
          fallbackEnvVar: selectedResolution?.fallbackEnvVar,
          configValue: search.perplexity,
        });
      }
    }
  }

  if (searchEnabled && search && !configuredProvider && searchMetadata.selectedProvider) {
    for (const provider of providers) {
      if (provider.id === searchMetadata.selectedProvider) {
        continue;
      }
      const path = keyPathForProvider(provider.id);
      const value = provider.getCredentialValue(search);
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
    for (const provider of providers) {
      const path = keyPathForProvider(provider.id);
      const value = provider.getCredentialValue(search);
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
    for (const provider of providers) {
      if (provider.id === configuredProvider) {
        continue;
      }
      const path = keyPathForProvider(provider.id);
      const value = provider.getCredentialValue(search);
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
