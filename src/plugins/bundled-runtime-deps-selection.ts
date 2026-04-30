import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { readRuntimeDepsJsonObject, type JsonObject } from "./bundled-runtime-deps-json.js";
import {
  collectPackageRuntimeDeps,
  normalizeInstallableRuntimeDepName,
  parseInstallableRuntimeDep,
  type RuntimeDepEntry,
} from "./bundled-runtime-deps-specs.js";
import {
  normalizePluginsConfigWithResolver,
  type NormalizedPluginsConfig,
  type NormalizePluginId,
} from "./config-normalization-shared.js";

const MIRRORED_PACKAGE_RUNTIME_DEP_PLUGIN_ID = "openclaw-core";

export type RuntimeDepConflict = {
  name: string;
  versions: string[];
  pluginIdsByVersion: Map<string, string[]>;
};

export type BundledPluginRuntimeDepsManifest = {
  channels: string[];
  enabledByDefault: boolean;
  id?: string;
  legacyPluginIds: string[];
  providers: string[];
};

export type BundledPluginRuntimeDepsManifestCache = Map<string, BundledPluginRuntimeDepsManifest>;

function collectDeclaredMirroredRootRuntimeDepNames(packageJson: JsonObject): string[] {
  const openclaw = packageJson.openclaw;
  const bundle =
    openclaw && typeof openclaw === "object" && !Array.isArray(openclaw)
      ? (openclaw as JsonObject).bundle
      : undefined;
  const rawNames =
    bundle && typeof bundle === "object" && !Array.isArray(bundle)
      ? (bundle as JsonObject).mirroredRootRuntimeDependencies
      : undefined;
  if (rawNames === undefined) {
    return [];
  }
  if (!Array.isArray(rawNames)) {
    throw new Error("openclaw.bundle.mirroredRootRuntimeDependencies must be an array");
  }
  const names = new Set<string>();
  for (const rawName of rawNames) {
    if (typeof rawName !== "string") {
      throw new Error("openclaw.bundle.mirroredRootRuntimeDependencies must contain strings");
    }
    const normalizedName = normalizeInstallableRuntimeDepName(rawName);
    if (!normalizedName) {
      throw new Error(`Invalid mirrored bundled runtime dependency name: ${rawName}`);
    }
    names.add(normalizedName);
  }
  return [...names].toSorted((left, right) => left.localeCompare(right));
}

export function collectMirroredPackageRuntimeDeps(packageRoot: string | null): RuntimeDepEntry[] {
  if (!packageRoot) {
    return [];
  }
  const packageJson = readRuntimeDepsJsonObject(path.join(packageRoot, "package.json"));
  if (!packageJson) {
    return [];
  }
  const runtimeDeps = collectPackageRuntimeDeps(packageJson);
  const deps: RuntimeDepEntry[] = [];
  for (const name of collectDeclaredMirroredRootRuntimeDepNames(packageJson)) {
    const dep = parseInstallableRuntimeDep(name, runtimeDeps[name]);
    if (!dep) {
      throw new Error(
        `Declared mirrored bundled runtime dependency ${name} is missing from package dependencies`,
      );
    }
    deps.push({
      ...dep,
      pluginIds: [MIRRORED_PACKAGE_RUNTIME_DEP_PLUGIN_ID],
    });
  }
  return deps.toSorted((left, right) => {
    const nameOrder = left.name.localeCompare(right.name);
    return nameOrder === 0 ? left.version.localeCompare(right.version) : nameOrder;
  });
}

function readBundledPluginRuntimeDepsManifest(
  pluginDir: string,
  cache?: BundledPluginRuntimeDepsManifestCache,
): BundledPluginRuntimeDepsManifest {
  const cached = cache?.get(pluginDir);
  if (cached) {
    return cached;
  }
  const manifest = readRuntimeDepsJsonObject(path.join(pluginDir, "openclaw.plugin.json"));
  const channels = manifest?.channels;
  const legacyPluginIds = manifest?.legacyPluginIds;
  const providers = manifest?.providers;
  const runtimeDepsManifest = {
    channels: Array.isArray(channels)
      ? channels.filter((entry): entry is string => typeof entry === "string" && entry !== "")
      : [],
    enabledByDefault: manifest?.enabledByDefault === true,
    ...(typeof manifest?.id === "string" && manifest.id.trim() ? { id: manifest.id } : {}),
    legacyPluginIds: Array.isArray(legacyPluginIds)
      ? legacyPluginIds.filter(
          (entry): entry is string => typeof entry === "string" && entry !== "",
        )
      : [],
    providers: Array.isArray(providers)
      ? providers.filter((entry): entry is string => typeof entry === "string" && entry !== "")
      : [],
  };
  cache?.set(pluginDir, runtimeDepsManifest);
  return runtimeDepsManifest;
}

