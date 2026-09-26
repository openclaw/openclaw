// Command-specific secret target policy. Each exported helper returns the config secret IDs
// a command may inspect, with optional concrete-path filters for selected providers/accounts.
import { isDeepStrictEqual } from "node:util";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { listReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import { getConfigResolutionFacts } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { sortPluginEntriesForAutoDetect } from "../plugins/plugin-entry-order.js";
import type {
  PluginWebFetchProviderEntry,
  PluginWebSearchProviderEntry,
} from "../plugins/types.js";
import { resolvePluginWebFetchProviders } from "../plugins/web-fetch-providers.runtime.js";
import { resolvePluginWebSearchProviders } from "../plugins/web-search-providers.runtime.js";
import { normalizeOptionalAccountId } from "../routing/session-key.js";
import { loadChannelSecretContractApi } from "../secrets/channel-contract-api.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { compileTargetRegistryEntry, matchPathTokens } from "../secrets/target-registry-pattern.js";
import {
  discoverConfigSecretTargetsByIds,
  listSecretTargetRegistryEntries,
} from "../secrets/target-registry.js";
import { parseConcreteConfigPathTokens } from "../shared/dot-path.js";

const STATIC_QR_REMOTE_TARGET_IDS = ["gateway.remote.token", "gateway.remote.password"] as const;
const STATIC_MODEL_TARGET_IDS = [
  "models.providers.*.apiKey",
  "models.providers.*.headers.*",
  "models.providers.*.request.headers.*",
  "models.providers.*.request.auth.token",
  "models.providers.*.request.auth.value",
  "models.providers.*.request.proxy.tls.ca",
  "models.providers.*.request.proxy.tls.cert",
  "models.providers.*.request.proxy.tls.key",
  "models.providers.*.request.proxy.tls.passphrase",
  "models.providers.*.request.tls.ca",
  "models.providers.*.request.tls.cert",
  "models.providers.*.request.tls.key",
  "models.providers.*.request.tls.passphrase",
] as const;
const STATIC_TTS_TARGET_IDS = [
  ...STATIC_MODEL_TARGET_IDS,
  "agents.entries.*.tts.providers.*.apiKey",
  "agents.entries.*.tts.personas.*.providers.*.apiKey",
  "tts.providers.*.apiKey",
  "tts.personas.*.providers.*.apiKey",
] as const;
const STATIC_AGENT_RUNTIME_BASE_TARGET_IDS = [
  ...STATIC_TTS_TARGET_IDS,
  "memory.search.remote.apiKey",
  "agents.entries.*.memory.search.remote.apiKey",
  "skills.entries.*.apiKey",
] as const;
const STATIC_MEMORY_EMBEDDING_TARGET_IDS = [
  ...STATIC_MODEL_TARGET_IDS,
  "memory.search.remote.apiKey",
  "agents.entries.*.memory.search.remote.apiKey",
] as const;
const STATIC_GATEWAY_AUTH_TARGET_IDS = [
  "gateway.auth.token",
  "gateway.auth.password",
  "gateway.remote.token",
  "gateway.remote.password",
] as const;
const STATIC_STATUS_TARGET_IDS = [
  ...STATIC_GATEWAY_AUTH_TARGET_IDS,
  "memory.search.remote.apiKey",
  "agents.entries.*.memory.search.remote.apiKey",
] as const;

function idsByPrefix(prefixes: readonly string[]): string[] {
  return listSecretTargetRegistryEntries()
    .map((entry) => entry.id)
    .filter((id) => prefixes.some((prefix) => id.startsWith(prefix)))
    .toSorted();
}

type CommandSecretTargetScope = {
  targetIds: Set<string>;
  allowedPaths?: Set<string>;
  forcedActivePaths?: Set<string>;
  optionalActivePaths?: Set<string>;
};
type SelectedProviderTargetIds = {
  matchedProvider: boolean;
  targetIds: string[];
  targetPaths: string[];
  allowedPaths: string[];
  fallbackTargetIds: string[];
};

let cachedAgentRuntimeBaseTargetIds: string[] | undefined;
const cachedCapabilityWebTargetIds: Partial<Record<WebCapability, string[]>> = {};
let cachedChannelSecretTargetIds: string[] | undefined;

function getChannelSecretTargetIds(): string[] {
  cachedChannelSecretTargetIds ??= idsByPrefix(["channels."]);
  return cachedChannelSecretTargetIds;
}

function pluginWebCredentialConfigPath(entry: {
  id: string;
  pathPatternSegments?: string[];
}): string | undefined {
  const segments = entry.pathPatternSegments;
  if (segments?.[0] === "plugins" && segments[1] === "entries" && segments[3] === "config") {
    return segments.slice(4).join(".");
  }
  for (const configPath of ["webSearch.apiKey", "webFetch.apiKey"] as const) {
    if (entry.id.startsWith("plugins.entries.") && entry.id.endsWith(`.config.${configPath}`)) {
      return configPath;
    }
  }
  return undefined;
}

function getCapabilityWebTargetIds(kind: WebCapability): string[] {
  return (cachedCapabilityWebTargetIds[kind] ??= sortUniqueStrings(
    listSecretTargetRegistryEntries()
      .filter(
        (entry) =>
          pluginWebCredentialConfigPath(entry) ===
          (kind === "search" ? "webSearch.apiKey" : "webFetch.apiKey"),
      )
      .map((entry) => entry.id),
  ));
}

function isConfiguredSecretCandidate(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return value !== undefined && value !== null;
}

type WebCapability = "search" | "fetch";

function resolveWebConfig(
  config: OpenClawConfig,
  kind: WebCapability,
): Record<string, unknown> | undefined {
  const web = config.tools?.web?.[kind];
  return web && typeof web === "object" && !Array.isArray(web)
    ? (web as Record<string, unknown>)
    : undefined;
}

function resolveWebProviders(
  config: OpenClawConfig,
  kind: WebCapability,
): CapabilityWebCredentialProvider[] {
  return kind === "search"
    ? resolvePluginWebSearchProviders({ config })
    : resolvePluginWebFetchProviders({ config });
}

// Registry entries use wildcard path patterns; command inputs often identify one concrete config path.
function targetIdsForConfigPath(path: string): string[] {
  const pathSegments = parseConcreteConfigPathTokens(path);
  return listSecretTargetRegistryEntries()
    .filter((entry) => matchPathTokens(pathSegments, compileTargetRegistryEntry(entry).pathTokens))
    .map((entry) => entry.id)
    .toSorted();
}

function addConfigPathTargets(params: ConfigPathTargetParams): boolean {
  const targetIds = targetIdsForConfigPath(params.path);
  if (targetIds.length === 0) {
    return false;
  }
  for (const targetId of targetIds) {
    params.targetIds.add(targetId);
    if (targetId !== params.path) {
      params.allowedPaths.add(params.path);
    }
  }
  params.targetPaths.add(params.path);
  return true;
}

function addConfiguredConfigPathTargets(
  params: ConfigPathTargetParams & { config: OpenClawConfig },
): boolean {
  const targetIds = targetIdsForConfigPath(params.path);
  if (targetIds.length === 0) {
    return false;
  }
  const discovered = discoverConfigSecretTargetsByIds(params.config, new Set(targetIds));
  if (!discovered.some((target) => target.path === params.path)) {
    return false;
  }
  return addConfigPathTargets(params);
}

function modelProviderCredentialFallbackPathForWebSearchProvider(
  providerId: string | undefined,
): string | undefined {
  switch (providerId) {
    case "gemini":
      return "models.providers.google.apiKey";
    case "ollama":
      return "models.providers.ollama.apiKey";
    default:
      return undefined;
  }
}

function discoverConfiguredTargetPaths(
  config: OpenClawConfig,
  targetIds: ReadonlySet<string>,
  allowedPaths?: ReadonlySet<string>,
): Set<string> | undefined {
  const forcedActivePaths = new Set<string>();
  for (const target of discoverConfigSecretTargetsByIds(config, targetIds)) {
    if (allowedPaths && !allowedPaths.has(target.path)) {
      continue;
    }
    forcedActivePaths.add(target.path);
  }
  return forcedActivePaths.size > 0 ? forcedActivePaths : undefined;
}

function withSelectedWebProviderForDiscovery(
  config: OpenClawConfig,
  kind: "search" | "fetch",
  providerId: string | undefined,
): OpenClawConfig {
  if (!providerId) {
    return config;
  }
  const next = structuredClone(config);
  const tools = (next.tools ??= {});
  const web = (tools.web ??= {});
  const existing = web[kind];
  web[kind] =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...existing, provider: providerId }
      : { provider: providerId };
  return next;
}

