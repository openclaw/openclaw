import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveDefaultAgentDir } from "../agents/agent-scope-config.js";
import { authProfileRuntimeMode } from "../agents/auth-profiles/runtime-scope.js";
import { getRuntimeAuthProfileStoreSnapshotCore } from "../agents/auth-profiles/runtime-snapshots.js";
import { ensureAuthProfileStoreWithoutExternalProfilesAsync } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { hasAuthProfileForProvider } from "../agents/tools/model-config.helpers.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  selectApplicableRuntimeConfig,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import { logVerbose } from "../globals.js";
import { withGuardedFetchRequestAuthority } from "../infra/net/fetch-request-authority.js";
import { sortPluginEntriesForAutoDetect } from "../plugins/plugin-entry-order.js";
import { resolveManifestContractOwnerPluginId } from "../plugins/plugin-registry-contributions.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";
import {
  resolvePluginWebSearchProviders,
  resolveRuntimeWebSearchProviders,
} from "../plugins/web-search-providers.runtime.js";
import { getActiveRuntimeWebToolsMetadataFromState } from "../secrets/runtime-web-tools-state.js";
import type { RuntimeWebSearchMetadata } from "../secrets/runtime-web-tools.types.js";
import {
  hasWebProviderEntryCredential,
  providerRequiresCredential,
  readWebProviderEnvValue,
  resolveWebProviderConfig,
  type WebProviderWithCredential,
} from "../web/provider-runtime-shared.js";
import { executeWebSearchCandidates } from "./runtime-execution.js";
import type {
  ResolveWebSearchDefinitionParams,
  RunWebSearchParams,
  RunWebSearchResult,
  RuntimeWebSearchConfig as WebSearchConfig,
} from "./runtime-types.js";

function resolveSearchConfig(cfg?: OpenClawConfig): WebSearchConfig {
  return resolveWebProviderConfig(cfg, "search") as NonNullable<WebSearchConfig> | undefined;
}

function resolveWebSearchRuntimeConfig(params?: {
  config?: OpenClawConfig;
  preferInputConfig?: boolean;
}): OpenClawConfig | undefined {
  if (params?.preferInputConfig && params.config) {
    return params.config;
  }
  return selectApplicableRuntimeConfig({
    inputConfig: params?.config,
    runtimeConfig: getRuntimeConfigSnapshot(),
    runtimeSourceConfig: getRuntimeConfigSourceSnapshot(),
  });
}

function hasEntryCredential(
  provider: WebProviderWithCredential,
  config: OpenClawConfig | undefined,
  agentDir?: string,
  authStore?: AuthProfileStore,
  resolveAuthProfileStoreSource?: () => boolean,
): boolean {
  return hasWebProviderEntryCredential({
    provider,
    config,
    resolveEnvValue: (configuredEnvVarId) =>
      (configuredEnvVarId ? readWebProviderEnvValue([configuredEnvVarId]) : undefined) ??
      readWebProviderEnvValue(provider.envVars),
    resolveProviderAuthValue: (providerId) => {
      if (!authStore) {
        resolveAuthProfileStoreSource?.();
      }
      return hasAuthProfileForProvider({
        provider: providerId,
        authStore,
        authProfileStoreSource: resolveAuthProfileStoreSource?.(),
        agentDir:
          agentDir?.trim() || (authStore ? undefined : resolveDefaultAgentDir(config ?? {})),
      });
    },
  });
}

function hasImplicitProviderSelectionSignal(
  provider: Parameters<typeof hasEntryCredential>[0],
  config: OpenClawConfig | undefined,
  agentDir?: string,
  authStore?: AuthProfileStore,
  resolveAuthProfileStoreSource?: () => boolean,
): boolean {
  if (!providerRequiresCredential(provider)) {
    return false;
  }
  return hasEntryCredential(provider, config, agentDir, authStore, resolveAuthProfileStoreSource);
}

