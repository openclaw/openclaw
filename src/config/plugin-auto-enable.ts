import fs from "node:fs";
import path from "node:path";
import { normalizeProviderId } from "../agents/model-selection.js";
import {
  hasPotentialConfiguredChannels,
  listPotentialConfiguredChannelIds,
} from "../channels/config-presence.js";
import { getChatChannelMeta, normalizeChatChannelId } from "../channels/registry.js";
import { normalizeMediaProviderId } from "../media-understanding/provider-id.js";
import {
  BUNDLED_AUTO_ENABLE_PROVIDER_PLUGIN_IDS,
  BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS,
} from "../plugins/bundled-capability-metadata.js";
import { resolveBundledWebFetchPluginId } from "../plugins/bundled-web-fetch-provider-ids.js";
import {
  loadPluginManifestRegistry,
  type PluginManifestRegistry,
} from "../plugins/manifest-registry.js";
import { isRecord, resolveConfigDir, resolveUserPath } from "../utils.js";
import { isChannelConfigured } from "./channel-configured.js";
import type { OpenClawConfig } from "./config.js";
import { ensurePluginAllowlisted } from "./plugins-allowlist.js";
import { isBlockedObjectKey } from "./prototype-keys.js";

export type PluginAutoEnableCandidate =
  | {
      pluginId: string;
      kind: "channel-configured";
      channelId: string;
    }
  | {
      pluginId: "browser";
      kind: "browser-configured";
      source: "browser-configured" | "browser-plugin-configured" | "browser-tool-referenced";
    }
  | {
      pluginId: string;
      kind: "provider-auth-configured";
      providerId: string;
    }
  | {
      pluginId: string;
      kind: "web-fetch-provider-selected";
      providerId: string;
    }
  | {
      pluginId: string;
      kind: "plugin-web-search-configured";
    }
  | {
      pluginId: string;
      kind: "plugin-web-fetch-configured";
    }
  | {
      pluginId: string;
      kind: "plugin-tool-configured";
    }
  | {
      pluginId: "acpx";
      kind: "acp-runtime-configured";
    }
  | {
      pluginId: string;
      kind: "media-provider-configured";
      providerId: string;
    };

export type PluginAutoEnableResult = {
  config: OpenClawConfig;
  changes: string[];
  autoEnabledReasons: Record<string, string[]>;
};

const EMPTY_PLUGIN_MANIFEST_REGISTRY: PluginManifestRegistry = {
  plugins: [],
  diagnostics: [],
};

const ENV_CATALOG_PATHS = ["OPENCLAW_PLUGIN_CATALOG_PATHS", "OPENCLAW_MPM_CATALOG_PATHS"];

function resolveAutoEnableProviderPluginIds(
  registry: PluginManifestRegistry,
): Readonly<Record<string, string>> {
  const entries = new Map<string, string>(Object.entries(BUNDLED_AUTO_ENABLE_PROVIDER_PLUGIN_IDS));
  for (const plugin of registry.plugins) {
    for (const providerId of plugin.autoEnableWhenConfiguredProviders ?? []) {
      if (!entries.has(providerId)) {
        entries.set(providerId, plugin.id);
      }
    }
  }
  return Object.fromEntries(entries);
}

function collectModelRefs(cfg: OpenClawConfig): string[] {
  const refs: string[] = [];
  const pushModelRef = (value: unknown) => {
    if (typeof value === "string" && value.trim()) {
      refs.push(value.trim());
    }
  };
  const collectFromAgent = (agent: Record<string, unknown> | null | undefined) => {
    if (!agent) {
      return;
    }
    const model = agent.model;
    if (typeof model === "string") {
      pushModelRef(model);
    } else if (isRecord(model)) {
      pushModelRef(model.primary);
      const fallbacks = model.fallbacks;
      if (Array.isArray(fallbacks)) {
        for (const entry of fallbacks) {
          pushModelRef(entry);
        }
      }
    }
    const models = agent.models;
    if (isRecord(models)) {
      for (const key of Object.keys(models)) {
        pushModelRef(key);
      }
    }
  };

  const defaults = cfg.agents?.defaults as Record<string, unknown> | undefined;
  collectFromAgent(defaults);

  const list = cfg.agents?.list;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (isRecord(entry)) {
        collectFromAgent(entry);
      }
    }
  }
  return refs;
}