function hasConfiguredWebCredential(
  provider: CapabilityWebCredentialProvider,
  config: OpenClawConfig,
): boolean {
  return isConfiguredSecretCandidate(provider.getConfiguredCredentialValue?.(config));
}

type ConfigPathTargetParams = {
  path: string;
  targetIds: Set<string>;
  targetPaths: Set<string>;
  allowedPaths: Set<string>;
};

type SelectedProviderTargetState = {
  targetIds: Set<string>;
  targetPaths: Set<string>;
  allowedPaths: Set<string>;
  fallbackTargetIds: Set<string>;
  fallbackPaths: Set<string>;
};

function createSelectedProviderTargetState(): SelectedProviderTargetState {
  return {
    targetIds: new Set<string>(),
    targetPaths: new Set<string>(),
    allowedPaths: new Set<string>(),
    fallbackTargetIds: new Set<string>(),
    fallbackPaths: new Set<string>(),
  };
}

function toSelectedProviderTargetIds(params: {
  matchedProvider: boolean;
  state: SelectedProviderTargetState;
}): SelectedProviderTargetIds {
  return {
    matchedProvider: params.matchedProvider,
    targetIds: [...params.state.targetIds].toSorted(),
    targetPaths: [...params.state.targetPaths].toSorted(),
    allowedPaths: [...params.state.allowedPaths].toSorted(),
    fallbackTargetIds: [...params.state.fallbackTargetIds].toSorted(),
  };
}

