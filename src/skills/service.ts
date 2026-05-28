import crypto from "node:crypto";
import path from "node:path";
import { stableStringify } from "../agents/stable-stringify.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { resolveEffectiveAgentSkillFilter } from "./agent-filter.js";
import { normalizeSkillFilter } from "./filter.js";
import { getSkillsSnapshotVersion } from "./refresh-state.js";
import { buildSkillIndex, skillIndexEntries, type SkillIndex } from "./registry.js";
import type { SkillEligibilityContext, SkillEntry, SkillSnapshot } from "./types.js";
import {
  buildWorkspaceSkillSnapshot as buildWorkspaceSkillSnapshotFromEntries,
  loadWorkspaceSkillEntries,
} from "./workspace.js";

const MAX_SKILL_INDEX_CACHE_ENTRIES = 16;

export type SkillIndexRequest = {
  workspaceDir: string;
  config?: OpenClawConfig;
  managedSkillsDir?: string;
  bundledSkillsDir?: string;
  pluginSkillsDir?: string;
  snapshotVersion?: number;
};

export type SkillSnapshotBuildOptions = {
  config?: OpenClawConfig;
  managedSkillsDir?: string;
  bundledSkillsDir?: string;
  pluginSkillsDir?: string;
  entries?: SkillEntry[];
  agentId?: string;
  skillFilter?: string[];
  eligibility?: SkillEligibilityContext;
  snapshotVersion?: number;
};

export class SkillsService {
  private readonly cache = new Map<string, SkillIndex>();
  private readonly cacheScopes = new Map<string, string>();

  getIndex(request: SkillIndexRequest): SkillIndex {
    const snapshotVersion =
      request.snapshotVersion ?? getSkillsSnapshotVersion(request.workspaceDir);
    if (!shouldCacheSkillIndex(request, snapshotVersion)) {
      return this.loadIndex(request, buildUncachedSkillIndexCacheKey(request, snapshotVersion));
    }
    const cacheKeyParts = buildSkillIndexCacheKeyParts(request, snapshotVersion);
    const cacheKey = stringifyCacheKeyParts(cacheKeyParts);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      return cached;
    }
    const index = this.loadIndex(request, cacheKey);
    this.pruneScope(cacheKeyParts.scope, cacheKey);
    this.cache.set(cacheKey, index);
    this.cacheScopes.set(cacheKey, cacheKeyParts.scope);
    this.pruneCapacity();
    return index;
  }

  private loadIndex(request: SkillIndexRequest, cacheKey: string): SkillIndex {
    const entries = loadWorkspaceSkillEntries(request.workspaceDir, {
      config: request.config,
      managedSkillsDir: request.managedSkillsDir,
      bundledSkillsDir: request.bundledSkillsDir,
      pluginSkillsDir: request.pluginSkillsDir,
    });
    return buildSkillIndex({ cacheKey, entries });
  }

  buildSnapshot(workspaceDir: string, opts?: SkillSnapshotBuildOptions): SkillSnapshot {
    if (opts?.entries || hasEmptyEffectiveSkillFilter(opts)) {
      return buildWorkspaceSkillSnapshotFromEntries(workspaceDir, opts);
    }
    const request = {
      workspaceDir,
      config: opts?.config,
      managedSkillsDir: opts?.managedSkillsDir,
      bundledSkillsDir: opts?.bundledSkillsDir,
      pluginSkillsDir: opts?.pluginSkillsDir,
      snapshotVersion: opts?.snapshotVersion,
    };
    const snapshotVersion = request.snapshotVersion ?? getSkillsSnapshotVersion(workspaceDir);
    const index = this.loadIndex(
      request,
      buildUncachedSkillIndexCacheKey(request, snapshotVersion),
    );
    return buildSkillSnapshotFromIndex(workspaceDir, index, opts);
  }

  invalidate(): void {
    this.cache.clear();
    this.cacheScopes.clear();
  }

  private pruneScope(scope: string, keepKey: string): void {
    for (const [key, cachedScope] of this.cacheScopes) {
      if (key === keepKey || cachedScope !== scope) {
        continue;
      }
      this.cache.delete(key);
      this.cacheScopes.delete(key);
    }
  }

  private pruneCapacity(): void {
    while (this.cache.size > MAX_SKILL_INDEX_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.cache.delete(oldestKey);
      this.cacheScopes.delete(oldestKey);
    }
  }
}

export const skillsService = new SkillsService();

