import { hasAnyWhatsAppAuth } from "openclaw/plugin-sdk/whatsapp";
import { normalizeProviderId } from "../agents/model-selection.js";
import { hasMeaningfulChannelConfig } from "../channels/config-presence.js";
import { listChannelPluginCatalogEntries } from "../channels/plugins/catalog.js";
import {
  getChatChannelMeta,
  listChatChannels,
  normalizeChatChannelId,
} from "../channels/registry.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { discoverOpenClawPlugins, type PluginCandidate } from "../plugins/discovery.js";
import {
  loadPluginManifestRegistry,
  type PluginManifestRegistry,
} from "../plugins/manifest-registry.js";
import { loadPluginManifest } from "../plugins/manifest.js";
import { isPathInside, safeStatSync } from "../plugins/path-safety.js";
import { isRecord, resolveUserPath } from "../utils.js";
import type { OpenClawConfig } from "./config.js";
import { ensurePluginAllowlisted } from "./plugins-allowlist.js";

type PluginEnableChange = {
  pluginId: string;
  reason: string;
};

export type PluginAutoEnableResult = {
  config: OpenClawConfig;
  changes: string[];
};

type AutoEnableChannelCatalogEntry = {
  id: string;
  pluginId?: string;
  preferOver: string[];
};

type PathMatcher = {
  exact: Set<string>;
  dirs: string[];
};

type InstallTrackingRule = {
  trackedWithoutPaths: boolean;
  matcher: PathMatcher;
};

type PluginProvenanceIndex = {
  loadPathMatcher: PathMatcher;
  installRules: Map<string, InstallTrackingRule>;
};

const PROVIDER_PLUGIN_IDS: Array<{ pluginId: string; providerId: string }> = [
  { pluginId: "google", providerId: "google-gemini-cli" },
  { pluginId: "qwen-portal-auth", providerId: "qwen-portal" },
  { pluginId: "copilot-proxy", providerId: "copilot-proxy" },
  { pluginId: "minimax", providerId: "minimax-portal" },
];

function createPathMatcher(): PathMatcher {
  return { exact: new Set<string>(), dirs: [] };
}

function addPathToMatcher(matcher: PathMatcher, rawPath: string, env: NodeJS.ProcessEnv): void {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return;
  }
  const resolved = resolveUserPath(trimmed, env);
  if (!resolved) {
    return;
  }
  if (matcher.exact.has(resolved) || matcher.dirs.includes(resolved)) {
    return;
  }
  const stat = safeStatSync(resolved);
  if (stat?.isDirectory()) {
    matcher.dirs.push(resolved);
    return;
  }
  matcher.exact.add(resolved);
}

function matchesPathMatcher(matcher: PathMatcher, sourcePath: string): boolean {
  if (matcher.exact.has(sourcePath)) {
    return true;
  }
  return matcher.dirs.some((dirPath) => isPathInside(dirPath, sourcePath));
}

function buildProvenanceIndex(params: {
  config: OpenClawConfig;
  normalizedLoadPaths: string[];
  env: NodeJS.ProcessEnv;
}): PluginProvenanceIndex {
  const loadPathMatcher = createPathMatcher();
  for (const loadPath of params.normalizedLoadPaths) {
    addPathToMatcher(loadPathMatcher, loadPath, params.env);
  }

  const installRules = new Map<string, InstallTrackingRule>();
  const installs = params.config.plugins?.installs ?? {};
  for (const [pluginId, install] of Object.entries(installs)) {
    const rule: InstallTrackingRule = {
      trackedWithoutPaths: false,
      matcher: createPathMatcher(),
    };
    const trackedPaths = [install.installPath, install.sourcePath]
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
    if (trackedPaths.length === 0) {
      rule.trackedWithoutPaths = true;
    } else {
      for (const trackedPath of trackedPaths) {
        addPathToMatcher(rule.matcher, trackedPath, params.env);
      }
    }
    installRules.set(pluginId, rule);
  }

  return { loadPathMatcher, installRules };
}

function matchesExplicitInstallRule(params: {
  pluginId: string;
  source: string;
  index: PluginProvenanceIndex;
  env: NodeJS.ProcessEnv;
}): boolean {
  const sourcePath = resolveUserPath(params.source, params.env);
  const installRule = params.index.installRules.get(params.pluginId);
  if (!installRule || installRule.trackedWithoutPaths) {
    return false;
  }
  return matchesPathMatcher(installRule.matcher, sourcePath);
}