function extractProviderFromModelRef(value: string): string | null {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) {
    return null;
  }
  return normalizeProviderId(trimmed.slice(0, slash));
}

function isProviderConfigured(cfg: OpenClawConfig, providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);

  const profiles = cfg.auth?.profiles;
  if (profiles && typeof profiles === "object") {
    for (const profile of Object.values(profiles)) {
      if (!isRecord(profile)) {
        continue;
      }
      const provider = normalizeProviderId(String(profile.provider ?? ""));
      if (provider === normalized) {
        return true;
      }
    }
  }

  const providerConfig = cfg.models?.providers;
  if (providerConfig && typeof providerConfig === "object") {
    for (const key of Object.keys(providerConfig)) {
      if (normalizeProviderId(key) === normalized) {
        return true;
      }
    }
  }

  const modelRefs = collectModelRefs(cfg);
  for (const ref of modelRefs) {
    const provider = extractProviderFromModelRef(ref);
    if (provider && provider === normalized) {
      return true;
    }
  }

  return false;
}

function hasPluginOwnedWebSearchConfig(cfg: OpenClawConfig, pluginId: string): boolean {
  const pluginConfig = cfg.plugins?.entries?.[pluginId]?.config;
  if (!isRecord(pluginConfig)) {
    return false;
  }
  return isRecord(pluginConfig.webSearch);
}

function hasPluginOwnedWebFetchConfig(cfg: OpenClawConfig, pluginId: string): boolean {
  const pluginConfig = cfg.plugins?.entries?.[pluginId]?.config;
  if (!isRecord(pluginConfig)) {
    return false;
  }
  return isRecord(pluginConfig.webFetch);
}

function hasPluginOwnedToolConfig(cfg: OpenClawConfig, pluginId: string): boolean {
  if (pluginId === "xai") {
    const pluginConfig = cfg.plugins?.entries?.xai?.config;
    const web = cfg.tools?.web as Record<string, unknown> | undefined;
    return Boolean(
      isRecord(web?.x_search) ||
      (isRecord(pluginConfig) &&
        (isRecord(pluginConfig.xSearch) || isRecord(pluginConfig.codeExecution))),
    );
  }
  return false;
}

function collectConfiguredMediaProviderIds(cfg: OpenClawConfig): string[] {
  const providerIds = new Set<string>();
  const pushModels = (models: unknown) => {
    if (!Array.isArray(models)) {
      return;
    }
    for (const entry of models) {
      if (!isRecord(entry)) {
        continue;
      }
      const providerId = normalizeMediaProviderId(
        typeof entry.provider === "string" ? entry.provider : "",
      );
      if (providerId) {
        providerIds.add(providerId);
      }
    }
  };

  pushModels(cfg.tools?.media?.models);
  pushModels(cfg.tools?.media?.audio?.models);
  pushModels(cfg.tools?.media?.image?.models);
  pushModels(cfg.tools?.media?.video?.models);

  return [...providerIds].toSorted((left, right) => left.localeCompare(right));
}

const BUNDLED_MEDIA_PROVIDER_IDS = new Set(
  BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.flatMap((entry) =>
    entry.mediaUnderstandingProviderIds.map((id) => normalizeMediaProviderId(id)),
  ).filter((id): id is string => id !== undefined),
);

function isBundledMediaProviderId(id: string): boolean {
  return BUNDLED_MEDIA_PROVIDER_IDS.has(id);
}

function resolveProviderPluginsWithOwnedWebSearch(
  registry: PluginManifestRegistry,
): ReadonlySet<string> {
  const pluginIds = new Set(
    BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter(
      (entry) => entry.providerIds.length > 0 && entry.webSearchProviderIds.length > 0,
    ).map((entry) => entry.pluginId),
  );
  for (const plugin of registry.plugins) {
    if (plugin.providers.length > 0 && (plugin.contracts?.webSearchProviders?.length ?? 0) > 0) {
      pluginIds.add(plugin.id);
    }
  }
  return pluginIds;
}

const BUNDLED_WEB_FETCH_OWNER_PLUGIN_IDS = new Set(
  BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter((entry) => entry.webFetchProviderIds.length > 0).map(
    (entry) => entry.pluginId,
  ),
);