const BUILT_IN_RUNTIME_DEPS_PLUGIN_ALIAS_FALLBACKS: ReadonlyArray<
  readonly [alias: string, pluginId: string]
> = [
  ["openai-codex", "openai"],
  ["google-gemini-cli", "google"],
  ["minimax-portal", "minimax"],
  ["minimax-portal-auth", "minimax"],
] as const;

function addBundledRuntimeDepsPluginAlias(
  lookup: Map<string, string>,
  alias: string | undefined,
  pluginId: string,
): void {
  const normalizedAlias = normalizeOptionalLowercaseString(alias);
  if (normalizedAlias) {
    lookup.set(normalizedAlias, pluginId);
  }
}

export function createBundledRuntimeDepsPluginIdNormalizer(params: {
  extensionsDir: string;
  manifestCache: BundledPluginRuntimeDepsManifestCache;
}): NormalizePluginId {
  const lookup = new Map<string, string>();
  for (const [alias, pluginId] of BUILT_IN_RUNTIME_DEPS_PLUGIN_ALIAS_FALLBACKS) {
    lookup.set(alias, pluginId);
    lookup.set(pluginId, pluginId);
  }
  if (!fs.existsSync(params.extensionsDir)) {
    return (id) => {
      const trimmed = id.trim();
      const normalized = normalizeOptionalLowercaseString(trimmed);
      return (normalized && lookup.get(normalized)) || trimmed;
    };
  }
  for (const entry of fs.readdirSync(params.extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const fallbackPluginId = entry.name;
    const pluginDir = path.join(params.extensionsDir, fallbackPluginId);
    const manifest = readBundledPluginRuntimeDepsManifest(pluginDir, params.manifestCache);
    const pluginId = manifest.id ?? fallbackPluginId;
    addBundledRuntimeDepsPluginAlias(lookup, pluginId, pluginId);
    addBundledRuntimeDepsPluginAlias(lookup, fallbackPluginId, pluginId);
    for (const providerId of manifest.providers) {
      addBundledRuntimeDepsPluginAlias(lookup, providerId, pluginId);
    }
    for (const legacyPluginId of manifest.legacyPluginIds) {
      addBundledRuntimeDepsPluginAlias(lookup, legacyPluginId, pluginId);
    }
  }
  return (id) => {
    const trimmed = id.trim();
    const normalized = normalizeOptionalLowercaseString(trimmed);
    return (normalized && lookup.get(normalized)) || trimmed;
  };
}

function passesRuntimeDepsPluginPolicy(params: {
  pluginId: string;
  plugins: NormalizedPluginsConfig;
  allowExplicitlyDisabled?: boolean;
  allowRestrictiveAllowlistBypass?: boolean;
}): boolean {
  if (!params.plugins.enabled) {
    return false;
  }
  if (params.plugins.deny.includes(params.pluginId)) {
    return false;
  }
  if (
    params.plugins.entries[params.pluginId]?.enabled === false &&
    params.allowExplicitlyDisabled !== true
  ) {
    return false;
  }
  return (
    params.allowRestrictiveAllowlistBypass === true ||
    params.plugins.allow.length === 0 ||
    params.plugins.allow.includes(params.pluginId)
  );
}

export function isBundledPluginConfiguredForRuntimeDeps(params: {
  config: OpenClawConfig;
  plugins: NormalizedPluginsConfig;
  pluginId: string;
  pluginDir: string;
  includeConfiguredChannels?: boolean;
  manifestCache?: BundledPluginRuntimeDepsManifestCache;
}): boolean {
  if (
    !passesRuntimeDepsPluginPolicy({
      pluginId: params.pluginId,
      plugins: params.plugins,
      allowRestrictiveAllowlistBypass: true,
    })
  ) {
    return false;
  }
  const entry = params.plugins.entries[params.pluginId];
  const manifest = readBundledPluginRuntimeDepsManifest(params.pluginDir, params.manifestCache);
  if (
    params.plugins.slots.memory === params.pluginId ||
    params.plugins.slots.contextEngine === params.pluginId
  ) {
    return true;
  }
  let hasExplicitChannelDisable = false;
  let hasConfiguredChannel = false;
  for (const channelId of manifest.channels) {
    const normalizedChannelId = normalizeOptionalLowercaseString(channelId);
    if (!normalizedChannelId) {
      continue;
    }
    const channelConfig = (params.config.channels as Record<string, unknown> | undefined)?.[
      normalizedChannelId
    ];
    if (
      channelConfig &&
      typeof channelConfig === "object" &&
      !Array.isArray(channelConfig) &&
      (channelConfig as { enabled?: unknown }).enabled === false
    ) {
      hasExplicitChannelDisable = true;
      continue;
    }
    if (
      channelConfig &&
      typeof channelConfig === "object" &&
      !Array.isArray(channelConfig) &&
      (channelConfig as { enabled?: unknown }).enabled === true
    ) {
      return true;
    }
    if (
      channelConfig &&
      typeof channelConfig === "object" &&
      !Array.isArray(channelConfig) &&
      params.includeConfiguredChannels
    ) {
      hasConfiguredChannel = true;
    }
  }
  if (hasExplicitChannelDisable) {
    return false;
  }
  if (params.plugins.allow.length > 0 && !params.plugins.allow.includes(params.pluginId)) {
    return false;
  }
  if (entry?.enabled === true) {
    return true;
  }
  if (hasConfiguredChannel) {
    return true;
  }
  return manifest.enabledByDefault;
}

function isBundledPluginExplicitlyDisabledForRuntimeDeps(params: {
  config: OpenClawConfig;
  plugins: NormalizedPluginsConfig;
  pluginId: string;
  pluginDir: string;
  manifestCache?: BundledPluginRuntimeDepsManifestCache;
}): boolean {
  if (params.plugins.entries[params.pluginId]?.enabled === false) {
    return true;
  }
  const manifest = readBundledPluginRuntimeDepsManifest(params.pluginDir, params.manifestCache);
  return manifest.channels.some((channelId) => {
    const normalizedChannelId = normalizeOptionalLowercaseString(channelId);
    if (!normalizedChannelId) {
      return false;
    }
    const channelConfig = (params.config.channels as Record<string, unknown> | undefined)?.[
      normalizedChannelId
    ];
    return (
      channelConfig &&
      typeof channelConfig === "object" &&
      !Array.isArray(channelConfig) &&
      (channelConfig as { enabled?: unknown }).enabled === false
    );
  });
}

function shouldIncludeBundledPluginRuntimeDeps(params: {
  config?: OpenClawConfig;
  plugins?: NormalizedPluginsConfig;
  pluginIds?: ReadonlySet<string>;
  selectedPluginIds?: ReadonlySet<string>;
  pluginId: string;
  pluginDir: string;
  includeConfiguredChannels?: boolean;
  manifestCache?: BundledPluginRuntimeDepsManifestCache;
}): boolean {
  if (params.selectedPluginIds) {
    return (
      params.selectedPluginIds.has(params.pluginId) &&
      !(
        params.config &&
        params.plugins &&
        isBundledPluginExplicitlyDisabledForRuntimeDeps({
          config: params.config,
          plugins: params.plugins,
          pluginId: params.pluginId,
          pluginDir: params.pluginDir,
          manifestCache: params.manifestCache,
        })
      )
    );
  }
  const scopedToPluginIds = Boolean(params.pluginIds);
  if (params.pluginIds) {
    if (!params.pluginIds.has(params.pluginId)) {
      return false;
    }
    if (!params.config) {
      return true;
    }
  }
  if (!params.config) {
    return true;
  }
  if (scopedToPluginIds) {
    if (!params.plugins) {
      return true;
    }
    return passesRuntimeDepsPluginPolicy({
      pluginId: params.pluginId,
      plugins: params.plugins,
      allowRestrictiveAllowlistBypass: true,
    });
  }
  if (!params.plugins) {
    return false;
  }
  return isBundledPluginConfiguredForRuntimeDeps({
    config: params.config,
    plugins: params.plugins,
    pluginId: params.pluginId,
    pluginDir: params.pluginDir,
    includeConfiguredChannels: params.includeConfiguredChannels,
    manifestCache: params.manifestCache,
  });
}

export function collectBundledPluginRuntimeDeps(params: {
  extensionsDir: string;
  config?: OpenClawConfig;
  pluginIds?: ReadonlySet<string>;
  selectedPluginIds?: ReadonlySet<string>;
  includeConfiguredChannels?: boolean;
  manifestCache?: BundledPluginRuntimeDepsManifestCache;
  normalizePluginId?: NormalizePluginId;
}): {
  deps: RuntimeDepEntry[];
  conflicts: RuntimeDepConflict[];
  pluginIds: string[];
} {
  const versionMap = new Map<string, Map<string, Set<string>>>();
  const manifestCache: BundledPluginRuntimeDepsManifestCache = params.manifestCache ?? new Map();
  const needsPluginIdNormalizer = Boolean(params.config);
  const normalizePluginId =
    params.normalizePluginId ??
    (needsPluginIdNormalizer
      ? createBundledRuntimeDepsPluginIdNormalizer({
          extensionsDir: params.extensionsDir,
          manifestCache,
        })
      : undefined);
  const plugins = params.config
    ? normalizePluginsConfigWithResolver(params.config.plugins, normalizePluginId)
    : undefined;
  const includedPluginIds = new Set<string>();

  for (const entry of fs.readdirSync(params.extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const pluginId = entry.name;
    const pluginDir = path.join(params.extensionsDir, pluginId);
    if (
      !shouldIncludeBundledPluginRuntimeDeps({
        config: params.config,
        plugins,
        pluginIds: params.pluginIds,
        selectedPluginIds: params.selectedPluginIds,
        pluginId,
        pluginDir,
        includeConfiguredChannels: params.includeConfiguredChannels,
        manifestCache,
      })
    ) {
      continue;
    }
    includedPluginIds.add(pluginId);
    const packageJson = readRuntimeDepsJsonObject(path.join(pluginDir, "package.json"));
    if (!packageJson) {
      continue;
    }
    for (const [name, rawVersion] of Object.entries(collectPackageRuntimeDeps(packageJson))) {
      const dep = parseInstallableRuntimeDep(name, rawVersion);
      if (!dep) {
        continue;
      }
      const byVersion = versionMap.get(dep.name) ?? new Map<string, Set<string>>();
      const pluginIds = byVersion.get(dep.version) ?? new Set<string>();
      pluginIds.add(pluginId);
      byVersion.set(dep.version, pluginIds);
      versionMap.set(dep.name, byVersion);
    }
  }

  const deps: RuntimeDepEntry[] = [];
  const conflicts: RuntimeDepConflict[] = [];
  for (const [name, byVersion] of versionMap.entries()) {
    if (byVersion.size === 1) {
      const [version, pluginIds] = [...byVersion.entries()][0] ?? [];
      if (version) {
        deps.push({
          name,
          version,
          pluginIds: [...pluginIds].toSorted((a, b) => a.localeCompare(b)),
        });
      }
      continue;
    }
    const versions = [...byVersion.keys()].toSorted((a, b) => a.localeCompare(b));
    const pluginIdsByVersion = new Map<string, string[]>();
    for (const [version, pluginIds] of byVersion.entries()) {
      pluginIdsByVersion.set(
        version,
        [...pluginIds].toSorted((a, b) => a.localeCompare(b)),
      );
    }
    conflicts.push({
      name,
      versions,
      pluginIdsByVersion,
    });
  }

  return {
    deps: deps.toSorted((a, b) => a.name.localeCompare(b.name)),
    conflicts: conflicts.toSorted((a, b) => a.name.localeCompare(b.name)),
    pluginIds: [...includedPluginIds].toSorted((a, b) => a.localeCompare(b)),
  };
}

export function normalizePluginIdSet(
  pluginIds: readonly string[] | undefined,
  normalizePluginId: NormalizePluginId = (id) => normalizeOptionalLowercaseString(id) ?? "",
): ReadonlySet<string> | undefined {
  if (!pluginIds) {
    return undefined;
  }
  const normalized = pluginIds
    .map((entry) => normalizePluginId(entry))
    .filter((entry): entry is string => Boolean(entry));
  return new Set(normalized);
}