export function isWebSearchProviderConfigured(params: {
  provider: Pick<
    PluginWebSearchProviderEntry,
    | "credentialPath"
    | "id"
    | "authProviderId"
    | "envVars"
    | "getConfiguredCredentialValue"
    | "getConfiguredCredentialFallback"
    | "getCredentialValue"
    | "requiresCredential"
  >;
  config?: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
}): boolean {
  const config = resolveWebSearchRuntimeConfig({ config: params.config });
  return hasEntryCredential(params.provider, config, params.agentDir, params.authStore);
}

/** Lists runtime web_search providers after applying runtime config snapshots. */
export function listWebSearchProviders(params?: {
  config?: OpenClawConfig;
}): PluginWebSearchProviderEntry[] {
  const config = resolveWebSearchRuntimeConfig({ config: params?.config });
  return resolveRuntimeWebSearchProviders({
    config,
  });
}

/** Lists plugin-configured web_search providers without runtime-only providers. */
export function listConfiguredWebSearchProviders(params?: {
  config?: OpenClawConfig;
}): PluginWebSearchProviderEntry[] {
  const config = resolveWebSearchRuntimeConfig({ config: params?.config });
  return resolvePluginWebSearchProviders({
    config,
  });
}

export function resolveWebSearchProviderId(params: {
  search?: WebSearchConfig;
  config?: OpenClawConfig;
  agentDir?: string;
  providers?: PluginWebSearchProviderEntry[];
  authStore?: AuthProfileStore;
  resolveAuthProfileStoreSource?: () => boolean;
  onAutoDetection?: (message: string) => void;
}): string {
  const config = resolveWebSearchRuntimeConfig({ config: params.config });
  const search = params.search ?? resolveSearchConfig(config);
  const providers = sortPluginEntriesForAutoDetect(
    params.providers ??
      resolvePluginWebSearchProviders({
        config,
      }),
  );
  const raw =
    search && "provider" in search ? normalizeLowercaseStringOrEmpty(search.provider) : "";

  if (raw) {
    const explicit = providers.find((provider) => provider.id === raw);
    if (explicit) {
      return explicit.id;
    }
  }

  if (!raw) {
    for (const provider of providers) {
      if (
        !hasImplicitProviderSelectionSignal(
          provider,
          config,
          params.agentDir,
          params.authStore,
          params.resolveAuthProfileStoreSource,
        )
      ) {
        continue;
      }
      (params.onAutoDetection ?? logVerbose)(
        `web_search: no provider configured, auto-detected "${provider.id}" from available credentials`,
      );
      return provider.id;
    }
  }

  return "";
}

function resolveRuntimePreferredWebSearchProviderId(params: {
  config?: OpenClawConfig;
  search?: WebSearchConfig;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
  providers?: PluginWebSearchProviderEntry[];
  agentDir?: string;
  authStore?: AuthProfileStore;
  resolveAuthProfileStoreSource?: () => boolean;
}): string | undefined {
  const runtimeProviderId = normalizeOptionalLowercaseString(
    params.runtimeWebSearch?.selectedProvider ?? params.runtimeWebSearch?.providerConfigured,
  );
  if (!runtimeProviderId) {
    return undefined;
  }
  const configuredProviderId =
    params.search && "provider" in params.search
      ? normalizeOptionalLowercaseString(params.search.provider)
      : undefined;
  if (configuredProviderId) {
    const configuredProvider = params.providers?.find((entry) => entry.id === configuredProviderId);
    return configuredProvider?.id === runtimeProviderId ? runtimeProviderId : undefined;
  }
  if (params.runtimeWebSearch?.providerSource === "configured") {
    return runtimeProviderId;
  }
  const provider = params.providers?.find((entry) => entry.id === runtimeProviderId);
  if (
    !provider ||
    !hasImplicitProviderSelectionSignal(
      provider,
      params.config,
      params.agentDir,
      params.authStore,
      params.resolveAuthProfileStoreSource,
    )
  ) {
    return undefined;
  }
  // The secrets snapshot cannot see OAuth profiles. Let the credential-aware
  // order choose ahead of its env-keyed winner, which remains eligible for fallback.
  if (params.runtimeWebSearch?.selectedProviderKeySource === "env") {
    return undefined;
  }
  return provider.id;
}