function resolveProviderPluginsWithOwnedWebFetch(): ReadonlySet<string> {
  return new Set(
    BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter((entry) => entry.webFetchProviderIds.length > 0).map(
      (entry) => entry.pluginId,
    ),
  );
}

function resolveMediaUnderstandingProviderPluginIds(
  registry: PluginManifestRegistry,
): Readonly<Record<string, string>> {
  const entries = new Map<string, string>(
    BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.flatMap((entry) =>
      entry.mediaUnderstandingProviderIds.map(
        (providerId) => [normalizeMediaProviderId(providerId), entry.pluginId] as const,
      ),
    ).filter((pair): pair is [string, string] => pair[0] !== undefined),
  );
  for (const plugin of registry.plugins) {
    for (const providerId of plugin.contracts?.mediaUnderstandingProviders ?? []) {
      const normalizedProviderId = normalizeMediaProviderId(providerId);
      if (!normalizedProviderId || entries.has(normalizedProviderId)) {
        continue;
      }
      entries.set(normalizedProviderId, plugin.id);
    }
  }
  return Object.fromEntries([...entries].toSorted(([left], [right]) => left.localeCompare(right)));
}

function resolvePluginIdForConfiguredWebFetchProvider(
  providerId: string | undefined,
): string | undefined {
  return resolveBundledWebFetchPluginId(
    typeof providerId === "string" ? providerId.trim().toLowerCase() : "",
  );
}

function buildChannelToPluginIdMap(registry: PluginManifestRegistry): Map<string, string> {
  const map = new Map<string, string>();
  for (const record of registry.plugins) {
    for (const channelId of record.channels) {
      if (channelId && !map.has(channelId)) {
        map.set(channelId, record.id);
      }
    }
  }
  return map;
}

type ExternalCatalogChannelEntry = {
  id: string;
  preferOver: string[];
};