type CapabilityWebCredentialProvider = PluginWebFetchProviderEntry | PluginWebSearchProviderEntry;

function addFallbackPathTargets(
  params: ConfigPathTargetParams & {
    fallbackTargetIds: Set<string>;
    fallbackPaths: Set<string>;
    addTargets: (targetParams: ConfigPathTargetParams) => boolean;
  },
): void {
  const before = new Set(params.targetIds);
  const added = params.addTargets(params);
  for (const targetId of params.targetIds) {
    if (!before.has(targetId)) {
      params.fallbackTargetIds.add(targetId);
    }
  }
  if (added) {
    params.fallbackPaths.add(params.path);
  }
}

function addSelectedProviderCredentialTargets(params: {
  config: OpenClawConfig;
  provider: CapabilityWebCredentialProvider;
  state: SelectedProviderTargetState;
}): boolean {
  // Selected providers own one canonical plugin-scoped credential path.
  if (params.provider.credentialPath.trim()) {
    addConfigPathTargets({
      path: params.provider.credentialPath,
      targetIds: params.state.targetIds,
      targetPaths: params.state.targetPaths,
      allowedPaths: params.state.allowedPaths,
    });
  }
  if (hasConfiguredWebCredential(params.provider, params.config)) {
    return true;
  }
  const fallbackPath = params.provider
    .getConfiguredCredentialFallback?.(params.config)
    ?.path?.trim();
  if (fallbackPath) {
    addFallbackPathTargets({
      path: fallbackPath,
      targetIds: params.state.targetIds,
      targetPaths: params.state.targetPaths,
      allowedPaths: params.state.allowedPaths,
      fallbackTargetIds: params.state.fallbackTargetIds,
      fallbackPaths: params.state.fallbackPaths,
      addTargets: addConfigPathTargets,
    });
  }
  return false;
}

function getCapabilityWebSelectedProviderTargetIds(
  config: OpenClawConfig,
  kind: WebCapability,
  selectedProviderId: string,
): SelectedProviderTargetIds {
  const state = createSelectedProviderTargetState();
  const providerDiscoveryConfig = withSelectedWebProviderForDiscovery(
    config,
    kind,
    selectedProviderId,
  );
  const providers = resolveWebProviders(providerDiscoveryConfig, kind).filter(
    (provider) => provider.id === selectedProviderId,
  );
  for (const provider of providers) {
    if (
      addSelectedProviderCredentialTargets({
        config,
        provider,
        state,
      })
    ) {
      continue;
    }
    const modelFallbackPath =
      kind === "search"
        ? modelProviderCredentialFallbackPathForWebSearchProvider(selectedProviderId)
        : undefined;
    if (modelFallbackPath && !state.fallbackPaths.has(modelFallbackPath)) {
      addFallbackPathTargets({
        path: modelFallbackPath,
        targetIds: state.targetIds,
        targetPaths: state.targetPaths,
        allowedPaths: state.allowedPaths,
        fallbackTargetIds: state.fallbackTargetIds,
        fallbackPaths: state.fallbackPaths,
        addTargets: (targetParams) => addConfiguredConfigPathTargets({ config, ...targetParams }),
      });
    }
  }
  return toSelectedProviderTargetIds({ matchedProvider: providers.length > 0, state });
}

