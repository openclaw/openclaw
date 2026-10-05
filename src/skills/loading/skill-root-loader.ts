import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isMissingPathError } from "../../infra/errors.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { isPathInside } from "../../infra/path-guards.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { shouldRejectHardlinkedPluginFiles } from "../../plugins/hardlink-policy.js";
import { getSkillRootDiscoveryEpoch } from "../runtime/refresh-state.js";
import {
  isSkillDiscoveryDependencyCurrent,
  observeSkillDiscoveryPath,
  readSkillRootDiscoveryToken,
  type SkillDiscoveryDependency,
} from "../runtime/refresh-watch-registry.js";
import type { SkillEntry } from "../types.js";
import {
  loadSingleSkillDirectory,
  type LoadedLocalSkill,
  type LocalSkillLoadDiagnostic,
} from "./local-loader.js";
import type { PluginSkillRoot } from "./plugin-skill-root.js";
import { createSkillEntry } from "./skill-entry-metadata.js";
import { compactSkillPath } from "./skill-paths.js";
import { mergeSkillRecords, type SkillCollision } from "./skill-precedence.js";
import {
  canonicalSkillDirForSource,
  discoverPluginSkills,
  discoverSkillCandidates,
  resolveSkillDiscoveryLimits,
  type CandidateSkillDir,
  type ResolvedSkillDiscoveryLimits,
} from "./skill-root-discovery.js";
import { resolveSkillTelemetrySourceValue } from "./source.js";
import { resolveAllowedSkillSymlinkTargetRealPaths } from "./symlink-targets.js";
import { resolveWorkspaceSkillDirectories } from "./workspace-skill-roots.js";
import type {
  WorkspaceSkillSourcePlan,
  WorkspaceSkillSources,
} from "./workspace-skill-sources.types.js";

const skillsLogger = createSubsystemLogger("skills");

type LoadedSkillRecord = Pick<LoadedLocalSkill, "skill" | "frontmatter"> & {
  syncSourceDir?: string;
  syncDirName?: string;
};

const skillRootRecordsCache = new Map<
  string,
  { key: string; dependencies: SkillDiscoveryDependency[]; records: LoadedSkillRecord[] }
>();

const MAX_DISCOVERY_LINK_HOPS = 40;

// Resolve a path from the filesystem root, recording every link it passes through.
function resolveRecordingLinks(
  input: string,
  links: Set<string>,
  budget = { hops: MAX_DISCOVERY_LINK_HOPS },
): string | undefined {
  const absolute = path.resolve(input);
  let current = path.parse(absolute).root;
  const parts = absolute.slice(current.length).split(path.sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    const next = path.join(current, part);
    try {
      if (!fs.lstatSync(next).isSymbolicLink()) {
        current = next;
        continue;
      }
      budget.hops -= 1;
      links.add(next);
      const resolved =
        budget.hops >= 0
          ? resolveRecordingLinks(
              path.resolve(path.dirname(next), fs.readlinkSync(next)),
              links,
              budget,
            )
          : undefined;
      if (!resolved) {
        return undefined;
      }
      current = resolved;
    } catch (error) {
      // A missing tail is observed through the watcher of its nearest ancestor.
      return isMissingPathError(error) ? path.join(current, ...parts.slice(index)) : undefined;
    }
  }
  return current;
}

/**
 * Watchers that observe every link discovery followed and every directory it
 * inspected. Undefined when any of them is unobserved, so the scan is not reused.
 */