function splitEnvPaths(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  return trimmed
    .split(/[;,]/g)
    .flatMap((chunk) => chunk.split(path.delimiter))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveExternalCatalogPaths(env: NodeJS.ProcessEnv): string[] {
  for (const key of ENV_CATALOG_PATHS) {
    const raw = env[key];
    if (raw && raw.trim()) {
      return splitEnvPaths(raw);
    }
  }
  const configDir = resolveConfigDir(env);
  return [
    path.join(configDir, "mpm", "plugins.json"),
    path.join(configDir, "mpm", "catalog.json"),
    path.join(configDir, "plugins", "catalog.json"),
  ];
}

function parseExternalCatalogChannelEntries(raw: unknown): ExternalCatalogChannelEntry[] {
  const list = (() => {
    if (Array.isArray(raw)) {
      return raw;
    }
    if (!isRecord(raw)) {
      return [];
    }
    const entries = raw.entries ?? raw.packages ?? raw.plugins;
    return Array.isArray(entries) ? entries : [];
  })();

  const channels: ExternalCatalogChannelEntry[] = [];
  for (const entry of list) {
    if (!isRecord(entry) || !isRecord(entry.openclaw) || !isRecord(entry.openclaw.channel)) {
      continue;
    }
    const channel = entry.openclaw.channel;
    const id = typeof channel.id === "string" ? channel.id.trim() : "";
    if (!id) {
      continue;
    }
    const preferOver = Array.isArray(channel.preferOver)
      ? channel.preferOver.filter((value): value is string => typeof value === "string")
      : [];
    channels.push({ id, preferOver });
  }
  return channels;
}

function resolveExternalCatalogPreferOver(channelId: string, env: NodeJS.ProcessEnv): string[] {
  for (const rawPath of resolveExternalCatalogPaths(env)) {
    const resolved = resolveUserPath(rawPath, env);
    if (!fs.existsSync(resolved)) {
      continue;
    }
    try {
      const payload = JSON.parse(fs.readFileSync(resolved, "utf-8")) as unknown;
      const channel = parseExternalCatalogChannelEntries(payload).find(
        (entry) => entry.id === channelId,
      );
      if (channel) {
        return channel.preferOver;
      }
    } catch {
      // Ignore invalid catalog files.
    }
  }
  return [];
}

function resolvePluginIdForChannel(
  channelId: string,
  channelToPluginId: ReadonlyMap<string, string>,
): string {
  // Third-party plugins can expose a channel id that differs from their
  // manifest id; plugins.entries must always be keyed by manifest id.
  const builtInId = normalizeChatChannelId(channelId);
  if (builtInId) {
    return builtInId;
  }
  return channelToPluginId.get(channelId) ?? channelId;
}

function collectCandidateChannelIds(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): string[] {
  return listPotentialConfiguredChannelIds(cfg, env).map(
    (channelId) => normalizeChatChannelId(channelId) ?? channelId,
  );
}

function hasConfiguredWebSearchPluginEntry(cfg: OpenClawConfig): boolean {
  const entries = cfg.plugins?.entries;
  if (!entries || typeof entries !== "object") {
    return false;
  }
  return Object.values(entries).some(
    (entry) => isRecord(entry) && isRecord(entry.config) && isRecord(entry.config.webSearch),
  );
}

function hasConfiguredWebFetchPluginEntry(cfg: OpenClawConfig): boolean {
  const entries = cfg.plugins?.entries;
  if (!entries || typeof entries !== "object") {
    return false;
  }
  return Object.entries(entries).some(
    ([pluginId, entry]) =>
      BUNDLED_WEB_FETCH_OWNER_PLUGIN_IDS.has(pluginId) &&
      isRecord(entry) &&
      isRecord(entry.config) &&
      isRecord(entry.config.webFetch),
  );
}

function configMayNeedPluginManifestRegistry(cfg: OpenClawConfig): boolean {
  const configuredChannels = cfg.channels as Record<string, unknown> | undefined;
  if (configuredChannels && typeof configuredChannels === "object") {
    for (const key of Object.keys(configuredChannels)) {
      if (key === "defaults" || key === "modelByChannel") {
        continue;
      }
      if (!normalizeChatChannelId(key)) {
        return true;
      }
    }
  }
  const mediaProviderIds = collectConfiguredMediaProviderIds(cfg);
  if (mediaProviderIds.some((id) => !isBundledMediaProviderId(id))) {
    return true;
  }
  return false;
}

function configMayNeedPluginAutoEnable(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  if (hasPotentialConfiguredChannels(cfg, env)) {
    return true;
  }
  if (resolveBrowserAutoEnableSource(cfg)) {
    return true;
  }
  if (cfg.acp?.enabled === true || cfg.acp?.dispatch?.enabled === true) {
    return true;
  }
  if (typeof cfg.acp?.backend === "string" && cfg.acp.backend.trim().length > 0) {
    return true;
  }
  if (cfg.auth?.profiles && Object.keys(cfg.auth.profiles).length > 0) {
    return true;
  }
  if (cfg.models?.providers && Object.keys(cfg.models.providers).length > 0) {
    return true;
  }
  if (collectModelRefs(cfg).length > 0) {
    return true;
  }
  const web = cfg.tools?.web as Record<string, unknown> | undefined;
  if (isRecord(web?.x_search)) {
    return true;
  }
  if (
    isRecord(cfg.plugins?.entries?.xai?.config) ||
    hasConfiguredWebSearchPluginEntry(cfg) ||
    hasConfiguredWebFetchPluginEntry(cfg)
  ) {
    return true;
  }
  if (collectConfiguredMediaProviderIds(cfg).length > 0) {
    return true;
  }
  return false;
}

function listContainsBrowser(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((entry) => typeof entry === "string" && entry.trim().toLowerCase() === "browser")
  );
}

function toolPolicyReferencesBrowser(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return listContainsBrowser(value.allow) || listContainsBrowser(value.alsoAllow);
}

function hasBrowserToolReference(cfg: OpenClawConfig): boolean {
  if (toolPolicyReferencesBrowser(cfg.tools)) {
    return true;
  }

  const agentList = cfg.agents?.list;
  if (!Array.isArray(agentList)) {
    return false;
  }

  return agentList.some((entry) => isRecord(entry) && toolPolicyReferencesBrowser(entry.tools));
}

function hasExplicitBrowserPluginEntry(cfg: OpenClawConfig): boolean {
  return Boolean(
    cfg.plugins?.entries && Object.prototype.hasOwnProperty.call(cfg.plugins.entries, "browser"),
  );
}