function getCapabilityWebAutoDetectTargets(
  config: OpenClawConfig,
  kind: WebCapability,
): CommandSecretTargetScope {
  const baseTargetIds = new Set(getCapabilityWebTargetIds(kind));
  const targetIds = new Set(baseTargetIds);
  const fallbackTargetIds = new Set<string>();
  const fallbackPaths = new Set<string>();
  for (const provider of sortPluginEntriesForAutoDetect(resolveWebProviders(config, kind))) {
    if (hasConfiguredWebCredential(provider, config)) {
      break;
    }
    const fallback = provider.getConfiguredCredentialFallback?.(config);
    const fallbackPath = fallback?.path?.trim();
    if (!fallbackPath || !isConfiguredSecretCandidate(fallback?.value)) {
      continue;
    }
    for (const targetId of targetIdsForConfigPath(fallbackPath)) {
      targetIds.add(targetId);
      fallbackTargetIds.add(targetId);
    }
    fallbackPaths.add(fallbackPath);
    break;
  }
  if (fallbackTargetIds.size === 0) {
    return { targetIds };
  }
  // Fallback credentials are optional unless their concrete path is already configured;
  // this prevents auto-detect from forcing unrelated provider credentials active.
  const configuredPaths = discoverConfiguredTargetPaths(config, baseTargetIds);
  const allowedPaths = new Set([...(configuredPaths ?? []), ...fallbackPaths]);
  const optionalActivePaths = discoverConfiguredTargetPaths(
    config,
    fallbackTargetIds,
    allowedPaths,
  );
  return {
    targetIds,
    allowedPaths,
    ...(optionalActivePaths ? { optionalActivePaths } : {}),
  };
}

function getAgentRuntimeBaseTargetIds(): string[] {
  cachedAgentRuntimeBaseTargetIds ??= [
    ...STATIC_AGENT_RUNTIME_BASE_TARGET_IDS,
    ...listSecretTargetRegistryEntries()
      .filter((entry) => {
        const configPath = pluginWebCredentialConfigPath(entry);
        return configPath === "webSearch.apiKey" || configPath === "webFetch.apiKey";
      })
      .map((entry) => entry.id)
      .toSorted(),
  ];
  return cachedAgentRuntimeBaseTargetIds;
}

function isScopedChannelSecretTargetEntry(params: {
  entry: {
    id: string;
    configFile?: string;
    pathPattern?: string;
    refPathPattern?: string;
  };
  pluginChannelId: string;
}): boolean {
  const channelId = normalizeOptionalString(params.pluginChannelId);
  if (!channelId) {
    return false;
  }
  const allowedPrefix = `channels.${channelId}.`;
  return (
    params.entry.id.startsWith(allowedPrefix) &&
    params.entry.configFile === "openclaw.json" &&
    typeof params.entry.pathPattern === "string" &&
    params.entry.pathPattern.startsWith(allowedPrefix) &&
    (params.entry.refPathPattern === undefined ||
      params.entry.refPathPattern.startsWith(allowedPrefix))
  );
}

function getConfiguredChannelSecretTargetIds(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const targetIds = new Set<string>();
  const channels = config.channels;
  if (channels && typeof channels === "object" && !Array.isArray(channels)) {
    for (const channelId of Object.keys(channels)) {
      if (channelId === "defaults") {
        continue;
      }
      const contract = loadChannelSecretContractApi({ channelId, config, env });
      for (const entry of contract?.secretTargetRegistryEntries ?? []) {
        if (isScopedChannelSecretTargetEntry({ entry, pluginChannelId: channelId })) {
          targetIds.add(entry.id);
        }
      }
    }
  }
  for (const plugin of listReadOnlyChannelPluginsForConfig(config, {
    env,
    includePersistedAuthState: false,
  })) {
    for (const entry of plugin.secrets?.secretTargetRegistryEntries ?? []) {
      if (isScopedChannelSecretTargetEntry({ entry, pluginChannelId: plugin.id })) {
        targetIds.add(entry.id);
      }
    }
  }
  return [...targetIds].toSorted((left, right) => left.localeCompare(right));
}

function selectChannelTargetIds(channel?: string): Set<string> {
  const channelTargetIds = getChannelSecretTargetIds();
  if (!channel) {
    return new Set(channelTargetIds);
  }
  return new Set(channelTargetIds.filter((id) => id.startsWith(`channels.${channel}.`)));
}

