import fs from "node:fs";
import type { OpenClawConfig } from "../config/config.js";
import { resolveUserPath } from "../utils.js";
import { normalizePluginsConfig, type NormalizedPluginsConfig } from "./config-state.js";
import { discoverOpenClawPlugins, type PluginCandidate } from "./discovery.js";
import { loadPluginManifest, type PluginManifest } from "./manifest.js";
import { safeRealpathSync } from "./path-safety.js";
import type { PluginConfigUiHint, PluginDiagnostic, PluginKind, PluginOrigin } from "./types.js";

type SeenIdEntry = {
  candidate: PluginCandidate;
  recordIndex: number;
};

// Precedence: config > workspace > global > bundled
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
  kind?: PluginKind;
  channels: string[];
  providers: string[];
  skills: string[];
  origin: PluginOrigin;
  workspaceDir?: string;
  rootDir: string;
  source: string;
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
}): string {
  const workspaceKey = params.workspaceDir ? resolveUserPath(params.workspaceDir) : "";
  // The manifest registry only depends on where plugins are discovered from (workspace + load paths).
  // It does not depend on allow/deny/entries enable-state, so exclude those for higher cache hit rates.
  const loadPaths = params.plugins.loadPaths
    .map((p) => resolveUserPath(p))
    .map((p) => p.trim())
    .filter(Boolean)
    .toSorted();
  return `${workspaceKey}::${JSON.stringify(loadPaths)}`;
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
    kind: params.manifest.kind,
    channels: params.manifest.channels ?? [],
    providers: params.manifest.providers ?? [],
    skills: params.manifest.skills ?? [],
    origin: params.candidate.origin,
    workspaceDir: params.candidate.workspaceDir,
    rootDir: params.candidate.rootDir,
    source: params.candidate.source,
    manifestPath: params.manifestPath,
    schemaCacheKey: params.schemaCacheKey,
    configSchema: params.configSchema,
    configUiHints: params.manifest.uiHints,
  };
}

export function loadPluginManifestRegistry(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  cache?: boolean;
  env?: NodeJS.ProcessEnv;
  candidates?: PluginCandidate[];
  diagnostics?: PluginDiagnostic[];
}): PluginManifestRegistry {
  const config = params.config ?? {};
  const normalized = normalizePluginsConfig(config.plugins);
  const cacheKey = buildCacheKey({ workspaceDir: params.workspaceDir, plugins: normalized });
  const env = params.env ?? process.env;
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
      });
  const diagnostics: PluginDiagnostic[] = [...discovery.diagnostics];
  const candidates: PluginCandidate[] = discovery.candidates;
  const records: PluginManifestRecord[] = [];
  const seenRootsById = new Map<string, Map<string, SeenIdEntry>>();
  const seenOriginsById = new Map<string, Map<PluginOrigin, Set<string>>>();
  const realpathCache = new Map<string, string>();

  for (const candidate of candidates) {
    const rejectHardlinks = candidate.origin !== "bundled";
    const manifestRes = loadPluginManifest(candidate.rootDir, rejectHardlinks);
    if (!manifestRes.ok) {
      diagnostics.push({
        level: "error",
        message: manifestRes.error,
        source: manifestRes.manifestPath,
      });
      continue;
    }
    const manifest = manifestRes.manifest;

    if (candidate.idHint && candidate.idHint !== manifest.id) {
      diagnostics.push({
        level: "warn",
        pluginId: manifest.id,
        source: candidate.source,
        message: `plugin id mismatch (manifest uses "${manifest.id}", entry hints "${candidate.idHint}")`,
      });
    }

    const configSchema = manifest.configSchema;
    const schemaCacheKey = (() => {
      if (!configSchema) {
        return undefined;
      }
      const manifestMtime = safeStatMtimeMs(manifestRes.manifestPath);
      return manifestMtime
        ? `${manifestRes.manifestPath}:${manifestMtime}`
        : manifestRes.manifestPath;
    })();

    const rootKey = safeRealpathSync(candidate.rootDir, realpathCache) ?? candidate.rootDir;
    const rootsForId = seenRootsById.get(manifest.id) ?? new Map<string, SeenIdEntry>();
    if (!seenRootsById.has(manifest.id)) {
      seenRootsById.set(manifest.id, rootsForId);
    }
    const originsForId = seenOriginsById.get(manifest.id) ?? new Map<PluginOrigin, Set<string>>();
    if (!seenOriginsById.has(manifest.id)) {
      seenOriginsById.set(manifest.id, originsForId);
    }

    const existingSameRoot = rootsForId.get(rootKey);
    if (existingSameRoot) {
      // Same physical plugin discovered through multiple origins/sources.
      // Keep only one record and pick the highest-precedence origin.
      if (
        PLUGIN_ORIGIN_RANK[candidate.origin] < PLUGIN_ORIGIN_RANK[existingSameRoot.candidate.origin]
      ) {
        records[existingSameRoot.recordIndex] = buildRecord({
          manifest,
          candidate,
          manifestPath: manifestRes.manifestPath,
          schemaCacheKey,
          configSchema,
        });
        rootsForId.set(rootKey, {
          candidate,
          recordIndex: existingSameRoot.recordIndex,
        });
      }
      continue;
    }

    const rootsForOrigin = originsForId.get(candidate.origin) ?? new Set<string>();
    const hadOriginRoot = rootsForOrigin.size > 0;
    rootsForOrigin.add(rootKey);
    originsForId.set(candidate.origin, rootsForOrigin);
    rootsForId.set(rootKey, { candidate, recordIndex: records.length });

    // Warn only when distinct roots collide within the same origin bucket.
    // Cross-origin shadowing is expected and handled by precedence elsewhere.
    if (hadOriginRoot) {
      diagnostics.push({
        level: "warn",
        pluginId: manifest.id,
        source: candidate.source,
        message: `duplicate plugin id detected; later plugin may be overridden (${candidate.source})`,
      });
    }

    records.push(
      buildRecord({
        manifest,
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