function collectDiscoveryDependencies(
  inspectedPaths: readonly string[],
  linkOnlyPaths: readonly string[],
): SkillDiscoveryDependency[] | undefined {
  const links = new Set<string>();
  const observedPaths: string[] = [];
  for (const entry of inspectedPaths) {
    const realPath = resolveRecordingLinks(entry, links);
    if (!realPath) {
      return undefined;
    }
    observedPaths.push(realPath);
  }
  // Rejected candidates are never read; only links that could re-admit them matter.
  for (const entry of linkOnlyPaths) {
    if (!resolveRecordingLinks(entry, links)) {
      return undefined;
    }
  }
  const dependencies = new Map<string, SkillDiscoveryDependency>();
  for (const observedPath of [...links, ...observedPaths]) {
    const dependency = observeSkillDiscoveryPath(observedPath);
    if (!dependency) {
      return undefined;
    }
    dependencies.set(dependency.target, dependency);
  }
  return [...dependencies.values()];
}

export function clearSkillRootRecordsCache(): void {
  skillRootRecordsCache.clear();
}

export function warnInvalidSkill(source: string, diagnostic: LocalSkillLoadDiagnostic): void {
  skillsLogger.warn("Skipping invalid skill.", {
    source,
    filePath: diagnostic.path,
    error: diagnostic.message,
    consoleMessage:
      `Skipping invalid skill: file=${compactSkillPath(diagnostic.path)} ` +
      `error=${diagnostic.message}`,
  });
}

function loadContainedSkillRecord(
  params: Parameters<typeof loadSingleSkillDirectory>[0] & { canonicalSkillDir?: string },
): LoadedSkillRecord | null {
  const loaded = loadSingleSkillDirectory({
    ...params,
    onDiagnostic:
      params.onDiagnostic ?? ((diagnostic) => warnInvalidSkill(params.source, diagnostic)),
  });
  if (!loaded) {
    return null;
  }
  // Discovery selected one terminal SKILL.md; keep its parsed facts, not its content, in the cache.
  const record: LoadedSkillRecord = { skill: loaded.skill, frontmatter: loaded.frontmatter };
  if (!params.canonicalSkillDir) {
    return record;
  }
  const originalBaseDir = path.resolve(record.skill.baseDir);
  const canonicalBaseDir = path.resolve(params.canonicalSkillDir);
  if (originalBaseDir === canonicalBaseDir) {
    return record;
  }
  const filePath = path.join(
    canonicalBaseDir,
    path.relative(originalBaseDir, record.skill.filePath),
  );
  return {
    ...record,
    syncSourceDir: canonicalBaseDir,
    syncDirName: path.basename(originalBaseDir),
    skill: {
      ...record.skill,
      filePath,
      baseDir: canonicalBaseDir,
      sourceInfo: record.skill.sourceInfo
        ? { ...record.skill.sourceInfo, path: filePath, baseDir: canonicalBaseDir }
        : record.skill.sourceInfo,
    },
  };
}