type WebSearchRequestContext = {
  config?: OpenClawConfig;
  search?: WebSearchConfig;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
};

function resolveWebSearchRequestContext(
  options?: Pick<
    ResolveWebSearchDefinitionParams,
    "config" | "preferInputConfig" | "runtimeWebSearch"
  >,
): WebSearchRequestContext {
  const config = resolveWebSearchRuntimeConfig({
    config: options?.config,
    preferInputConfig: options?.preferInputConfig,
  });
  return {
    config,
    search: resolveSearchConfig(config),
    runtimeWebSearch:
      options?.runtimeWebSearch ?? getActiveRuntimeWebToolsMetadataFromState()?.search,
  };
}

function loadSortedWebSearchProviders(
  params: WebSearchRequestContext & {
    providerId?: string;
    preferRuntimeProviders?: boolean;
  },
): PluginWebSearchProviderEntry[] {
  const runtimeProviderId =
    params.preferRuntimeProviders && params.runtimeWebSearch?.providerSource === "configured"
      ? normalizeOptionalLowercaseString(
          params.runtimeWebSearch.selectedProvider ?? params.runtimeWebSearch.providerConfigured,
        )
      : undefined;
  const providerId =
    normalizeOptionalLowercaseString(params.providerId) ??
    runtimeProviderId ??
    normalizeOptionalLowercaseString(params.search?.provider);
  const pluginId = providerId
    ? resolveManifestContractOwnerPluginId({
        config: params.config,
        contract: "webSearchProviders",
        value: providerId,
      })
    : undefined;
  const resolveProviders = params.preferRuntimeProviders
    ? resolveRuntimeWebSearchProviders
    : resolvePluginWebSearchProviders;
  return sortPluginEntriesForAutoDetect(
    resolveProviders({
      config: params.config,
      ...(pluginId ? { onlyPluginIds: [pluginId] } : {}),
    }),
  );
}

async function resolveWebSearchCandidates(
  options?: ResolveWebSearchDefinitionParams,
  context = resolveWebSearchRequestContext(options),
): Promise<PluginWebSearchProviderEntry[]> {
  const { config, search, runtimeWebSearch } = context;
  if (search?.enabled === false) {
    return [];
  }

  const providers = loadSortedWebSearchProviders({
    config,
    search,
    runtimeWebSearch,
    providerId: options?.providerId,
    preferRuntimeProviders: options?.preferRuntimeProviders,
  });
  if (providers.length === 0) {
    return [];
  }

  const agentDir = options?.agentDir?.trim() || resolveDefaultAgentDir(config ?? {});
  const preparedAuthStore =
    options?.authStore ??
    (authProfileRuntimeMode.getStore()
      ? undefined
      : getRuntimeAuthProfileStoreSnapshotCore(agentDir));
  const preparedOptions = preparedAuthStore
    ? { ...options, authStore: preparedAuthStore }
    : options;
  let needsAuthSource = false;
  let autoDetectionMessage: string | undefined;
  try {
    const candidates = selectWebSearchCandidates(
      preparedOptions,
      context,
      providers,
      agentDir,
      () => {
        needsAuthSource = true;
        return false;
      },
      (message) => {
        autoDetectionMessage = message;
      },
    );
    if (!needsAuthSource) {
      if (autoDetectionMessage) {
        logVerbose(autoDetectionMessage);
      }
      return candidates;
    }
  } catch (error) {
    if (!needsAuthSource) {
      throw error;
    }
    // Resolve the earlier profile gate before reporting a later selection error.
  }
  const authStore = await ensureAuthProfileStoreWithoutExternalProfilesAsync(agentDir);
  return selectWebSearchCandidates(
    { ...options, authStore },
    context,
    providers,
    agentDir,
    () => true,
  );
}