function pathTargetsScopedChannelAccount(params: {
  pathSegments: readonly string[];
  channel: string;
  accountId: string;
}): boolean {
  const [root, channelId, accountRoot, accountId] = params.pathSegments;
  if (root !== "channels" || channelId !== params.channel) {
    return false;
  }
  if (accountRoot !== "accounts") {
    return true;
  }
  return normalizeOptionalAccountId(accountId) === params.accountId;
}

/** Return channel secret targets, optionally narrowed to one channel account subtree. */
export function getScopedChannelsCommandSecretTargets(params: {
  config: OpenClawConfig;
  channel?: string | null;
  channels?: readonly string[];
  accountId?: string | null;
  defaultAccountWhenMissing?: boolean;
}): {
  targetIds: Set<string>;
  allowedPaths?: Set<string>;
} {
  const channel = normalizeOptionalString(params.channel);
  const channels =
    params.channels === undefined
      ? undefined
      : sortUniqueStrings(
          params.channels.flatMap((candidate) => {
            const normalized = normalizeOptionalString(candidate);
            return normalized ? [normalized] : [];
          }),
        );
  const targetIds =
    channels === undefined
      ? selectChannelTargetIds(channel)
      : new Set(channels.flatMap((candidate) => [...selectChannelTargetIds(candidate)]));
  const explicitAccountId = normalizeOptionalAccountId(params.accountId);
  const channelPlugin =
    channel && !explicitAccountId && params.defaultAccountWhenMissing
      ? listReadOnlyChannelPluginsForConfig(params.config, {
          includePersistedAuthState: false,
        }).find((plugin) => plugin.id === channel)
      : undefined;
  const normalizedAccountId =
    explicitAccountId ??
    (channelPlugin
      ? normalizeOptionalAccountId(
          resolveChannelDefaultAccountId({ plugin: channelPlugin, cfg: params.config }),
        )
      : undefined);
  const scopedChannels = channels ?? (channel ? [channel] : []);
  if (scopedChannels.length === 0 || !normalizedAccountId) {
    return { targetIds };
  }

  const allowedPaths = new Set<string>();
  for (const target of discoverConfigSecretTargetsByIds(params.config, targetIds)) {
    if (
      scopedChannels.some((scopedChannel) =>
        pathTargetsScopedChannelAccount({
          pathSegments: target.pathSegments,
          channel: scopedChannel,
          accountId: normalizedAccountId,
        }),
      )
    ) {
      allowedPaths.add(target.path);
    }
  }
  return { targetIds, allowedPaths };
}

/** Secret targets needed by QR remote pairing flows. */
export function getQrRemoteCommandSecretTargetIds(): Set<string> {
  return new Set(STATIC_QR_REMOTE_TARGET_IDS);
}

/** All registered channel secret targets, regardless of current config. */
export function getChannelsCommandSecretTargetIds(): Set<string> {
  return new Set(getChannelSecretTargetIds());
}

/** Channel secret targets contributed by channels currently present in config/read-only plugins. */
export function getConfiguredChannelsCommandSecretTargetIds(
  config: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): Set<string> {
  return new Set(getConfiguredChannelSecretTargetIds(config, env));
}

/** Model-provider credential targets used by commands that can touch provider config. */
export function getModelsCommandSecretTargetIds(): Set<string> {
  return new Set(STATIC_MODEL_TARGET_IDS);
}

/** Credential targets required by memory embedding flows. */
export function getMemoryEmbeddingCommandSecretTargetIds(): Set<string> {
  return new Set(STATIC_MEMORY_EMBEDDING_TARGET_IDS);
}

/** Credential targets required by text-to-speech flows. */
export function getTtsCommandSecretTargetIds(): Set<string> {
  return new Set(STATIC_TTS_TARGET_IDS);
}

/** Agent startup targets not already owned by its prepared secrets snapshot. */
export function getAgentRuntimeCommandSecretTargetIds(params: {
  config: OpenClawConfig;
  includeChannelTargets?: boolean;
}): Set<string> {
  const snapshot = getActiveSecretsRuntimeConfigSnapshot();
  // The facts token also owns authored refs outside the enumerable config; equal sets can differ.
  const prepared =
    snapshot?.configRefsPrepared &&
    (params.config === snapshot.config ||
      (getConfigResolutionFacts(params.config) === getConfigResolutionFacts(snapshot.config) &&
        isDeepStrictEqual(params.config, snapshot.config)));
  // Preparation already classified these owners. Re-resolving every model/tool ref would turn
  // one isolated cold owner into a turn-wide failure (or retry it with local credentials).
  if (prepared) {
    return params.includeChannelTargets ? getChannelsCommandSecretTargetIds() : new Set();
  }
  if (params.includeChannelTargets !== true) {
    return new Set(getAgentRuntimeBaseTargetIds());
  }
  return new Set([...getAgentRuntimeBaseTargetIds(), ...getChannelSecretTargetIds()]);
}

