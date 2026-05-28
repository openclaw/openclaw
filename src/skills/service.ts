import crypto from "node:crypto";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getSkillsSnapshotVersion } from "./refresh-state.js";
import { buildSkillIndex, skillIndexEntries, type SkillIndex } from "./registry.js";
import type { SkillEligibilityContext, SkillSnapshot } from "./types.js";
import {
  buildWorkspaceSkillSnapshot as buildWorkspaceSkillSnapshotFromEntries,
  loadWorkspaceSkillEntries,
} from "./workspace.js";

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
  agentId?: string;
  skillFilter?: string[];
  eligibility?: SkillEligibilityContext;
  snapshotVersion?: number;
};

export class SkillsService {
  private readonly cache = new Map<string, SkillIndex>();

  getIndex(request: SkillIndexRequest): SkillIndex {
    const cacheKey = buildSkillIndexCacheKey(request);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const index = this.loadIndex(request, cacheKey);
    this.cache.set(cacheKey, index);
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
    const request = {
      workspaceDir,
      config: opts?.config,
      managedSkillsDir: opts?.managedSkillsDir,
      bundledSkillsDir: opts?.bundledSkillsDir,
      pluginSkillsDir: opts?.pluginSkillsDir,
      snapshotVersion: opts?.snapshotVersion,
    };
    const index =
      opts?.snapshotVersion === undefined
        ? this.loadIndex(request, buildSkillIndexCacheKey(request))
        : this.getIndex(request);
    return buildSkillSnapshotFromIndex(workspaceDir, index, opts);
  }

  invalidate(): void {
    this.cache.clear();
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

function stableConfigHash(config?: OpenClawConfig): string {
  const skillsConfig = config?.skills ?? {};
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(skillsConfig))
    .digest("hex")
    .slice(0, 16);
}

function normalizedOptionalPath(value?: string): string {
  return value ? path.resolve(value) : "";
}

export function buildSkillIndexCacheKey(request: SkillIndexRequest): string {
  const snapshotVersion = request.snapshotVersion ?? getSkillsSnapshotVersion(request.workspaceDir);
  return JSON.stringify({
    workspaceDir: path.resolve(request.workspaceDir),
    managedSkillsDir: normalizedOptionalPath(request.managedSkillsDir),
    bundledSkillsDir: normalizedOptionalPath(request.bundledSkillsDir),
    pluginSkillsDir: normalizedOptionalPath(request.pluginSkillsDir),
    skillsConfig: stableConfigHash(request.config),
    snapshotVersion,
  });
}