function selectWebSearchCandidates(
  options: ResolveWebSearchDefinitionParams | undefined,
  context: WebSearchRequestContext,
  providers: PluginWebSearchProviderEntry[],
  agentDir: string,
  resolveAuthProfileStoreSource: () => boolean,
  onAutoDetection?: (message: string) => void,
): PluginWebSearchProviderEntry[] {
  const { config, search, runtimeWebSearch } = context;

  const preferredIds = uniqueStrings(
    [
      options?.providerId,
      resolveRuntimePreferredWebSearchProviderId({
        config,
        search,
        runtimeWebSearch,
        providers,
        agentDir,
        authStore: options?.authStore,
        resolveAuthProfileStoreSource,
      }),
      resolveWebSearchProviderId({
        config,
        agentDir,
        authStore: options?.authStore,
        search,
        providers,
        resolveAuthProfileStoreSource,
        onAutoDetection,
      }),
    ].filter((value): value is string => Boolean(value)),
  );

  const explicitProviderId = options?.providerId?.trim();
  if (explicitProviderId && !providers.some((entry) => entry.id === explicitProviderId)) {
    throw new Error(`Unknown web_search provider "${explicitProviderId}".`);
  }
  const explicitSelection = hasExplicitWebSearchSelection({
    search,
    runtimeWebSearch,
    providerId: options?.providerId,
    providers,
  });
  if (preferredIds.length === 0 && !explicitSelection) {
    return [];
  }
  const fallbackProviders = explicitSelection
    ? providers
    : providers.filter((provider) =>
        hasImplicitProviderSelectionSignal(
          provider,
          config,
          agentDir,
          options?.authStore,
          resolveAuthProfileStoreSource,
        ),
      );

  return [
    ...preferredIds
      .map((id) => providers.find((entry) => entry.id === id))
      .filter((entry): entry is PluginWebSearchProviderEntry => Boolean(entry)),
    ...fallbackProviders.filter((entry) => !preferredIds.includes(entry.id)),
  ];
}

type WebSearchConfigurationParams = ResolveWebSearchDefinitionParams & {
  authStore?: AuthProfileStore;
  resolveAuthProfileStoreSource?: () => boolean;
};

/** Configuration presence, not credential validity or network health. */
export function hasConfiguredWebSearchProvider(
  options: WebSearchConfigurationParams = {},
): boolean {
  const context = resolveWebSearchRequestContext(options);
  const { config, search, runtimeWebSearch } = context;
  if (
    search?.provider?.trim() ||
    runtimeWebSearch?.selectedProvider ||
    runtimeWebSearch?.providerConfigured ||
    runtimeWebSearch?.diagnostics.some(
      (diagnostic) => diagnostic.code === "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
    )
  ) {
    // A pinned, missing, or degraded provider must retain its existing actionable
    // execution error. Do not misdescribe configured-but-unavailable as no setup.
    return true;
  }
  return loadSortedWebSearchProviders({ ...context, preferRuntimeProviders: true }).some(
    (provider) =>
      providerRequiresCredential(provider) &&
      (Boolean(coerceSecretRef(provider.getConfiguredCredentialValue?.(config))) ||
        Boolean(coerceSecretRef(provider.getConfiguredCredentialFallback?.(config)?.value)) ||
        hasEntryCredential(
          provider,
          config,
          options.agentDir,
          options.authStore,
          options.resolveAuthProfileStoreSource,
        )),
  );
}