function resolveBrowserAutoEnableSource(
  cfg: OpenClawConfig,
): Extract<PluginAutoEnableCandidate, { kind: "browser-configured" }>["source"] | null {
  if (cfg.browser?.enabled === false || cfg.plugins?.entries?.browser?.enabled === false) {
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(cfg, "browser")) {
    return "browser-configured";
  }

  if (hasExplicitBrowserPluginEntry(cfg)) {
    return "browser-plugin-configured";
  }

  if (hasBrowserToolReference(cfg)) {
    return "browser-tool-referenced";
  }

  return null;
}

export function resolvePluginAutoEnableCandidateReason(
  candidate: PluginAutoEnableCandidate,
): string {
  switch (candidate.kind) {
    case "channel-configured":
      return `${candidate.channelId} configured`;
    case "browser-configured":
      switch (candidate.source) {
        case "browser-configured":
          return "browser configured";
        case "browser-plugin-configured":
          return "browser plugin configured";
        case "browser-tool-referenced":
          return "browser tool referenced";
      }
      break;
    case "provider-auth-configured":
      return `${candidate.providerId} auth configured`;
    case "web-fetch-provider-selected":
      return `${candidate.providerId} web fetch provider selected`;
    case "plugin-web-search-configured":
      return `${candidate.pluginId} web search configured`;
    case "plugin-web-fetch-configured":
      return `${candidate.pluginId} web fetch configured`;
    case "plugin-tool-configured":
      return `${candidate.pluginId} tool configured`;
    case "acp-runtime-configured":
      return "ACP runtime configured";
    case "media-provider-configured":
      return `${candidate.providerId} media provider configured`;
  }
}

function resolveConfiguredPlugins(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  registry: PluginManifestRegistry,
): PluginAutoEnableCandidate[] {
  const changes: PluginAutoEnableCandidate[] = [];
  // Build reverse map: channel ID → plugin ID from installed plugin manifests.
  const channelToPluginId = buildChannelToPluginIdMap(registry);
  for (const channelId of collectCandidateChannelIds(cfg, env)) {
    const pluginId = resolvePluginIdForChannel(channelId, channelToPluginId);
    if (isChannelConfigured(cfg, channelId, env)) {
      changes.push({ pluginId, kind: "channel-configured", channelId });
    }
  }

  const browserSource = resolveBrowserAutoEnableSource(cfg);
  if (browserSource) {
    changes.push({ pluginId: "browser", kind: "browser-configured", source: browserSource });
  }

  for (const [providerId, pluginId] of Object.entries(
    resolveAutoEnableProviderPluginIds(registry),
  )) {
    if (isProviderConfigured(cfg, providerId)) {
      changes.push({
        pluginId,
        kind: "provider-auth-configured",
        providerId,
      });
    }
  }
  const configuredMediaProviderIds = collectConfiguredMediaProviderIds(cfg);
  const mediaProviderPluginIds = resolveMediaUnderstandingProviderPluginIds(registry);
  for (const providerId of configuredMediaProviderIds) {
    const pluginId = mediaProviderPluginIds[providerId];
    if (!pluginId) {
      continue;
    }
    changes.push({
      pluginId,
      kind: "media-provider-configured",
      providerId,
    });
  }
  const webFetchProvider =
    typeof cfg.tools?.web?.fetch?.provider === "string" ? cfg.tools.web.fetch.provider : undefined;
  const webFetchPluginId = resolvePluginIdForConfiguredWebFetchProvider(webFetchProvider);
  if (webFetchPluginId) {
    changes.push({
      pluginId: webFetchPluginId,
      kind: "web-fetch-provider-selected",
      providerId: String(webFetchProvider).trim().toLowerCase(),
    });
  }
  for (const pluginId of resolveProviderPluginsWithOwnedWebSearch(registry)) {
    if (hasPluginOwnedWebSearchConfig(cfg, pluginId)) {
      changes.push({
        pluginId,
        kind: "plugin-web-search-configured",
      });
    }
  }
  for (const pluginId of resolveProviderPluginsWithOwnedWebFetch()) {
    if (hasPluginOwnedWebFetchConfig(cfg, pluginId)) {
      changes.push({
        pluginId,
        kind: "plugin-web-fetch-configured",
      });
    }
  }
  for (const pluginId of resolveProviderPluginsWithOwnedWebSearch(registry)) {
    if (hasPluginOwnedToolConfig(cfg, pluginId)) {
      changes.push({
        pluginId,
        kind: "plugin-tool-configured",
      });
    }
  }
  const backendRaw =
    typeof cfg.acp?.backend === "string" ? cfg.acp.backend.trim().toLowerCase() : "";
  const acpConfigured =
    cfg.acp?.enabled === true || cfg.acp?.dispatch?.enabled === true || backendRaw === "acpx";
  if (acpConfigured && (!backendRaw || backendRaw === "acpx")) {
    changes.push({
      pluginId: "acpx",
      kind: "acp-runtime-configured",
    });
  }
  return changes;
}