export function buildSkillSnapshotFromIndex(
  workspaceDir: string,
  index: SkillIndex,
  opts?: SkillSnapshotBuildOptions,
): SkillSnapshot {
  return buildWorkspaceSkillSnapshotFromEntries(workspaceDir, {
    entries: skillIndexEntries(index),
    config: opts?.config,
    agentId: opts?.agentId,
    skillFilter: opts?.skillFilter,
    eligibility: opts?.eligibility,
    snapshotVersion: opts?.snapshotVersion,
  });
}

export function buildWorkspaceSkillSnapshot(
  workspaceDir: string,
  opts?: SkillSnapshotBuildOptions,
): SkillSnapshot {
  return skillsService.buildSnapshot(workspaceDir, opts);
}

function stableHash(value: unknown): string {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

function normalizedOptionalPath(value?: string): string {
  return value ? path.resolve(value) : "";
}

function hasEmptyEffectiveSkillFilter(opts?: SkillSnapshotBuildOptions): boolean {
  if (opts?.skillFilter !== undefined) {
    const filter = normalizeSkillFilter(opts.skillFilter);
    return filter !== undefined && filter.length === 0;
  }
  if (!opts?.config || !opts.agentId) {
    return false;
  }
  const filter = resolveEffectiveAgentSkillFilter(opts.config, opts.agentId);
  return filter !== undefined && filter.length === 0;
}

export function buildSkillIndexCacheKey(request: SkillIndexRequest): string {
  const snapshotVersion = request.snapshotVersion ?? getSkillsSnapshotVersion(request.workspaceDir);
  return stringifyCacheKeyParts(buildSkillIndexCacheKeyParts(request, snapshotVersion));
}

type SkillIndexCacheKeyParts = {
  scope: string;
  snapshotVersion: number;
};

function shouldCacheSkillIndex(
  request: SkillIndexRequest,
  snapshotVersion: number | undefined,
): boolean {
  return (
    typeof snapshotVersion === "number" &&
    snapshotVersion > 0 &&
    request.config?.skills?.load?.watch !== false
  );
}

function buildUncachedSkillIndexCacheKey(
  request: SkillIndexRequest,
  snapshotVersion: number,
): string {
  return stableStringify({
    uncached: true,
    workspaceDir: path.resolve(request.workspaceDir),
    snapshotVersion,
  });
}

function buildSkillIndexCacheKeyParts(
  request: SkillIndexRequest,
  snapshotVersion: number,
): SkillIndexCacheKeyParts {
  const scope = stableStringify({
    workspaceDir: path.resolve(request.workspaceDir),
    managedSkillsDir: normalizedOptionalPath(request.managedSkillsDir),
    bundledSkillsDir: normalizedOptionalPath(request.bundledSkillsDir),
    pluginSkillsDir: normalizedOptionalPath(request.pluginSkillsDir),
    config: stableHash(request.config ?? {}),
    pluginDiscovery: resolvePluginSkillDiscoveryFingerprint(request),
  });
  return { scope, snapshotVersion };
}

function stringifyCacheKeyParts(parts: SkillIndexCacheKeyParts): string {
  return stableStringify(parts);
}

function resolvePluginSkillDiscoveryFingerprint(request: SkillIndexRequest): string {
  const snapshot = resolvePluginMetadataSnapshot({
    workspaceDir: request.workspaceDir,
    config: request.config ?? {},
    env: process.env,
    allowWorkspaceScopedCurrent: true,
  });
  return stableHash({
    policyHash: snapshot.policyHash,
    configFingerprint: snapshot.configFingerprint ?? null,
    registrySource: snapshot.registrySource ?? null,
    index: {
      hostContractVersion: snapshot.index.hostContractVersion,
      compatRegistryVersion: snapshot.index.compatRegistryVersion,
      migrationVersion: snapshot.index.migrationVersion,
      policyHash: snapshot.index.policyHash,
      installRecords: snapshot.index.installRecords,
      plugins: snapshot.index.plugins.map((plugin) => ({
        pluginId: plugin.pluginId,
        enabled: plugin.enabled,
        enabledByDefault: plugin.enabledByDefault ?? null,
        manifestHash: plugin.manifestHash,
        manifestPath: plugin.manifestPath,
        origin: plugin.origin,
        rootDir: plugin.rootDir,
      })),
    },
    manifestPlugins: snapshot.manifestRegistry.plugins.map((plugin) => ({
      id: plugin.id,
      enabledByDefault: plugin.enabledByDefault ?? null,
      kind: plugin.kind ?? null,
      origin: plugin.origin,
      rootDir: plugin.rootDir,
      skills: plugin.skills,
    })),
  });
}