/** Prepare the agent-owned store once before synchronous provider selection. */
export async function prepareWebSearchConfiguration(
  options: WebSearchConfigurationParams = {},
  prepareAuthStore: (
    agentDir: string,
  ) => Promise<AuthProfileStore> = ensureAuthProfileStoreWithoutExternalProfilesAsync,
): Promise<boolean> {
  if (options.authStore) {
    return hasConfiguredWebSearchProvider(options);
  }
  const agentDir = options.agentDir?.trim() || resolveDefaultAgentDir(options.config ?? {});
  // Published agent snapshots include inherited credentials, including authoritative
  // emptiness. Isolated auth scopes must keep their filtered store owner instead.
  const authStore = authProfileRuntimeMode.getStore()
    ? undefined
    : getRuntimeAuthProfileStoreSnapshotCore(agentDir);
  if (authStore) {
    return hasConfiguredWebSearchProvider({ ...options, agentDir, authStore });
  }
  let needsAuthSource = false;
  const configured = hasConfiguredWebSearchProvider({
    ...options,
    resolveAuthProfileStoreSource: () => {
      needsAuthSource = true;
      return false;
    },
  });
  if (configured || !needsAuthSource) {
    return configured;
  }
  const preparedAuthStore = await prepareAuthStore(agentDir);
  return hasConfiguredWebSearchProvider({
    ...options,
    agentDir,
    authStore: preparedAuthStore,
  });
}

/** Reports whether web_search can use the prepared selection or resolve an agent-scoped provider. */
export async function hasUsableWebSearchProvider(
  options?: ResolveWebSearchDefinitionParams,
): Promise<boolean> {
  // Prepared metadata owns config/secret selection. Candidate resolution remains necessary for
  // credentials scoped to the active agent, such as provider auth profiles.
  if (normalizeOptionalLowercaseString(options?.runtimeWebSearch?.selectedProvider)) {
    return true;
  }
  return (await resolveWebSearchCandidates(options)).length > 0;
}

function hasExplicitWebSearchSelection(params: {
  search?: WebSearchConfig;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
  providerId?: string;
  providers?: PluginWebSearchProviderEntry[];
}): boolean {
  if (params.providerId?.trim()) {
    return true;
  }
  const availableProviderIds = new Set(
    (params.providers ?? []).map((provider) => normalizeLowercaseStringOrEmpty(provider.id)),
  );
  const configuredProviderId =
    params.search && "provider" in params.search && typeof params.search.provider === "string"
      ? normalizeLowercaseStringOrEmpty(params.search.provider)
      : "";
  if (configuredProviderId && availableProviderIds.has(configuredProviderId)) {
    return true;
  }
  const runtimeConfiguredId = normalizeOptionalLowercaseString(
    params.runtimeWebSearch?.selectedProvider ?? params.runtimeWebSearch?.providerConfigured,
  );
  if (
    params.runtimeWebSearch?.providerSource === "configured" &&
    runtimeConfiguredId &&
    availableProviderIds.has(runtimeConfiguredId)
  ) {
    return true;
  }
  return false;
}

/** Executes web_search with fallback when selection was not explicit. */
export async function runWebSearch(params: RunWebSearchParams): Promise<RunWebSearchResult> {
  const context = resolveWebSearchRequestContext(params);
  const { config, search, runtimeWebSearch } = context;
  const candidates = await resolveWebSearchCandidates(
    { ...params, preferRuntimeProviders: params.preferRuntimeProviders ?? true },
    context,
  );
  if (candidates.length === 0) {
    throw new Error("web_search is disabled or no provider is available.");
  }
  const allowFallback = !hasExplicitWebSearchSelection({
    search,
    runtimeWebSearch,
    providerId: params.providerId,
    providers: candidates,
  });
  const assertCurrent = params.assertCurrent;
  return await withGuardedFetchRequestAuthority(
    assertCurrent
      ? () => {
          params.signal?.throwIfAborted();
          return assertCurrent();
        }
      : undefined,
    (assertRequestCurrent) =>
      executeWebSearchCandidates({
        candidates,
        config,
        searchConfig: search as Record<string, unknown> | undefined,
        runtimeMetadata: runtimeWebSearch,
        agentDir: params.agentDir,
        args: params.args,
        signal: params.signal,
        assertCurrent: assertRequestCurrent,
        allowFallback,
      }),
  );
}