function isPluginExplicitlyDisabled(cfg: OpenClawConfig, pluginId: string): boolean {
  const builtInChannelId = normalizeChatChannelId(pluginId);
  if (builtInChannelId) {
    const channels = cfg.channels as Record<string, unknown> | undefined;
    const channelConfig = channels?.[builtInChannelId];
    if (
      channelConfig &&
      typeof channelConfig === "object" &&
      !Array.isArray(channelConfig) &&
      (channelConfig as { enabled?: unknown }).enabled === false
    ) {
      return true;
    }
  }
  const entry = cfg.plugins?.entries?.[pluginId];
  return entry?.enabled === false;
}

function isPluginDenied(cfg: OpenClawConfig, pluginId: string): boolean {
  const deny = cfg.plugins?.deny;
  return Array.isArray(deny) && deny.includes(pluginId);
}

function resolvePreferredOverIds(
  pluginId: string,
  env: NodeJS.ProcessEnv,
  registry: PluginManifestRegistry,
): string[] {
  const normalized = normalizeChatChannelId(pluginId);
  if (normalized) {
    return [...(getChatChannelMeta(normalized).preferOver ?? [])];
  }
  const installedPlugin = registry.plugins.find((record) => record.id === pluginId);
  const manifestChannelPreferOver = installedPlugin?.channelConfigs?.[pluginId]?.preferOver;
  if (manifestChannelPreferOver?.length) {
    return [...manifestChannelPreferOver];
  }
  const installedChannelMeta = installedPlugin?.channelCatalogMeta;
  if (installedChannelMeta?.preferOver?.length) {
    return [...installedChannelMeta.preferOver];
  }
  return resolveExternalCatalogPreferOver(pluginId, env);
}

function shouldSkipPreferredPluginAutoEnable(
  cfg: OpenClawConfig,
  entry: PluginAutoEnableCandidate,
  configured: PluginAutoEnableCandidate[],
  env: NodeJS.ProcessEnv,
  registry: PluginManifestRegistry,
): boolean {
  for (const other of configured) {
    if (other.pluginId === entry.pluginId) {
      continue;
    }
    if (isPluginDenied(cfg, other.pluginId)) {
      continue;
    }
    if (isPluginExplicitlyDisabled(cfg, other.pluginId)) {
      continue;
    }
    const preferOver = resolvePreferredOverIds(other.pluginId, env, registry);
    if (preferOver.includes(entry.pluginId)) {
      return true;
    }
  }
  return false;
}

function registerPluginEntry(cfg: OpenClawConfig, pluginId: string): OpenClawConfig {
  const builtInChannelId = normalizeChatChannelId(pluginId);
  if (builtInChannelId) {
    const channels = cfg.channels as Record<string, unknown> | undefined;
    const existing = channels?.[builtInChannelId];
    const existingRecord =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? (existing as Record<string, unknown>)
        : {};
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        [builtInChannelId]: {
          ...existingRecord,
          enabled: true,
        },
      },
    };
  }
  const entries = {
    ...cfg.plugins?.entries,
    [pluginId]: {
      ...(cfg.plugins?.entries?.[pluginId] as Record<string, unknown> | undefined),
      enabled: true,
    },
  };
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries,
    },
  };
}

