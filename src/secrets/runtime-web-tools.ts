import {
  type AuthProfileStore,
  loadAuthProfileStoreForSecretsRuntime,
  resolveAuthProfileOrder,
  type AuthProfileCredential,
} from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
import { secretRefKey } from "./ref-contract.js";
import { resolveSecretRefValues } from "./resolve.js";
import {
  pushInactiveSurfaceWarning,
  pushWarning,
  type ResolverContext,
  type SecretDefaults,
} from "./runtime-shared.js";

const WEB_SEARCH_PROVIDERS = ["brave", "gemini", "grok", "kimi", "minimax", "perplexity"] as const;
const PERPLEXITY_DIRECT_BASE_URL = "https://api.perplexity.ai";
const DEFAULT_PERPLEXITY_BASE_URL = "https://openrouter.ai/api/v1";
const PERPLEXITY_KEY_PREFIXES = ["pplx-"];
const OPENROUTER_KEY_PREFIXES = ["sk-or-"];
const MINIMAX_AUTH_PROFILE_PROVIDERS = ["minimax-portal", "minimax-cn", "minimax"] as const;
type MinimaxAuthProfileProvider = (typeof MINIMAX_AUTH_PROFILE_PROVIDERS)[number];
const MINIMAX_DEFAULT_API_HOST_BY_PROVIDER: Record<MinimaxAuthProfileProvider, string> = {
  minimax: "https://api.minimax.io",
  "minimax-portal": "https://api.minimax.io",
  "minimax-cn": "https://api.minimaxi.com",
};

type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

type SecretResolutionSource = "config" | "secretRef" | "env" | "auth_profile" | "missing"; // pragma: allowlist secret
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
  minimaxApiHost?: string;
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