function resolveCandidateDuplicateRank(params: {
  candidate: PluginCandidate;
  pluginId: string;
  provenance: PluginProvenanceIndex;
  env: NodeJS.ProcessEnv;
}): number {
  const isExplicitInstall =
    params.candidate.origin === "global" &&
    matchesExplicitInstallRule({
      pluginId: params.pluginId,
      source: params.candidate.source,
      index: params.provenance,
      env: params.env,
    });

  if (params.candidate.origin === "config") {
    return 0;
  }
  if (params.candidate.origin === "global" && isExplicitInstall) {
    return 1;
  }
  if (params.candidate.origin === "bundled") {
    return 2;
  }
  if (params.candidate.origin === "workspace") {
    return 3;
  }
  return 4;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
}

function createAutoEnableChannelCatalogEntry(params: {
  id: string;
  pluginId?: string;
  preferOver?: unknown;
}): AutoEnableChannelCatalogEntry | null {
  const id = params.id.trim();
  if (!id) {
    return null;
  }
  const pluginId = typeof params.pluginId === "string" ? params.pluginId.trim() : "";
  return {
    id,
    ...(pluginId ? { pluginId } : {}),
    preferOver: normalizeStringList(params.preferOver),
  };
}

function buildAutoEnableChannelCatalogEntries(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): AutoEnableChannelCatalogEntry[] {
  const normalizedPlugins = normalizePluginsConfig(params.config.plugins);
  const uiCatalogEntries = listChannelPluginCatalogEntries({
    env: params.env,
    loadPaths: normalizedPlugins.loadPaths,
  });
  const resolved = new Map<string, { entry: AutoEnableChannelCatalogEntry; rank: number }>();
  const provenance = buildProvenanceIndex({
    config: params.config,
    normalizedLoadPaths: normalizedPlugins.loadPaths,
    env: params.env,
  });
  const discovery = discoverOpenClawPlugins({
    extraPaths: normalizedPlugins.loadPaths,
    env: params.env,
  });

  for (const candidate of discovery.candidates) {
    const channel = candidate.packageManifest?.channel;
    const channelId = typeof channel?.id === "string" ? channel.id.trim() : "";
    if (!channelId) {
      continue;
    }
    const manifestResult = loadPluginManifest(candidate.rootDir, candidate.origin !== "bundled");
    if (!manifestResult.ok) {
      continue;
    }
    const entry = createAutoEnableChannelCatalogEntry({
      id: channelId,
      pluginId: manifestResult.manifest.id,
      preferOver: channel?.preferOver,
    });
    if (!entry) {
      continue;
    }
    const rank = resolveCandidateDuplicateRank({
      candidate,
      pluginId: manifestResult.manifest.id,
      provenance,
      env: params.env,
    });
    const existing = resolved.get(entry.id);
    if (!existing || rank < existing.rank) {
      resolved.set(entry.id, { entry, rank });
    }
  }

  for (const entry of uiCatalogEntries) {
    if (resolved.has(entry.id)) {
      continue;
    }
    const normalizedEntry = createAutoEnableChannelCatalogEntry({
      id: entry.id,
      pluginId: entry.pluginId,
      preferOver: entry.meta.preferOver,
    });
    if (!normalizedEntry) {
      continue;
    }
    resolved.set(normalizedEntry.id, {
      entry: normalizedEntry,
      rank: Number.POSITIVE_INFINITY,
    });
  }

  return Array.from(resolved.values()).map(({ entry }) => entry);
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function accountsHaveKeys(value: unknown, keys: readonly string[]): boolean {
  if (!isRecord(value)) {
    return false;
  }
  for (const account of Object.values(value)) {
    if (!isRecord(account)) {
      continue;
    }
    for (const key of keys) {
      if (hasNonEmptyString(account[key])) {
        return true;
      }
    }
  }
  return false;
}

function resolveChannelConfig(
  cfg: OpenClawConfig,
  channelId: string,
): Record<string, unknown> | null {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const entry = channels?.[channelId];
  return isRecord(entry) ? entry : null;
}

type StructuredChannelConfigSpec = {
  envAny?: readonly string[];
  envAll?: readonly string[];
  stringKeys?: readonly string[];
  numberKeys?: readonly string[];
  accountStringKeys?: readonly string[];
};

const STRUCTURED_CHANNEL_CONFIG_SPECS: Record<string, StructuredChannelConfigSpec> = {
  telegram: {
    envAny: ["TELEGRAM_BOT_TOKEN"],
    stringKeys: ["botToken", "tokenFile"],
    accountStringKeys: ["botToken", "tokenFile"],
  },
  discord: {
    envAny: ["DISCORD_BOT_TOKEN"],
    stringKeys: ["token"],
    accountStringKeys: ["token"],
  },
  irc: {
    envAll: ["IRC_HOST", "IRC_NICK"],
    stringKeys: ["host", "nick"],
    accountStringKeys: ["host", "nick"],
  },
  slack: {
    envAny: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_USER_TOKEN"],
    stringKeys: ["botToken", "appToken", "userToken"],
    accountStringKeys: ["botToken", "appToken", "userToken"],
  },
  signal: {
    stringKeys: ["account", "httpUrl", "httpHost", "cliPath"],
    numberKeys: ["httpPort"],
    accountStringKeys: ["account", "httpUrl", "httpHost", "cliPath"],
  },
  imessage: {
    stringKeys: ["cliPath"],
  },
};

function envHasAnyKeys(env: NodeJS.ProcessEnv, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (hasNonEmptyString(env[key])) {
      return true;
    }
  }
  return false;
}