/** Loads one skill root under the configured discovery limits and symlink/hardlink policy. */
export function loadSkillRootRecords(params: {
  dir: string;
  source: string;
  worktree?: boolean;
  config?: OpenClawConfig;
  rejectHardlinks?: boolean;
  mode?: "audit";
  onDiagnostic?: (diagnostic: LocalSkillLoadDiagnostic) => void;
}): LoadedSkillRecord[] {
  const discoveryRoot = {
    path: path.resolve(params.dir),
    worktree:
      params.worktree ??
      isPathInside(
        params.config?.worktreeRoot ?? path.join(resolveStateDir(), "worktrees"),
        params.dir,
      ),
  };
  const limits = resolveSkillDiscoveryLimits(params.config);
  if (params.mode === "audit") {
    // Prompt budgets must not hide installed skills. Keep larger configured
    // traversal bounds, and use the existing default file cap for audit reads.
    const defaults = resolveSkillDiscoveryLimits();
    limits.maxCandidatesPerRoot = Math.max(
      limits.maxCandidatesPerRoot,
      defaults.maxCandidatesPerRoot,
    );
    limits.maxSkillsLoadedPerSource = Math.max(
      limits.maxSkillsLoadedPerSource,
      defaults.maxSkillsLoadedPerSource,
    );
    limits.maxSkillFileBytes = defaults.maxSkillFileBytes;
  }
  const rejectHardlinks =
    params.rejectHardlinks ??
    shouldRejectHardlinkedPluginFiles({
      origin:
        resolveSkillTelemetrySourceValue(params.source) === "bundled" ? "bundled" : "workspace",
      rootDir: params.dir,
    });
  const allowedSymlinkTargetRealPaths = resolveAllowedSkillSymlinkTargetRealPaths(params.config);
  // The watcher owns freshness: reuse a root only while its planned targets and every
  // watcher its discovery depended on stay verified and unchanged. Audit and
  // diagnostic callers always need a live scan.
  const token =
    params.mode === "audit" || params.onDiagnostic
      ? undefined
      : readSkillRootDiscoveryToken(params.dir);
  const cacheSlot = JSON.stringify([discoveryRoot.path, params.source]);
  const cacheKey =
    token === undefined
      ? undefined
      : JSON.stringify([
          discoveryRoot.path,
          params.source,
          discoveryRoot.worktree,
          limits,
          allowedSymlinkTargetRealPaths,
          rejectHardlinks,
          getSkillRootDiscoveryEpoch(),
          token,
        ]);
  const cached = skillRootRecordsCache.get(cacheSlot);
  if (
    cacheKey !== undefined &&
    cached?.key === cacheKey &&
    cached.dependencies.every(isSkillDiscoveryDependencyCurrent)
  ) {
    return cached.records.slice();
  }
  let unresolved = false;
  const linkOnlyPaths: string[] = [];
  const inspectedDirs = new Set<string>([discoveryRoot.path]);
  const discovered = discoverSkillCandidates({
    dir: params.dir,
    source: params.source,
    limits,
    allowedSymlinkTargetRealPaths,
    onDiagnostic: (diagnostic) => {
      // A dangling link's destination may appear later without any observed change.
      unresolved ||= diagnostic.kind === "read";
      if (diagnostic.kind === "invalid") {
        linkOnlyPaths.push(diagnostic.path);
      }
      params.onDiagnostic?.(diagnostic);
    },
    onDirectory: (dir) => inspectedDirs.add(path.resolve(dir)),
    onSymlink: (link) => linkOnlyPaths.push(link),
  });
  // Rejected and non-directory links count too: retargeting one can admit a skill.
  const dependencies =
    cacheKey === undefined || unresolved
      ? undefined
      : collectDiscoveryDependencies([...inspectedDirs], linkOnlyPaths);
  const remember = (records: LoadedSkillRecord[]) => {
    if (cacheKey !== undefined && dependencies) {
      skillRootRecordsCache.set(cacheSlot, { key: cacheKey, dependencies, records });
      pruneMapToMaxSize(skillRootRecordsCache, 256);
    }
    return records.slice();
  };
  const maxSkillsLoadedPerSource = Math.max(0, limits.maxSkillsLoadedPerSource);
  const loadCandidate = (candidate: CandidateSkillDir) => {
    const record = loadContainedSkillRecord({
      skillDir: candidate.skillDir,
      rootRealPath: candidate.skillDirRealPath,
      source: params.source,
      maxBytes: limits.maxSkillFileBytes,
      canonicalSkillDir:
        params.mode === "audit"
          ? candidate.skillDirRealPath
          : canonicalSkillDirForSource(params.source, candidate.skillDirRealPath),
      rejectHardlinks,
      onDiagnostic: params.onDiagnostic,
    });
    if (record) {
      record.skill.discoveryRoot = discoveryRoot;
    }
    return record;
  };
  if (discovered.configuredRootCandidate) {
    const rootRecord = loadCandidate(discovered.configuredRootCandidate);
    if (rootRecord) {
      return remember([rootRecord]);
    }
  }

  const loadedSkills: LoadedSkillRecord[] = [];
  for (const candidate of discovered.candidates) {
    if (
      params.mode !== "audit" &&
      !discovered.rootIsSkill &&
      loadedSkills.length >= maxSkillsLoadedPerSource
    ) {
      break;
    }
    const record = loadCandidate(candidate);
    if (record) {
      loadedSkills.push(record);
    }
  }
  return remember(loadedSkills);
}

