import fs from "node:fs";
import type { OpenClawConfig } from "../config/config.js";
import { resolveUserPath } from "../utils.js";
import { loadBundleManifest } from "./bundle-manifest.js";
import { normalizePluginsConfig, type NormalizedPluginsConfig } from "./config-state.js";
import { discoverOpenClawPlugins, type PluginCandidate } from "./discovery.js";
import { loadPluginManifest, type PluginManifest } from "./manifest.js";
import { isPathInside, safeRealpathSync } from "./path-safety.js";
import { resolvePluginCacheInputs } from "./roots.js";
import type {
  PluginBundleFormat,
  PluginConfigUiHint,
  PluginDiagnostic,
  PluginFormat,
  PluginKind,
  PluginOrigin,
} from "./types.js";

type SeenIdEntry = {
  candidate: PluginCandidate;
  recordIndex: number;
};

// Canonicalize identical physical plugin roots with the most explicit source.
// This only applies when multiple candidates resolve to the same on-disk plugin.
const PLUGIN_ORIGIN_RANK: Readonly<Record<PluginOrigin, number>> = {
  config: 0,
  workspace: 1,
  global: 2,
  bundled: 3,
};

export type PluginManifestRecord = {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  enabledByDefault?: boolean;
  format?: PluginFormat;
  bundleFormat?: PluginBundleFormat;
  bundleCapabilities?: string[];
  kind?: PluginKind;
  channels: string[];
  providers: string[];
  providerAuthEnvVars?: Record<string, string[]>;
  providerAuthChoices?: PluginManifest["providerAuthChoices"];
  skills: string[];
  settingsFiles?: string[];
  hooks: string[];
  origin: PluginOrigin;
  workspaceDir?: string;
  rootDir: string;
  source: string;
  setupSource?: string;
  startupDeferConfiguredChannelFullLoadUntilAfterListen?: boolean;
  manifestPath: string;
  schemaCacheKey?: string;
  configSchema?: Record<string, unknown>;
  configUiHints?: Record<string, PluginConfigUiHint>;
};

export type PluginManifestRegistry = {
  plugins: PluginManifestRecord[];
  diagnostics: PluginDiagnostic[];
};

const registryCache = new Map<string, { expiresAt: number; registry: PluginManifestRegistry }>();

// Keep a short cache window to collapse bursty reloads during startup flows.
const DEFAULT_MANIFEST_CACHE_MS = 1000;

export function clearPluginManifestRegistryCache(): void {
  registryCache.clear();
}

function resolveManifestCacheMs(env: NodeJS.ProcessEnv): number {
  const raw = env.OPENCLAW_PLUGIN_MANIFEST_CACHE_MS?.trim();
  if (raw === "" || raw === "0") {
    return 0;
  }
  if (!raw) {
    return DEFAULT_MANIFEST_CACHE_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MANIFEST_CACHE_MS;
  }
  return Math.max(0, parsed);
}

function shouldUseManifestCache(env: NodeJS.ProcessEnv): boolean {
  const disabled = env.OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE?.trim();
  if (disabled) {
    return false;
  }
  return resolveManifestCacheMs(env) > 0;
}

function buildCacheKey(params: {
  workspaceDir?: string;
  plugins: NormalizedPluginsConfig;
  env: NodeJS.ProcessEnv;
}): string {
  const { roots, loadPaths } = resolvePluginCacheInputs({
    workspaceDir: params.workspaceDir,
    loadPaths: params.plugins.loadPaths,
    env: params.env,
  });
  const workspaceKey = roots.workspace ?? "";
  const configExtensionsRoot = roots.global;
  const bundledRoot = roots.stock ?? "";
  // The manifest registry only depends on where plugins are discovered from (workspace + load paths).
  // It does not depend on allow/deny/entries enable-state, so exclude those for higher cache hit rates.
  return `${workspaceKey}::${configExtensionsRoot}::${bundledRoot}::${JSON.stringify(loadPaths)}`;
}

function safeStatMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function normalizeManifestLabel(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function isCompatiblePluginIdHint(idHint: string | undefined, manifestId: string): boolean {
  const normalizedHint = idHint?.trim();
  if (!normalizedHint) {
    return true;
  }
  if (normalizedHint === manifestId) {
    return true;
  }
  return (
    normalizedHint === `${manifestId}-provider` ||
    normalizedHint === `${manifestId}-plugin` ||
    normalizedHint === `${manifestId}-sandbox`
  );
}

function buildRecord(params: {
  manifest: PluginManifest;
  candidate: PluginCandidate;
  manifestPath: string;
  schemaCacheKey?: string;
  configSchema?: Record<string, unknown>;
}): PluginManifestRecord {
  return {
    id: params.manifest.id,
    name: normalizeManifestLabel(params.manifest.name) ?? params.candidate.packageName,
    description:
      normalizeManifestLabel(params.manifest.description) ?? params.candidate.packageDescription,
    version: normalizeManifestLabel(params.manifest.version) ?? params.candidate.packageVersion,
    enabledByDefault: params.manifest.enabledByDefault === true ? true : undefined,
    format: params.candidate.format ?? "openclaw",
    bundleFormat: params.candidate.bundleFormat,
    kind: params.manifest.kind,
    channels: params.manifest.channels ?? [],
    providers: params.manifest.providers ?? [],
    providerAuthEnvVars: params.manifest.providerAuthEnvVars,
    providerAuthChoices: params.manifest.providerAuthChoices,
    skills: params.manifest.skills ?? [],
    settingsFiles: [],
    hooks: [],
    origin: params.candidate.origin,
    workspaceDir: params.candidate.workspaceDir,
    rootDir: params.candidate.rootDir,
    source: params.candidate.source,
    setupSource: params.candidate.setupSource,
    startupDeferConfiguredChannelFullLoadUntilAfterListen:
      params.candidate.packageManifest?.startup?.deferConfiguredChannelFullLoadUntilAfterListen ===
      true,
    manifestPath: params.manifestPath,
    schemaCacheKey: params.schemaCacheKey,
    configSchema: params.configSchema,
    configUiHints: params.manifest.uiHints,
  };
}

function buildBundleRecord(params: {
  manifest: {
    id: string;
    name?: string;
    description?: string;
    version?: string;
    skills: string[];
    settingsFiles?: string[];
    hooks: string[];
    capabilities: string[];
  };
  candidate: PluginCandidate;
  manifestPath: string;
}): PluginManifestRecord {
  return {
    id: params.manifest.id,
    name: normalizeManifestLabel(params.manifest.name) ?? params.candidate.idHint,
    description: normalizeManifestLabel(params.manifest.description),
    version: normalizeManifestLabel(params.manifest.version),
    format: "bundle",
    bundleFormat: params.candidate.bundleFormat,
    bundleCapabilities: params.manifest.capabilities,
    channels: [],
    providers: [],
    skills: params.manifest.skills ?? [],
    settingsFiles: params.manifest.settingsFiles ?? [],
    hooks: params.manifest.hooks ?? [],
    origin: params.candidate.origin,
    workspaceDir: params.candidate.workspaceDir,
    rootDir: params.candidate.rootDir,
    source: params.candidate.source,
    manifestPath: params.manifestPath,
    schemaCacheKey: undefined,
    configSchema: undefined,
    configUiHints: undefined,
  };
}

function matchesInstalledPluginRecord(params: {
  pluginId: string;
  candidate: PluginCandidate;
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): boolean {
  if (params.candidate.origin !== "global") {
    return false;
  }
  const record = params.config?.plugins?.installs?.[params.pluginId];
  if (!record) {
    return false;
  }
  const candidateSource = resolveUserPath(params.candidate.source, params.env);
  const trackedPaths = [record.installPath, record.sourcePath]
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => resolveUserPath(entry, params.env));
  if (trackedPaths.length === 0) {
    return false;
  }
  return trackedPaths.some((trackedPath) => {
    return candidateSource === trackedPath || isPathInside(trackedPath, candidateSource);
  });
}

function resolveDuplicatePrecedenceRank(params: {
  pluginId: string;
  candidate: PluginCandidate;
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): number {
  if (params.candidate.origin === "config") {
    return 0;
  }
  if (
    params.candidate.origin === "global" &&
    matchesInstalledPluginRecord({
      pluginId: params.pluginId,
      candidate: params.candidate,
      config: params.config,
      env: params.env,
    })
  ) {
    return 1;
  }
  if (params.candidate.origin === "bundled") {
    // Bundled plugin ids are reserved unless the operator explicitly overrides them.
    return 2;
  }
  if (params.candidate.origin === "workspace") {
    return 3;
  }
  return 4;
}

export function loadPluginManifestRegistry(
  params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    cache?: boolean;
    env?: NodeJS.ProcessEnv;
    candidates?: PluginCandidate[];
    diagnostics?: PluginDiagnostic[];
  } = {},
): PluginManifestRegistry {
  const config = params.config ?? {};
  const normalized = normalizePluginsConfig(config.plugins);
  const env = params.env ?? process.env;
  const cacheKey = buildCacheKey({ workspaceDir: params.workspaceDir, plugins: normalized, env });
  const cacheEnabled = params.cache !== false && shouldUseManifestCache(env);
  if (cacheEnabled) {
    const cached = registryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.registry;
    }
  }

  const discovery = params.candidates
    ? {
        candidates: params.candidates,
        diagnostics: params.diagnostics ?? [],
      }
    : discoverOpenClawPlugins({
        workspaceDir: params.workspaceDir,
        extraPaths: normalized.loadPaths,
        cache: params.cache,
        env,
      });
  const diagnostics: PluginDiagnostic[] = [...discovery.diagnostics];
  const candidates: PluginCandidate[] = discovery.candidates;
  const records: PluginManifestRecord[] = [];
  const seenIds = new Map<string, SeenIdEntry>();
  const realpathCache = new Map<string, string>();

  for (const candidate of candidates) {
    const rejectHardlinks = candidate.origin !== "bundled";
    const isBundleRecord = (candidate.format ?? "openclaw") === "bundle";
    const manifestRes =
      isBundleRecord && candidate.bundleFormat
        ? loadBundleManifest({
            rootDir: candidate.rootDir,
            bundleFormat: candidate.bundleFormat,
            rejectHardlinks,
          })
        : loadPluginManifest(candidate.rootDir, rejectHardlinks);
    if (!manifestRes.ok) {
      diagnostics.push({
        level: "error",
        message: manifestRes.error,
        source: manifestRes.manifestPath,
      });
      continue;
    }
    const manifest = manifestRes.manifest;

    if (!isCompatiblePluginIdHint(candidate.idHint, manifest.id)) {
      diagnostics.push({
        level: "warn",
        pluginId: manifest.id,
        source: candidate.source,
        message: `plugin id mismatch (manifest uses "${manifest.id}", entry hints "${candidate.idHint}")`,
      });
    }

    const configSchema = "configSchema" in manifest ? manifest.configSchema : undefined;
    const schemaCacheKey = (() => {
      if (!configSchema) {
        return undefined;
      }
      const manifestMtime = safeStatMtimeMs(manifestRes.manifestPath);
      return manifestMtime
        ? `${manifestRes.manifestPath}:${manifestMtime}`
        : manifestRes.manifestPath;
    })();

    const existing = seenIds.get(manifest.id);
    if (existing) {
      // Check whether both candidates point to the same physical directory
      // (e.g. via symlinks or different path representations). If so, this
      // is a false-positive duplicate and can be silently skipped.
      const samePath = existing.candidate.rootDir === candidate.rootDir;
      const samePlugin = (() => {
        if (samePath) {
          return true;
        }
        const existingReal = safeRealpathSync(existing.candidate.rootDir, realpathCache);
        const candidateReal = safeRealpathSync(candidate.rootDir, realpathCache);
        return Boolean(existingReal && candidateReal && existingReal === candidateReal);
      })();
      // When one candidate is bundled, only warn if the non-bundled copy was
      // explicitly configured (origin=config or has a plugins.installs record).
      // Auto-discovered duplicates of bundled plugins are expected (e.g. channels
      // config auto-enabling a bundled extension) and should resolve silently.
      const isBundledDuplicate =
        existing.candidate.origin === "bundled" || candidate.origin === "bundled";
      const isExplicitOverride =
        isBundledDuplicate &&
        (() => {
          const nonBundled =
            existing.candidate.origin === "bundled" ? candidate : existing.candidate;
          return (
            nonBundled.origin === "config" ||
            matchesInstalledPluginRecord({
              pluginId: manifest.id,
              candidate: nonBundled,
              config,
              env,
            })
          );
        })();
      if (samePlugin || (isBundledDuplicate && !isExplicitOverride)) {
        // Prefer higher-precedence origins even if candidates are passed in
        // an unexpected order (config > workspace > global > bundled).
        if (PLUGIN_ORIGIN_RANK[candidate.origin] < PLUGIN_ORIGIN_RANK[existing.candidate.origin]) {
          records[existing.recordIndex] = isBundleRecord
            ? buildBundleRecord({
                manifest: manifest as Parameters<typeof buildBundleRecord>[0]["manifest"],
                candidate,
                manifestPath: manifestRes.manifestPath,
              })
            : buildRecord({
                manifest: manifest as PluginManifest,
                candidate,
                manifestPath: manifestRes.manifestPath,
                schemaCacheKey,
                configSchema,
              });
          seenIds.set(manifest.id, { candidate, recordIndex: existing.recordIndex });
        }
        continue;
      }
      diagnostics.push({
        level: "warn",
        pluginId: manifest.id,
        source: candidate.source,
        message:
          resolveDuplicatePrecedenceRank({
            pluginId: manifest.id,
            candidate,
            config,
            env,
          }) <
          resolveDuplicatePrecedenceRank({
            pluginId: manifest.id,
            candidate: existing.candidate,
            config,
            env,
          })
            ? `duplicate plugin id detected; ${existing.candidate.origin} plugin will be overridden by ${candidate.origin} plugin (${candidate.source})`
            : `duplicate plugin id detected; ${candidate.origin} plugin will be overridden by ${existing.candidate.origin} plugin (${candidate.source})`,
      });
    } else {
      seenIds.set(manifest.id, { candidate, recordIndex: records.length });
    }

    records.push(
      isBundleRecord
        ? buildBundleRecord({
            manifest: manifest as Parameters<typeof buildBundleRecord>[0]["manifest"],
            candidate,
            manifestPath: manifestRes.manifestPath,
          })
        : buildRecord({
            manifest: manifest as PluginManifest,
            candidate,
            manifestPath: manifestRes.manifestPath,
            schemaCacheKey,
            configSchema,
          }),
    );
  }

  const registry = { plugins: records, diagnostics };
  if (cacheEnabled) {
    const ttl = resolveManifestCacheMs(env);
    if (ttl > 0) {
      registryCache.set(cacheKey, { expiresAt: Date.now() + ttl, registry });
    }
  }
  return registry;
}