/**
 * Web credentials are needed only if the model invokes the corresponding tool.
 * Keep them materializable for agent runs without making tool-owner outages block turn startup.
 */
export function getAgentRuntimeOptionalCommandSecretPaths(config: OpenClawConfig): Set<string> {
  const targetIds = new Set([
    ...getCapabilityWebTargetIds("search"),
    ...getCapabilityWebTargetIds("fetch"),
  ]);
  const defaults = config.secrets?.defaults;
  return new Set(
    discoverConfigSecretTargetsByIds(config, targetIds)
      .filter((target) =>
        Boolean(
          resolveSecretInputRef({
            value: target.value,
            refValue: target.refValue,
            defaults,
          }).ref,
        ),
      )
      .map((target) => target.path),
  );
}

/** Static web-fetch capability targets plus plugin-provided web-fetch credential targets. */
export function getCapabilityWebFetchCommandSecretTargetIds(): Set<string> {
  return new Set(getCapabilityWebTargetIds("fetch"));
}

function getCapabilityWebCommandSecretTargets(
  config: OpenClawConfig,
  kind: WebCapability,
  providerId?: string | null,
): CommandSecretTargetScope {
  const web = resolveWebConfig(config, kind);
  if (web?.enabled === false) {
    return {
      targetIds: new Set(getCapabilityWebTargetIds(kind)),
    };
  }
  const selectedProviderId =
    normalizeOptionalLowercaseString(providerId) ?? normalizeOptionalLowercaseString(web?.provider);
  if (!selectedProviderId) {
    return getCapabilityWebAutoDetectTargets(config, kind);
  }
  const selectedTargets = getCapabilityWebSelectedProviderTargetIds(
    config,
    kind,
    selectedProviderId,
  );
  if (!selectedTargets.matchedProvider && !providerId) {
    return getCapabilityWebAutoDetectTargets(config, kind);
  }
  const targetIds = new Set(selectedTargets.targetIds);
  const allowedPaths =
    selectedTargets.allowedPaths.length > 0 ? new Set(selectedTargets.targetPaths) : undefined;
  const forcedActivePaths = discoverConfiguredTargetPaths(
    config,
    new Set(providerId ? selectedTargets.targetIds : selectedTargets.fallbackTargetIds),
    allowedPaths,
  );
  return {
    targetIds,
    ...(allowedPaths ? { allowedPaths } : {}),
    ...(forcedActivePaths ? { forcedActivePaths } : {}),
  };
}

/** Web-fetch target scope for selected/auto-detected providers and configured fallback paths. */
export function getCapabilityWebFetchCommandSecretTargets(
  config: OpenClawConfig,
  options?: {
    providerId?: string | null;
  },
): CommandSecretTargetScope {
  return getCapabilityWebCommandSecretTargets(config, "fetch", options?.providerId);
}

/** Static web-search capability targets plus plugin-provided web-search credential targets. */
export function getCapabilityWebSearchCommandSecretTargetIds(): Set<string> {
  return new Set(getCapabilityWebTargetIds("search"));
}

/** Web-search target scope for selected/auto-detected providers and configured fallback paths. */
export function getCapabilityWebSearchCommandSecretTargets(
  config: OpenClawConfig,
  options?: {
    providerId?: string | null;
  },
): CommandSecretTargetScope {
  return getCapabilityWebCommandSecretTargets(config, "search", options?.providerId);
}

/** Status command targets; channel targets can be limited to configured channel plugins. */
export function getStatusCommandSecretTargetIds(
  config?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): Set<string> {
  const channelTargetIds = config
    ? getConfiguredChannelSecretTargetIds(config, env)
    : getChannelSecretTargetIds();
  return new Set([...STATIC_STATUS_TARGET_IDS, ...channelTargetIds]);
}

/** Secret targets that the security audit command is allowed to inspect. */
export function getSecurityAuditCommandSecretTargetIds(): Set<string> {
  return new Set([...STATIC_GATEWAY_AUTH_TARGET_IDS, ...getChannelSecretTargetIds()]);
}