function envHasAllKeys(env: NodeJS.ProcessEnv, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (!hasNonEmptyString(env[key])) {
      return false;
    }
  }
  return keys.length > 0;
}

function hasAnyNumberKeys(entry: Record<string, unknown>, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (typeof entry[key] === "number") {
      return true;
    }
  }
  return false;
}

function isStructuredChannelConfigured(
  cfg: OpenClawConfig,
  channelId: string,
  env: NodeJS.ProcessEnv,
  spec: StructuredChannelConfigSpec,
): boolean {
  if (spec.envAny && envHasAnyKeys(env, spec.envAny)) {
    return true;
  }
  if (spec.envAll && envHasAllKeys(env, spec.envAll)) {
    return true;
  }
  const entry = resolveChannelConfig(cfg, channelId);
  if (!entry) {
    return false;
  }
  if (spec.stringKeys && spec.stringKeys.some((key) => hasNonEmptyString(entry[key]))) {
    return true;
  }
  if (spec.numberKeys && hasAnyNumberKeys(entry, spec.numberKeys)) {
    return true;
  }
  if (spec.accountStringKeys && accountsHaveKeys(entry.accounts, spec.accountStringKeys)) {
    return true;
  }
  return hasMeaningfulChannelConfig(entry);
}

function isWhatsAppConfigured(cfg: OpenClawConfig): boolean {
  if (hasAnyWhatsAppAuth(cfg)) {
    return true;
  }
  const entry = resolveChannelConfig(cfg, "whatsapp");
  if (!entry) {
    return false;
  }
  return hasMeaningfulChannelConfig(entry);
}

function isGenericChannelConfigured(cfg: OpenClawConfig, channelId: string): boolean {
  const entry = resolveChannelConfig(cfg, channelId);
  return hasMeaningfulChannelConfig(entry);
}

