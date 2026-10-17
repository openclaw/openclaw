import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPathInside } from "../../infra/path-guards.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { shouldRejectHardlinkedPluginFiles } from "../../plugins/hardlink-policy.js";
import type { SkillEntry } from "../types.js";
import {
  loadSingleSkillDirectory,
  type LoadedLocalSkill,
  type LocalSkillLoadDiagnostic,
} from "./local-loader.js";
import type { PluginSkillRoot } from "./plugin-skill-root.js";
import { createSkillEntry } from "./skill-entry-metadata.js";
import { createSkillLoadDiagnostics, type SkillLoadDiagnostics } from "./skill-load-diagnostics.js";
import { compactSkillPath } from "./skill-paths.js";
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

/** Admitted entries shared only within one synchronous discovery pass and environment. */
export type SkillSourceReadBatch = Map<
  string,
  { entries: WorkspaceSkillSources["entries"]; diagnostics: SkillLoadDiagnostics }
>;

function readSourceEntries(
  batch: SkillSourceReadBatch | undefined,
  input: readonly unknown[],
  diagnostics: ReturnType<typeof createSkillLoadDiagnostics>,
  read: (
    diagnostics: ReturnType<typeof createSkillLoadDiagnostics>,
  ) => WorkspaceSkillSources["entries"],
): WorkspaceSkillSources["entries"] {
  if (!batch) {
    return read(diagnostics);
  }
  const key = JSON.stringify(input);
  let result = batch.get(key);
  if (!result) {
    const collected = createSkillLoadDiagnostics();
    result = { entries: read(collected), diagnostics: collected.snapshot() };
    batch.set(key, result);
  }
  diagnostics.merge(result.diagnostics);
  return result.entries;
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
  params: Parameters<typeof loadSingleSkillDirectory>[0] & {
    canonicalSkillDir?: string;
    diagnostics?: ReturnType<typeof createSkillLoadDiagnostics>;
  },
): LoadedSkillRecord | null {
  const loaded = loadSingleSkillDirectory({
    ...params,
    onDiagnostic: (diagnostic) => {
      params.diagnostics?.add(diagnostic);
      if (params.onDiagnostic) {
        params.onDiagnostic(diagnostic);
      } else {
        warnInvalidSkill(params.source, diagnostic);
      }
    },
  });
  if (!loaded) {
    return null;
  }
  // Discovery selected one terminal SKILL.md; retain its parsed facts.
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
  diagnostics?: ReturnType<typeof createSkillLoadDiagnostics>;
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
  const discovered = discoverSkillCandidates({
    dir: params.dir,
    source: params.source,
    limits,
    allowedSymlinkTargetRealPaths,
    onDiagnostic: params.onDiagnostic,
  });
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
      diagnostics: params.diagnostics,
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
      return [rootRecord];
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
  return loadedSkills;
}

function loadGeneratedPluginSkillRecords(params: {
  pluginSkillsDir: string;
  pluginSkillRoots: readonly PluginSkillRoot[];
  source: string;
  limits: ResolvedSkillDiscoveryLimits;
  diagnostics: ReturnType<typeof createSkillLoadDiagnostics>;
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
      diagnostics: params.diagnostics,
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
  diagnostics: ReturnType<typeof createSkillLoadDiagnostics>,
  config?: OpenClawConfig,
  batch?: SkillSourceReadBatch,
): WorkspaceSkillSources["entries"] {
  const grouped = new Map<string, WorkspaceSkillSources["entries"]>();
  for (const root of plan.roots) {
    const { tier, order, ...policy } = root;
    const input = { ...policy, config };
    const records = grouped.get(tier) ?? [];
    for (const entry of readSourceEntries(batch, ["root", input], diagnostics, (collected) =>
      loadSkillRootRecords({ ...input, diagnostics: collected }).map(createSkillEntry),
    )) {
      records.push(order === undefined ? entry : { ...entry, sourceOrder: order });
    }
    grouped.set(tier, records);
  }
  const extra = grouped.get("extra") ?? [];
  if (plan.pluginSkillsDir) {
    const input = {
      pluginSkillsDir: plan.pluginSkillsDir,
      pluginSkillRoots: plan.pluginSkillRoots,
      source: "openclaw-extra",
      limits: resolveSkillDiscoveryLimits(config),
    };
    for (const record of readSourceEntries(batch, ["generated", input], diagnostics, (collected) =>
      loadGeneratedPluginSkillRecords({ ...input, diagnostics: collected }).map(createSkillEntry),
    )) {
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
  return ["extra", "bundled", "workshop", "managed", "personal", "workspace"].flatMap(
    (tier) => grouped.get(tier) ?? [],
  );
}

export function loadExecutionSkillEntries(
  executionWorkspaceDir: string,
  diagnostics: ReturnType<typeof createSkillLoadDiagnostics>,
  config?: OpenClawConfig,
  batch?: SkillSourceReadBatch,
): SkillEntry[] {
  return resolveWorkspaceSkillDirectories(executionWorkspaceDir).flatMap((root) => {
    const input = { ...root, config };
    return readSourceEntries(batch, ["root", input], diagnostics, (collected) =>
      loadSkillRootRecords({ ...input, diagnostics: collected }).map(createSkillEntry),
    );
  });
}
