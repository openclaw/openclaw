import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import type { PluginCandidate } from "./discovery.js";
import { hashJson } from "./installed-plugin-index-hash.js";
import { resolveInstalledPluginIndexStorePath } from "./installed-plugin-index-store-path.js";
import type { InstalledPluginIndex, InstalledPluginIndexRecord } from "./installed-plugin-index.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "./installed-plugin-index.js";
import { loadPluginManifestRegistry, type PluginManifestRegistry } from "./manifest-registry.js";
import type { BundledChannelConfigCollector } from "./manifest-registry.js";
import {
  DEFAULT_PLUGIN_ENTRY_CANDIDATES,
  getPackageManifestMetadata,
  type OpenClawPackageManifest,
  type PackageManifest,
} from "./manifest.js";
import { tracePluginLifecyclePhase } from "./plugin-lifecycle-trace.js";

// ---------------------------------------------------------------------------
// Bounded LRU memoization cache
// ---------------------------------------------------------------------------

const MANIFEST_REGISTRY_INSTALLED_CACHE_MAX_ENTRIES = 16;

type ManifestRegistryCacheEntry = {
  registry: PluginManifestRegistry;
  /** mtime (ms) of the persisted installs.json at the time the entry was built; null if the file was absent. */
  indexMtimeMs: number | null;
  /** env used to locate the persisted index path, so we can re-stat the same file on hit. */
  env: NodeJS.ProcessEnv;
};

/**
 * Module-level LRU cache.  Map insertion order == LRU order: oldest (least
 * recently used) entry is the first key returned by `map.keys()`.
 */
const manifestRegistryInstalledCache = new Map<string, ManifestRegistryCacheEntry>();

function buildManifestRegistryCacheKey(params: {
  index: InstalledPluginIndex;
  env: NodeJS.ProcessEnv;
  workspaceDir?: string;
  pluginIds?: readonly string[] | null;
  includeDisabled?: boolean;
}): string {
  const sortedPluginIds = params.pluginIds?.length ? [...params.pluginIds].toSorted() : null;
  // Use the full index fingerprint (includes per-manifest safeFileSignature/mtime)
  // rather than just policyHash so that manifest file edits invalidate the key.
  // resolveInstalledManifestRegistryIndexFingerprint does O(n) statSync calls,
  // which is far cheaper than the O(n) readFileSync+JSON.parse calls we're caching.
  const indexFingerprint = resolveInstalledManifestRegistryIndexFingerprint(params.index);
  return hashJson({
    indexFingerprint,
    includeDisabled: params.includeDisabled ?? false,
    pluginIds: sortedPluginIds,
    workspaceDir: params.workspaceDir ?? "",
    hostContractVersion: resolveCompatibilityHostVersion(params.env),
  });
}

function resolveIndexStoreMtimeMs(env: NodeJS.ProcessEnv): number | null {
  try {
    const indexPath = resolveInstalledPluginIndexStorePath({ env });
    return fs.statSync(indexPath).mtimeMs;
  } catch {
    return null;
  }
}

function getCachedManifestRegistry(key: string): ManifestRegistryCacheEntry | undefined {
  const entry = manifestRegistryInstalledCache.get(key);
  if (!entry) {
    return undefined;
  }
  // Defensive secondary: if installs.json is newer than when we cached, evict.
  const currentMtimeMs = resolveIndexStoreMtimeMs(entry.env);
  if (
    currentMtimeMs !== null &&
    (entry.indexMtimeMs === null || currentMtimeMs > entry.indexMtimeMs)
  ) {
    manifestRegistryInstalledCache.delete(key);
    return undefined;
  }
  // Refresh LRU position (move to end).
  manifestRegistryInstalledCache.delete(key);
  manifestRegistryInstalledCache.set(key, entry);
  return entry;
}