function formatAutoEnableChange(entry: PluginAutoEnableCandidate): string {
  let reason = resolvePluginAutoEnableCandidateReason(entry).trim();
  const channelId = normalizeChatChannelId(entry.pluginId);
  if (channelId) {
    const label = getChatChannelMeta(channelId).label;
    reason = reason.replace(new RegExp(`^${channelId}\\b`, "i"), label);
  }
  return `${reason}, enabled automatically.`;
}

export function detectPluginAutoEnableCandidates(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
}): PluginAutoEnableCandidate[] {
  const env = params.env ?? process.env;
  const config = params.config ?? ({} as OpenClawConfig);
  if (!configMayNeedPluginAutoEnable(config, env)) {
    return [];
  }
  const registry =
    params.manifestRegistry ??
    (configMayNeedPluginManifestRegistry(config)
      ? loadPluginManifestRegistry({ config, env })
      : EMPTY_PLUGIN_MANIFEST_REGISTRY);
  return resolveConfiguredPlugins(config, env, registry);
}

export function materializePluginAutoEnableCandidates(params: {
  config?: OpenClawConfig;
  candidates: readonly PluginAutoEnableCandidate[];
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
}): PluginAutoEnableResult {
  const env = params.env ?? process.env;
  let next = params.config ?? {};
  const changes: string[] = [];
  const autoEnabledReasons = new Map<string, string[]>();
  const registry =
    params.manifestRegistry ??
    (configMayNeedPluginManifestRegistry(next)
      ? loadPluginManifestRegistry({ config: next, env })
      : EMPTY_PLUGIN_MANIFEST_REGISTRY);

  if (next.plugins?.enabled === false) {
    return { config: next, changes, autoEnabledReasons: {} };
  }

  for (const entry of params.candidates) {
    const builtInChannelId = normalizeChatChannelId(entry.pluginId);
    if (isPluginDenied(next, entry.pluginId)) {
      continue;
    }
    if (isPluginExplicitlyDisabled(next, entry.pluginId)) {
      continue;
    }
    if (shouldSkipPreferredPluginAutoEnable(next, entry, [...params.candidates], env, registry)) {
      continue;
    }
    const allow = next.plugins?.allow;
    const allowMissing =
      builtInChannelId == null && Array.isArray(allow) && !allow.includes(entry.pluginId);
    const alreadyEnabled =
      builtInChannelId != null
        ? (() => {
            const channels = next.channels as Record<string, unknown> | undefined;
            const channelConfig = channels?.[builtInChannelId];
            if (
              !channelConfig ||
              typeof channelConfig !== "object" ||
              Array.isArray(channelConfig)
            ) {
              return false;
            }
            return (channelConfig as { enabled?: unknown }).enabled === true;
          })()
        : next.plugins?.entries?.[entry.pluginId]?.enabled === true;
    if (alreadyEnabled && !allowMissing) {
      continue;
    }
    next = registerPluginEntry(next, entry.pluginId);
    if (!builtInChannelId) {
      next = ensurePluginAllowlisted(next, entry.pluginId);
    }
    const reason = resolvePluginAutoEnableCandidateReason(entry);
    autoEnabledReasons.set(entry.pluginId, [
      ...(autoEnabledReasons.get(entry.pluginId) ?? []),
      reason,
    ]);
    changes.push(formatAutoEnableChange(entry));
  }

  const autoEnabledReasonRecord: Record<string, string[]> = Object.create(null);
  for (const [pluginId, reasons] of autoEnabledReasons) {
    if (isBlockedObjectKey(pluginId)) {
      continue;
    }
    autoEnabledReasonRecord[pluginId] = [...reasons];
  }

  return { config: next, changes, autoEnabledReasons: autoEnabledReasonRecord };
}

export function applyPluginAutoEnable(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  /** Pre-loaded manifest registry. When omitted, the registry is loaded from
   *  the installed plugins on disk. Pass an explicit registry in tests to
   *  avoid filesystem access and control what plugins are "installed". */
  manifestRegistry?: PluginManifestRegistry;
}): PluginAutoEnableResult {
  const candidates = detectPluginAutoEnableCandidates(params);
  return materializePluginAutoEnableCandidates({
    config: params.config,
    candidates,
    env: params.env,
    manifestRegistry: params.manifestRegistry,
  });
}