function loadGeneratedPluginSkillRecords(params: {
  pluginSkillsDir: string;
  pluginSkillRoots: readonly PluginSkillRoot[];
  source: string;
  limits: ResolvedSkillDiscoveryLimits;
}): LoadedSkillRecord[] {
  const candidates = discoverPluginSkills(params);
  const maxSkillsLoadedPerSource = Math.max(0, params.limits.maxSkillsLoadedPerSource);
  const loadedSkills: LoadedSkillRecord[] = [];
  for (const candidate of candidates) {
    const record = loadContainedSkillRecord({
      skillDir: candidate.skillDir,
      rootRealPath: candidate.skillDirRealPath,
      source: params.source,
      maxBytes: params.limits.maxSkillFileBytes,
      rejectHardlinks: candidate.rejectHardlinks,
    });
    if (record) {
      record.skill.discoveryRoot = { path: path.resolve(params.pluginSkillsDir), worktree: false };
      loadedSkills.push({
        ...record,
        syncSourceDir: candidate.skillDirRealPath,
        syncDirName: path.basename(record.skill.baseDir),
      });
    }
    if (loadedSkills.length >= maxSkillsLoadedPerSource) {
      break;
    }
  }
  return loadedSkills;
}

/** Scan selected roots on their owning host, retaining native precedence and file rules. */
export function loadWorkspaceSkillSourceEntries(
  plan: WorkspaceSkillSourcePlan,
  config?: OpenClawConfig,
  collisions?: SkillCollision[],
): WorkspaceSkillSources["entries"] {
  const grouped = new Map<string, Array<LoadedSkillRecord & { sourceOrder?: number }>>();
  for (const root of plan.roots) {
    const records = grouped.get(root.tier) ?? [];
    for (const record of loadSkillRootRecords({ ...root, config })) {
      records.push({ ...record, sourceOrder: root.order });
    }
    grouped.set(root.tier, records);
  }
  const extra = grouped.get("extra") ?? [];
  if (plan.pluginSkillsDir) {
    for (const record of loadGeneratedPluginSkillRecords({
      pluginSkillsDir: plan.pluginSkillsDir,
      pluginSkillRoots: plan.pluginSkillRoots,
      source: "openclaw-extra",
      limits: resolveSkillDiscoveryLimits(config),
    })) {
      extra.push({
        ...record,
        sourceOrder:
          (plan.roots.find((root) => root.tier !== "extra")?.order ??
            Math.max(-1, ...plan.roots.map((root) => root.order ?? -1)) + 1) - 0.5,
      });
    }
  }
  grouped.set("extra", extra);
  // Custodian and bundled records share a tier and deterministic collision order.
  grouped
    .get("bundled")
    ?.sort(
      (left, right) =>
        left.skill.name.localeCompare(right.skill.name, "en") ||
        left.skill.source.localeCompare(right.skill.source, "en"),
    );
  return mergeSkillRecords(
    ["extra", "bundled", "workshop", "managed", "personal", "workspace"].flatMap(
      (tier) => grouped.get(tier) ?? [],
    ),
    JSON.stringify(["sources", plan.workspaceDir]),
    collisions,
  ).map(createSkillEntry);
}

export function loadExecutionSkillEntries(
  executionWorkspaceDir: string,
  config?: OpenClawConfig,
  collisions?: SkillCollision[],
): SkillEntry[] {
  return mergeSkillRecords(
    resolveWorkspaceSkillDirectories(executionWorkspaceDir).flatMap((root) =>
      loadSkillRootRecords({ ...root, config }),
    ),
    JSON.stringify(["execution", executionWorkspaceDir]),
    collisions,
  ).map(createSkillEntry);
}