export function isChannelConfigured(
  cfg: OpenClawConfig,
  channelId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (channelId === "whatsapp") {
    return isWhatsAppConfigured(cfg);
  }
  const spec = STRUCTURED_CHANNEL_CONFIG_SPECS[channelId];
  if (spec) {
    return isStructuredChannelConfigured(cfg, channelId, env, spec);
  }
  return isGenericChannelConfigured(cfg, channelId);
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

function buildChannelToPluginIdMap(
  registry: PluginManifestRegistry,
  catalogEntries: readonly AutoEnableChannelCatalogEntry[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const record of registry.plugins) {
    for (const channelId of record.channels) {
      if (channelId && !map.has(channelId)) {
        map.set(channelId, record.id);
      }
    }
  }
  for (const entry of catalogEntries) {
    if (entry.id && entry.pluginId && !map.has(entry.id)) {
      map.set(entry.id, entry.pluginId);
    }
  }
  return map;
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

function findCatalogEntryForPluginId(
  pluginId: string,
  catalogEntries: readonly AutoEnableChannelCatalogEntry[],
): AutoEnableChannelCatalogEntry | undefined {
  return catalogEntries.find((entry) => entry.id === pluginId || entry.pluginId === pluginId);
}

function resolveChannelPreferenceKey(
  pluginId: string,
  catalogEntries: readonly AutoEnableChannelCatalogEntry[],
): string {
  const builtInId = normalizeChatChannelId(pluginId);
  if (builtInId) {
    return builtInId;
  }
  return findCatalogEntryForPluginId(pluginId, catalogEntries)?.id ?? pluginId;
}

function listKnownChannelPluginIds(
  catalogEntries: readonly AutoEnableChannelCatalogEntry[],
): string[] {
  return Array.from(
    new Set([
      ...listChatChannels().map((meta) => meta.id),
      ...catalogEntries.map((entry) => entry.id),
    ]),
  );
}

function collectCandidateChannelIds(
  cfg: OpenClawConfig,
  catalogEntries: readonly AutoEnableChannelCatalogEntry[],
): string[] {
  const channelIds = new Set<string>(listKnownChannelPluginIds(catalogEntries));
  const configuredChannels = cfg.channels as Record<string, unknown> | undefined;
  if (!configuredChannels || typeof configuredChannels !== "object") {
    return Array.from(channelIds);
  }
  for (const key of Object.keys(configuredChannels)) {
    if (key === "defaults" || key === "modelByChannel") {
      continue;
    }
    const normalizedBuiltIn = normalizeChatChannelId(key);
    channelIds.add(normalizedBuiltIn ?? key);
  }
  return Array.from(channelIds);
}

function resolveConfiguredPlugins(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  registry: PluginManifestRegistry,
  catalogEntries: readonly AutoEnableChannelCatalogEntry[],
): PluginEnableChange[] {
  const changes: PluginEnableChange[] = [];
  // Build reverse map: channel ID → plugin ID from installed plugin manifests.
  const channelToPluginId = buildChannelToPluginIdMap(registry, catalogEntries);
  for (const channelId of collectCandidateChannelIds(cfg, catalogEntries)) {
    const pluginId = resolvePluginIdForChannel(channelId, channelToPluginId);
    if (isChannelConfigured(cfg, channelId, env)) {
      changes.push({ pluginId, reason: `${channelId} configured` });
    }
  }

  for (const mapping of PROVIDER_PLUGIN_IDS) {
    if (isProviderConfigured(cfg, mapping.providerId)) {
      changes.push({
        pluginId: mapping.pluginId,
        reason: `${mapping.providerId} auth configured`,
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
  catalogEntries: readonly AutoEnableChannelCatalogEntry[],
): string[] {
  const preferenceKey = resolveChannelPreferenceKey(pluginId, catalogEntries);
  const builtInId = normalizeChatChannelId(preferenceKey);
  if (builtInId) {
    return getChatChannelMeta(builtInId).preferOver ?? [];
  }
  return findCatalogEntryForPluginId(pluginId, catalogEntries)?.preferOver ?? [];
}

function shouldSkipPreferredPluginAutoEnable(
  cfg: OpenClawConfig,
  entry: PluginEnableChange,
  configured: PluginEnableChange[],
  catalogEntries: readonly AutoEnableChannelCatalogEntry[],
): boolean {
  const entryPreferenceKey = resolveChannelPreferenceKey(entry.pluginId, catalogEntries);
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
    const preferOver = resolvePreferredOverIds(other.pluginId, catalogEntries);
    if (preferOver.includes(entryPreferenceKey)) {
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
  const registry =
    params.manifestRegistry ?? loadPluginManifestRegistry({ config: params.config, env });
  const catalogEntries = buildAutoEnableChannelCatalogEntries({ config: params.config, env });
  const configured = resolveConfiguredPlugins(params.config, env, registry, catalogEntries);
  if (configured.length === 0) {
    return { config: params.config, changes: [] };
  }

  let next = params.config;
  const changes: string[] = [];

  if (next.plugins?.enabled === false) {
    return { config: next, changes };
  }

  for (const entry of configured) {
    const builtInChannelId = normalizeChatChannelId(entry.pluginId);
    if (isPluginDenied(next, entry.pluginId)) {
      continue;
    }
    if (isPluginExplicitlyDisabled(next, entry.pluginId)) {
      continue;
    }
    if (shouldSkipPreferredPluginAutoEnable(next, entry, configured, catalogEntries)) {
      continue;
    }
    const allow = next.plugins?.allow;
    const allowMissing = Array.isArray(allow) && !allow.includes(entry.pluginId);
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
    if (allowMissing || !builtInChannelId) {
      next = ensurePluginAllowlisted(next, entry.pluginId);
    }
    changes.push(formatAutoEnableChange(entry));
  }

  return { config: next, changes };
}