function setCachedManifestRegistry(key: string, entry: ManifestRegistryCacheEntry): void {
  if (
    manifestRegistryInstalledCache.size >= MANIFEST_REGISTRY_INSTALLED_CACHE_MAX_ENTRIES &&
    !manifestRegistryInstalledCache.has(key)
  ) {
    // Evict least-recently-used (first entry in insertion-order Map).
    const oldestKey = manifestRegistryInstalledCache.keys().next().value;
    if (oldestKey !== undefined) {
      manifestRegistryInstalledCache.delete(oldestKey);
    }
  }
  // Delete first so the re-set moves the key to the end (latest position).
  manifestRegistryInstalledCache.delete(key);
  manifestRegistryInstalledCache.set(key, entry);
}

/**
 * Clears the entire manifest-registry-installed LRU cache.
 *
 * Called by `clearCurrentPluginMetadataSnapshotState()` co-callers in
 * `installed-plugin-index-store.ts` whenever the persisted index is written,
 * ensuring stale entries are never served after an install/refresh.
 */
export function clearManifestRegistryInstalledCache(): void {
  manifestRegistryInstalledCache.clear();
}

function resolvePackageJsonPath(record: InstalledPluginIndexRecord): string | undefined {
  if (!record.packageJson?.path) {
    return undefined;
  }
  const rootDir = resolveInstalledPluginRootDir(record);
  const packageJsonPath = path.resolve(rootDir, record.packageJson.path);
  const relative = path.relative(rootDir, packageJsonPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return packageJsonPath;
}

function safeFileSignature(filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }
  try {
    const stat = fs.statSync(filePath);
    return `${filePath}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return `${filePath}:missing`;
  }
}

function buildInstalledManifestRegistryIndexKey(index: InstalledPluginIndex) {
  return {
    version: index.version,
    hostContractVersion: index.hostContractVersion,
    compatRegistryVersion: index.compatRegistryVersion,
    migrationVersion: index.migrationVersion,
    policyHash: index.policyHash,
    installRecords: index.installRecords,
    diagnostics: index.diagnostics,
    plugins: index.plugins.map((record) => {
      const packageJsonPath = resolvePackageJsonPath(record);
      return {
        pluginId: record.pluginId,
        packageName: record.packageName,
        packageVersion: record.packageVersion,
        installRecord: record.installRecord,
        installRecordHash: record.installRecordHash,
        packageInstall: record.packageInstall,
        packageChannel: record.packageChannel,
        manifestPath: record.manifestPath,
        manifestHash: record.manifestHash,
        manifestFile: safeFileSignature(record.manifestPath),
        format: record.format,
        bundleFormat: record.bundleFormat,
        source: record.source,
        setupSource: record.setupSource,
        packageJson: record.packageJson,
        packageJsonFile: safeFileSignature(packageJsonPath),
        rootDir: record.rootDir,
        origin: record.origin,
        enabled: record.enabled,
        enabledByDefault: record.enabledByDefault,
        syntheticAuthRefs: record.syntheticAuthRefs,
        startup: record.startup,
        compat: record.compat,
      };
    }),
  };
}

export function resolveInstalledManifestRegistryIndexFingerprint(
  index: InstalledPluginIndex,
): string {
  return hashJson(buildInstalledManifestRegistryIndexKey(index));
}

function resolveInstalledPluginRootDir(record: InstalledPluginIndexRecord): string {
  return record.rootDir || path.dirname(record.manifestPath || process.cwd());
}

function resolveFallbackPluginSource(record: InstalledPluginIndexRecord): string {
  const rootDir = resolveInstalledPluginRootDir(record);
  for (const entry of DEFAULT_PLUGIN_ENTRY_CANDIDATES) {
    const candidate = path.join(rootDir, entry);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(rootDir, DEFAULT_PLUGIN_ENTRY_CANDIDATES[0]);
}

function resolveInstalledPackageManifest(
  record: InstalledPluginIndexRecord,
): OpenClawPackageManifest | undefined {
  if (!record.packageChannel) {
    return undefined;
  }
  if (record.packageChannel.commands) {
    return { channel: record.packageChannel };
  }
  const rootDir = resolveInstalledPluginRootDir(record);
  const packageJsonPath = record.packageJson?.path
    ? path.resolve(rootDir, record.packageJson.path)
    : undefined;
  if (!packageJsonPath) {
    return { channel: record.packageChannel };
  }
  const relative = path.relative(rootDir, packageJsonPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { channel: record.packageChannel };
  }
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as PackageManifest;
    const packageManifest = getPackageManifestMetadata(packageJson);
    return {
      channel: {
        ...record.packageChannel,
        ...(packageManifest?.channel?.commands
          ? { commands: packageManifest.channel.commands }
          : {}),
      },
    };
  } catch {
    return { channel: record.packageChannel };
  }
}

function toPluginCandidate(record: InstalledPluginIndexRecord): PluginCandidate {
  const rootDir = resolveInstalledPluginRootDir(record);
  const packageManifest = resolveInstalledPackageManifest(record);
  return {
    idHint: record.pluginId,
    source: record.source ?? resolveFallbackPluginSource(record),
    ...(record.setupSource ? { setupSource: record.setupSource } : {}),
    rootDir,
    origin: record.origin,
    ...(record.format ? { format: record.format } : {}),
    ...(record.bundleFormat ? { bundleFormat: record.bundleFormat } : {}),
    ...(record.packageName ? { packageName: record.packageName } : {}),
    ...(record.packageVersion ? { packageVersion: record.packageVersion } : {}),
    ...(packageManifest ? { packageManifest } : {}),
    packageDir: rootDir,
  };
}

export function loadPluginManifestRegistryForInstalledIndex(params: {
  index: InstalledPluginIndex;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
  includeDisabled?: boolean;
  bundledChannelConfigCollector?: BundledChannelConfigCollector;
}): PluginManifestRegistry {
  // Short-circuit: empty pluginIds is always an empty registry — no need to cache.
  if (params.pluginIds && params.pluginIds.length === 0) {
    return { plugins: [], diagnostics: [] };
  }

  const env = params.env ?? process.env;

  // Bypass cache when a bundledChannelConfigCollector is supplied (stateful
  // collector; result must not be shared across callers).
  if (!params.bundledChannelConfigCollector) {
    const cacheKey = buildManifestRegistryCacheKey({
      index: params.index,
      env,
      workspaceDir: params.workspaceDir,
      pluginIds: params.pluginIds ?? null,
      includeDisabled: params.includeDisabled,
    });
    const hit = getCachedManifestRegistry(cacheKey);
    if (hit) {
      return hit.registry;
    }

    const registry = buildManifestRegistry(params, env);
    setCachedManifestRegistry(cacheKey, {
      registry,
      indexMtimeMs: resolveIndexStoreMtimeMs(env),
      env,
    });
    return registry;
  }

  return buildManifestRegistry(params, env);
}

function buildManifestRegistry(
  params: Parameters<typeof loadPluginManifestRegistryForInstalledIndex>[0],
  env: NodeJS.ProcessEnv,
): PluginManifestRegistry {
  return tracePluginLifecyclePhase(
    "manifest registry",
    () => {
      const pluginIdSet = params.pluginIds?.length ? new Set(params.pluginIds) : null;
      const diagnostics = pluginIdSet
        ? params.index.diagnostics.filter((diagnostic) => {
            const pluginId = diagnostic.pluginId;
            return !pluginId || pluginIdSet.has(pluginId);
          })
        : params.index.diagnostics;
      const candidates = params.index.plugins
        .filter((plugin) => params.includeDisabled || plugin.enabled)
        .filter((plugin) => !pluginIdSet || pluginIdSet.has(plugin.pluginId))
        .map(toPluginCandidate);
      return loadPluginManifestRegistry({
        config: params.config,
        workspaceDir: params.workspaceDir,
        env,
        candidates,
        diagnostics: [...diagnostics],
        installRecords: extractPluginInstallRecordsFromInstalledPluginIndex(params.index),
        ...(params.bundledChannelConfigCollector
          ? { bundledChannelConfigCollector: params.bundledChannelConfigCollector }
          : {}),
      });
    },
    {
      includeDisabled: params.includeDisabled === true,
      pluginIdCount: params.pluginIds?.length,
      indexPluginCount: params.index.plugins.length,
    },
  );
}