type AuthStoreLoader = (agentDir?: string) => AuthProfileStore;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeProvider(value: unknown): WebSearchProvider | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "brave" ||
    normalized === "gemini" ||
    normalized === "grok" ||
    normalized === "kimi" ||
    normalized === "minimax" ||
    normalized === "perplexity"
  ) {
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
}): void {
  const tools = ensureObject(params.resolvedConfig as Record<string, unknown>, "tools");
  const web = ensureObject(tools, "web");
  const search = ensureObject(web, "search");
  if (params.provider === "brave") {
    search.apiKey = params.value;
    return;
  }
  const providerConfig = ensureObject(search, params.provider);
  providerConfig.apiKey = params.value;
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

function envVarsForProvider(provider: WebSearchProvider): string[] {
  if (provider === "brave") {
    return ["BRAVE_API_KEY"];
  }
  if (provider === "gemini") {
    return ["GEMINI_API_KEY"];
  }
  if (provider === "grok") {
    return ["XAI_API_KEY"];
  }
  if (provider === "kimi") {
    return ["KIMI_API_KEY", "MOONSHOT_API_KEY"];
  }
  if (provider === "minimax") {
    return ["MINIMAX_OAUTH_TOKEN", "MINIMAX_API_KEY"];
  }
  return ["PERPLEXITY_API_KEY", "OPENROUTER_API_KEY"];
}

function resolveProviderKeyValue(
  search: Record<string, unknown>,
  provider: WebSearchProvider,
): unknown {
  if (provider === "brave") {
    return search.apiKey;
  }
  const scoped = search[provider];
  if (!isRecord(scoped)) {
    return undefined;
  }
  return scoped.apiKey;
}

function resolveMinimaxBaseUrlValue(search: Record<string, unknown>): unknown {
  const scoped = search["minimax"];
  if (!isRecord(scoped)) {
    return undefined;
  }
  return scoped.baseUrl;
}

function setResolvedWebSearchMinimaxBaseUrl(params: {
  resolvedConfig: OpenClawConfig;
  value: string;
}): void {
  const tools = ensureObject(params.resolvedConfig as Record<string, unknown>, "tools");
  const web = ensureObject(tools, "web");
  const search = ensureObject(web, "search");
  const minimax = ensureObject(search, "minimax");
  minimax.baseUrl = params.value;
}

function normalizeUrlOrigin(raw: string | undefined): string | undefined {
  const trimmed = normalizeSecretInput(raw);
  if (!trimmed) {
    return undefined;
  }
  try {
    return new URL(trimmed).origin;
  } catch {
    // Not a full URL yet; retry below by prefixing "https://".
  }
  try {
    return new URL(`https://${trimmed}`).origin;
  } catch {
    return undefined;
  }
}

function resolveMinimaxApiHostFromProfile(params: {
  sourceConfig: OpenClawConfig;
  profileProvider: MinimaxAuthProfileProvider;
}): string {
  const providers = isRecord(params.sourceConfig.models?.providers)
    ? (params.sourceConfig.models.providers as Record<string, unknown>)
    : undefined;
  const provider = providers?.[params.profileProvider];
  if (isRecord(provider)) {
    const configured = normalizeUrlOrigin(
      typeof provider.baseUrl === "string" ? provider.baseUrl : undefined,
    );
    if (configured) {
      return configured;
    }
  }
  return MINIMAX_DEFAULT_API_HOST_BY_PROVIDER[params.profileProvider];
}

export async function resolveMinimaxApiKeyFromAuthProfiles(params: {
  sourceConfig: OpenClawConfig;
  context: ResolverContext;
  loadAuthStore?: AuthStoreLoader;
}): Promise<
  { apiKey: string; profileProvider: MinimaxAuthProfileProvider; apiHost: string } | undefined
> {
  const loadAuthStore = params.loadAuthStore ?? loadAuthProfileStoreForSecretsRuntime;
  let store: AuthProfileStore;
  try {
    store = loadAuthStore(params.context.env.OPENCLAW_AGENT_DIR);
  } catch {
    return undefined;
  }

  const visited = new Set<string>();
  for (const provider of MINIMAX_AUTH_PROFILE_PROVIDERS) {
    const profileIds = resolveAuthProfileOrder({
      cfg: params.sourceConfig,
      store,
      provider,
    });
    for (const profileId of profileIds) {
      if (visited.has(profileId)) {
        continue;
      }
      visited.add(profileId);
      try {
        const credential = store.profiles[profileId];
        const value = await resolveMinimaxCredentialValueReadOnly({
          credential,
          sourceConfig: params.sourceConfig,
          context: params.context,
        });
        if (value) {
          return {
            apiKey: value,
            profileProvider: provider,
            apiHost: resolveMinimaxApiHostFromProfile({
              sourceConfig: params.sourceConfig,
              profileProvider: provider,
            }),
          };
        }
      } catch {
        // Ignore profile-specific failures and continue probing next profile.
      }
    }
  }

  return undefined;
}

async function resolveProfileSecretValueReadOnly(params: {
  sourceConfig: OpenClawConfig;
  context: ResolverContext;
  value: unknown;
  refValue?: unknown;
}): Promise<string | undefined> {
  const { ref } = resolveSecretInputRef({
    value: params.value,
    refValue: params.refValue,
    defaults: params.sourceConfig.secrets?.defaults,
  });
  if (!ref) {
    return normalizeSecretInput(params.value);
  }

  try {
    const resolved = await resolveSecretRefValues([ref], {
      config: params.sourceConfig,
      env: params.context.env,
      cache: params.context.cache,
    });
    const resolvedValue = resolved.get(secretRefKey(ref));
    return typeof resolvedValue === "string" ? normalizeSecretInput(resolvedValue) : undefined;
  } catch {
    return undefined;
  }
}

async function resolveMinimaxCredentialValueReadOnly(params: {
  credential: AuthProfileCredential | undefined;
  sourceConfig: OpenClawConfig;
  context: ResolverContext;
}): Promise<string | undefined> {
  const credential = params.credential;
  if (!credential) {
    return undefined;
  }

  if (credential.type === "oauth") {
    const expires = typeof credential.expires === "number" ? credential.expires : undefined;
    if (expires === undefined || Date.now() >= expires) {
      return undefined;
    }
    return normalizeSecretInput(credential.access);
  }

  if (credential.type === "token") {
    const expires = typeof credential.expires === "number" ? credential.expires : undefined;
    if (expires !== undefined && Date.now() >= expires) {
      return undefined;
    }
    return resolveProfileSecretValueReadOnly({
      sourceConfig: params.sourceConfig,
      context: params.context,
      value: credential.token,
      refValue: credential.tokenRef,
    });
  }

  if (credential.type === "api_key") {
    return resolveProfileSecretValueReadOnly({
      sourceConfig: params.sourceConfig,
      context: params.context,
      value: credential.key,
      refValue: credential.keyRef,
    });
  }

  return undefined;
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
  loadAuthStore?: AuthStoreLoader;
}): Promise<RuntimeWebToolsMetadata> {
  const defaults = params.sourceConfig.secrets?.defaults;
  const diagnostics: RuntimeWebDiagnostic[] = [];

  const tools = isRecord(params.sourceConfig.tools) ? params.sourceConfig.tools : undefined;
  const web = isRecord(tools?.web) ? tools.web : undefined;
  const search = isRecord(web?.search) ? web.search : undefined;

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
    const runtimeMinimaxApiHost = normalizeUrlOrigin(params.context.env.MINIMAX_API_HOST);
    if (runtimeMinimaxApiHost) {
      searchMetadata.minimaxApiHost = runtimeMinimaxApiHost;
      setResolvedWebSearchMinimaxBaseUrl({
        resolvedConfig: params.resolvedConfig,
        value: runtimeMinimaxApiHost,
      });
    }

    const candidates = configuredProvider
      ? [
          configuredProvider,
          ...WEB_SEARCH_PROVIDERS.filter((provider) => provider !== configuredProvider),
        ]
      : [...WEB_SEARCH_PROVIDERS];
    const unresolvedWithoutFallback: Array<{
      provider: WebSearchProvider;
      path: string;
      reason: string;
    }> = [];

    let selectedProvider: WebSearchProvider | undefined;
    let selectedResolution: SecretResolutionResult | undefined;

    for (const provider of candidates) {
      const path =
        provider === "brave" ? "tools.web.search.apiKey" : `tools.web.search.${provider}.apiKey`;
      const value = resolveProviderKeyValue(search, provider);
      let resolution = await resolveSecretInputWithEnvFallback({
        sourceConfig: params.sourceConfig,
        context: params.context,
        defaults,
        value,
        path,
        envVars: envVarsForProvider(provider),
      });

      if (provider === "minimax" && !resolution.value) {
        const authProfileMatch = await resolveMinimaxApiKeyFromAuthProfiles({
          sourceConfig: params.sourceConfig,
          context: params.context,
          loadAuthStore: params.loadAuthStore,
        });
        if (authProfileMatch) {
          resolution = {
            ...resolution,
            value: authProfileMatch.apiKey,
            source: "auth_profile",
          };
          const hasConfiguredMinimaxBaseUrl = Boolean(
            normalizeSecretInput(resolveMinimaxBaseUrlValue(search)),
          );
          if (!hasConfiguredMinimaxBaseUrl) {
            setResolvedWebSearchMinimaxBaseUrl({
              resolvedConfig: params.resolvedConfig,
              value: authProfileMatch.apiHost,
            });
          }
        }
      }

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

      if (resolution.value) {
        selectedProvider = provider;
        selectedResolution = resolution;
        setResolvedWebSearchApiKey({
          resolvedConfig: params.resolvedConfig,
          provider,
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
    }

    if (configuredProvider && selectedProvider && selectedProvider !== configuredProvider) {
      const diagnostic: RuntimeWebDiagnostic = {
        code: "WEB_SEARCH_AUTODETECT_SELECTED",
        message: `tools.web.search.provider is "${configuredProvider}" but no usable credentials were found. Falling back to "${selectedProvider}".`,
        path: "tools.web.search.provider",
      };
      diagnostics.push(diagnostic);
      searchMetadata.diagnostics.push(diagnostic);
    } else if (!configuredProvider && selectedProvider) {
      const diagnostic: RuntimeWebDiagnostic = {
        code: "WEB_SEARCH_AUTODETECT_SELECTED",
        message: `tools.web.search auto-detected provider "${selectedProvider}" from available credentials.`,
        path: "tools.web.search.provider",
      };
      diagnostics.push(diagnostic);
      searchMetadata.diagnostics.push(diagnostic);
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

  if (searchEnabled && search && searchMetadata.selectedProvider) {
    for (const provider of WEB_SEARCH_PROVIDERS) {
      if (provider === searchMetadata.selectedProvider) {
        continue;
      }
      const path =
        provider === "brave" ? "tools.web.search.apiKey" : `tools.web.search.${provider}.apiKey`;
      const value = resolveProviderKeyValue(search, provider);
      if (!hasConfiguredSecretRef(value, defaults)) {
        continue;
      }
      pushInactiveSurfaceWarning({
        context: params.context,
        path,
        details: `tools.web.search selected provider is "${searchMetadata.selectedProvider}".`,
      });
    }
  } else if (search && !searchEnabled) {
    for (const provider of WEB_SEARCH_PROVIDERS) {
      const path =
        provider === "brave" ? "tools.web.search.apiKey" : `tools.web.search.${provider}.apiKey`;
      const value = resolveProviderKeyValue(search, provider);
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

  if (searchEnabled && search && configuredProvider && !searchMetadata.selectedProvider) {
    for (const provider of WEB_SEARCH_PROVIDERS) {
      if (provider === configuredProvider) {
        continue;
      }
      const path =
        provider === "brave" ? "tools.web.search.apiKey" : `tools.web.search.${provider}.apiKey`;
      const value = resolveProviderKeyValue(search, provider);
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
