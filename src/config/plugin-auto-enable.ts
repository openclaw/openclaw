import fs from "node:fs";
import path from "node:path";
import { normalizeProviderId } from "../agents/model-selection.js";
import {
  hasPotentialConfiguredChannels,
  listPotentialConfiguredChannelIds,
} from "../channels/config-presence.js";
import { getChatChannelMeta, normalizeChatChannelId } from "../channels/registry.js";
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

type PluginEnableChange = {
  pluginId: string;
  reason: string;
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
  if (!configuredChannels || typeof configuredChannels !== "object") {
    return false;
  }
  for (const key of Object.keys(configuredChannels)) {
    if (key === "defaults" || key === "modelByChannel") {
      continue;
    }
    if (!normalizeChatChannelId(key)) {
      return true;
    }
  }
  return false;
}

function configMayNeedPluginAutoEnable(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  if (hasPotentialConfiguredChannels(cfg, env)) {
    return true;
  }
  if (resolveBrowserAutoEnableReason(cfg)) {
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

function resolveBrowserAutoEnableReason(cfg: OpenClawConfig): string | null {
  if (cfg.browser?.enabled === false || cfg.plugins?.entries?.browser?.enabled === false) {
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(cfg, "browser")) {
    return "browser configured";
  }

  if (hasExplicitBrowserPluginEntry(cfg)) {
    return "browser plugin configured";
  }

  if (hasBrowserToolReference(cfg)) {
    return "browser tool referenced";
  }

  return null;
}

function resolveConfiguredPlugins(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  registry: PluginManifestRegistry,
): PluginEnableChange[] {
  const changes: PluginEnableChange[] = [];
  // Build reverse map: channel ID → plugin ID from installed plugin manifests.
  const channelToPluginId = buildChannelToPluginIdMap(registry);
  for (const channelId of collectCandidateChannelIds(cfg, env)) {
    const pluginId = resolvePluginIdForChannel(channelId, channelToPluginId);
    if (isChannelConfigured(cfg, channelId, env)) {
      changes.push({ pluginId, reason: `${channelId} configured` });
    }
  }

  const browserReason = resolveBrowserAutoEnableReason(cfg);
  if (browserReason) {
    changes.push({ pluginId: "browser", reason: browserReason });
  }

  for (const [providerId, pluginId] of Object.entries(
    resolveAutoEnableProviderPluginIds(registry),
  )) {
    if (isProviderConfigured(cfg, providerId)) {
      changes.push({
        pluginId,
        reason: `${providerId} auth configured`,
      });
    }
  }
  const webFetchProvider =
    typeof cfg.tools?.web?.fetch?.provider === "string" ? cfg.tools.web.fetch.provider : undefined;
  const webFetchPluginId = resolvePluginIdForConfiguredWebFetchProvider(webFetchProvider);
  if (webFetchPluginId) {
    changes.push({
      pluginId: webFetchPluginId,
      reason: `${String(webFetchProvider).trim().toLowerCase()} web fetch provider selected`,
    });
  }
  for (const pluginId of resolveProviderPluginsWithOwnedWebSearch(registry)) {
    if (hasPluginOwnedWebSearchConfig(cfg, pluginId)) {
      changes.push({
        pluginId,
        reason: `${pluginId} web search configured`,
      });
    }
  }
  for (const pluginId of resolveProviderPluginsWithOwnedWebFetch()) {
    if (hasPluginOwnedWebFetchConfig(cfg, pluginId)) {
      changes.push({
        pluginId,
        reason: `${pluginId} web fetch configured`,
      });
    }
  }
  for (const pluginId of resolveProviderPluginsWithOwnedWebSearch(registry)) {
    if (hasPluginOwnedToolConfig(cfg, pluginId)) {
      changes.push({
        pluginId,
        reason: `${pluginId} tool configured`,
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
      reason: "ACP runtime configured",
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
  entry: PluginEnableChange,
  configured: PluginEnableChange[],
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

function formatAutoEnableChange(entry: PluginEnableChange): string {
  let reason = entry.reason.trim();
  const channelId = normalizeChatChannelId(entry.pluginId);
  if (channelId) {
    const label = getChatChannelMeta(channelId).label;
    reason = reason.replace(new RegExp(`^${channelId}\\b`, "i"), label);
  }
  return `${reason}, enabled automatically.`;
}

export function applyPluginAutoEnable(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  /** Pre-loaded manifest registry. When omitted, the registry is loaded from
   *  the installed plugins on disk. Pass an explicit registry in tests to
   *  avoid filesystem access and control what plugins are "installed". */
  manifestRegistry?: PluginManifestRegistry;
}): PluginAutoEnableResult {
  const env = params.env ?? process.env;
  if (!configMayNeedPluginAutoEnable(params.config, env)) {
    return { config: params.config, changes: [], autoEnabledReasons: {} };
  }
  const registry =
    params.manifestRegistry ??
    (configMayNeedPluginManifestRegistry(params.config)
      ? loadPluginManifestRegistry({ config: params.config, env })
      : EMPTY_PLUGIN_MANIFEST_REGISTRY);
  const configured = resolveConfiguredPlugins(params.config, env, registry);
  if (configured.length === 0) {
    return { config: params.config, changes: [], autoEnabledReasons: {} };
  }

  let next = params.config;
  const changes: string[] = [];
  const autoEnabledReasons = new Map<string, string[]>();

  if (next.plugins?.enabled === false) {
    return { config: next, changes, autoEnabledReasons: {} };
  }

  for (const entry of configured) {
    const builtInChannelId = normalizeChatChannelId(entry.pluginId);
    if (isPluginDenied(next, entry.pluginId)) {
      continue;
    }
    if (isPluginExplicitlyDisabled(next, entry.pluginId)) {
      continue;
    }
    if (shouldSkipPreferredPluginAutoEnable(next, entry, configured, env, registry)) {
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
    autoEnabledReasons.set(entry.pluginId, [
      ...(autoEnabledReasons.get(entry.pluginId) ?? []),
      entry.reason,
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
