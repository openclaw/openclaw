import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isMissingPathError } from "../../infra/errors.js";
import { walkDirectorySync } from "../../infra/fs-safe.js";
import { isPathInside } from "../../infra/path-guards.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { LocalSkillLoadDiagnostic } from "./local-loader.js";
import type { PluginSkillRoot } from "./plugin-skill-root.js";
import { compactSkillPath } from "./skill-paths.js";
import { tryRealpath } from "./symlink-targets.js";
import type { ResolvedSkillDiscoveryLimits } from "./workspace-skill-sources.types.js";

export type { ResolvedSkillDiscoveryLimits } from "./workspace-skill-sources.types.js";

const skillsLogger = createSubsystemLogger("skills");

const DEFAULT_MAX_CANDIDATES_PER_ROOT = 300;
const DEFAULT_MAX_SKILLS_LOADED_PER_SOURCE = 200;
const DEFAULT_MAX_SKILL_FILE_BYTES = 256_000;
const DEFAULT_MIN_RAW_ENTRIES_PER_DIRECTORY_SCAN = 1_000;
const DEFAULT_MAX_RAW_ENTRIES_PER_DIRECTORY_SCAN = 10_000;
// Match Codex's bounded recursive skills discovery without letting broad
// workspace roots turn into unbounded filesystem walks.
const MAX_GROUPED_SKILL_SCAN_DEPTH = 6;
const MAX_CONFIGURED_ROOT_GROUPED_SKILL_SCAN_DEPTH = 2;

type SkillDiscoveryReporter = (diagnostic: LocalSkillLoadDiagnostic) => void;

export type CandidateSkillDir = {
  skillDir: string;
  skillDirRealPath: string;
  name: string;
};

type PluginSkillCandidate = {
  skillDir: string;
  skillDirRealPath: string;
  rejectHardlinks: boolean;
};

type DiscoveredSkillCandidates = {
  candidates: CandidateSkillDir[];
  rootIsSkill: boolean;
  configuredRootCandidate?: CandidateSkillDir;
};

type ChildDirectoryScan = {
  dirs: string[];
  scannedEntryCount: number;
  truncated: boolean;
};

type SkillDiscoveryBudget = {
  remainingDirectoryScans: number;
  remainingRawEntries: number;
  truncated: boolean;
};

export function resolveSkillDiscoveryLimits(config?: OpenClawConfig): ResolvedSkillDiscoveryLimits {
  const limits = config?.skills?.limits;
  return {
    maxCandidatesPerRoot: limits?.maxCandidatesPerRoot ?? DEFAULT_MAX_CANDIDATES_PER_ROOT,
    maxSkillsLoadedPerSource:
      limits?.maxSkillsLoadedPerSource ?? DEFAULT_MAX_SKILLS_LOADED_PER_SOURCE,
    maxSkillFileBytes: limits?.maxSkillFileBytes ?? DEFAULT_MAX_SKILL_FILE_BYTES,
  };
}

function listChildDirectories(
  dir: string,
  opts: {
    followSymlinks?: boolean;
    maxCandidateDirs: number;
    budget?: SkillDiscoveryBudget;
    onDiagnostic?: SkillDiscoveryReporter;
  },
): ChildDirectoryScan {
  const { budget } = opts;
  if (budget && (budget.remainingDirectoryScans <= 0 || budget.remainingRawEntries <= 0)) {
    budget.truncated = true;
    return { dirs: [], scannedEntryCount: 0, truncated: false };
  }
  if (budget) {
    budget.remainingDirectoryScans -= 1;
  }
  const maxRawEntriesToScan = resolveRawEntryScanLimit(opts.maxCandidateDirs);
  // Following links inside the walker drops lookup errors. Keep them visible
  // here so audit reports broken targets while still scanning valid siblings.
  const scan = walkDirectorySync(dir, {
    maxDepth: 1,
    maxEntries: budget
      ? Math.min(maxRawEntriesToScan, budget.remainingRawEntries)
      : maxRawEntriesToScan,
    symlinks: opts.followSymlinks === false ? "skip" : "include",
    include: (entry) =>
      (entry.kind === "directory" || entry.kind === "symlink") &&
      !entry.name.startsWith(".") &&
      entry.name !== "node_modules",
  });
  const dirs = scan.entries.flatMap((entry) => {
    try {
      return entry.kind === "directory" || fs.statSync(entry.path).isDirectory()
        ? [entry.name]
        : [];
    } catch (error) {
      opts.onDiagnostic?.({ kind: "read", path: entry.path, message: String(error) });
      return [];
    }
  });
  for (const failure of scan.failedDirs) {
    if (!isMissingPathError(failure.error)) {
      opts.onDiagnostic?.({ kind: "read", path: failure.path, message: String(failure.error) });
    }
  }
  if (budget) {
    budget.remainingRawEntries = Math.max(0, budget.remainingRawEntries - scan.scannedEntryCount);
    budget.truncated ||= scan.truncated;
  }
  return {
    dirs,
    scannedEntryCount: scan.scannedEntryCount,
    truncated: scan.truncated,
  };
}

function resolveRawEntryScanLimit(maxCandidateDirs: number): number {
  if (maxCandidateDirs <= 0) {
    return 0;
  }
  return Math.min(
    DEFAULT_MAX_RAW_ENTRIES_PER_DIRECTORY_SCAN,
    Math.max(DEFAULT_MIN_RAW_ENTRIES_PER_DIRECTORY_SCAN, maxCandidateDirs * 10),
  );
}

function createSkillDiscoveryBudget(maxCandidateDirs: number): SkillDiscoveryBudget {
  const normalized = Math.max(0, maxCandidateDirs);
  return {
    remainingDirectoryScans: normalized * MAX_GROUPED_SKILL_SCAN_DEPTH,
    remainingRawEntries: resolveRawEntryScanLimit(normalized) * (normalized + 1),
    truncated: false,
  };
}

function hasSkillFileCandidate(skillDir: string): boolean {
  try {
    fs.lstatSync(path.join(skillDir, "SKILL.md"));
    return true;
  } catch (error) {
    return !isMissingPathError(error);
  }
}

function containsDiscoverableSkill(
  dir: string,
  opts: {
    maxCandidateDirs: number;
    skipTopLevelDirName?: string;
    includeRoot?: boolean;
    symlinkCandidates?: boolean;
  },
): boolean {
  const discoveryBudget = createSkillDiscoveryBudget(opts.maxCandidateDirs);
  const queue: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];
  for (const candidate of queue) {
    if ((opts.includeRoot || candidate.depth > 0) && hasSkillFileCandidate(candidate.dir)) {
      return true;
    }
    if (candidate.depth >= MAX_GROUPED_SKILL_SCAN_DEPTH) {
      continue;
    }
    if (
      opts.symlinkCandidates &&
      hasCandidateSymlinkChild(
        candidate.dir,
        candidate.depth === 0 ? opts.skipTopLevelDirName : undefined,
        resolveRawEntryScanLimit(opts.maxCandidateDirs),
      )
    ) {
      return true;
    }
    const childDirs = listChildDirectories(candidate.dir, {
      budget: discoveryBudget,
      followSymlinks: false,
      maxCandidateDirs: opts.maxCandidateDirs,
    }).dirs;
    for (const childDir of childDirs.toSorted().slice(0, opts.maxCandidateDirs)) {
      if (candidate.depth === 0 && childDir === opts.skipTopLevelDirName) {
        continue;
      }
      queue.push({ dir: path.join(candidate.dir, childDir), depth: candidate.depth + 1 });
    }
  }
  return false;
}

function hasCandidateSymlinkChild(
  dir: string,
  skipName: string | undefined,
  maxEntriesToScan: number,
): boolean {
  const maxEntries = Math.max(0, maxEntriesToScan);
  if (maxEntries === 0) {
    return false;
  }
  let handle: fs.Dir | undefined;
  try {
    handle = fs.opendirSync(dir);
    for (let scanned = 0; scanned < maxEntries; scanned += 1) {
      const entry = handle.readSync();
      if (!entry) {
        break;
      }
      if (entry.name === skipName || entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      if (entry.isSymbolicLink()) {
        return true;
      }
    }
  } catch {
    return false;
  } finally {
    handle?.closeSync();
  }
  return false;
}

export function isSymlinkPath(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

function warnEscapedSkillPath(params: {
  source: string;
  rootDir: string;
  rootRealPath: string;
  candidatePath: string;
  candidateRealPath: string;
}) {
  const compactRootDir = compactSkillPath(params.rootDir);
  const compactRootRealPath = compactSkillPath(params.rootRealPath);
  const compactCandidatePath = compactSkillPath(params.candidatePath);
  const compactCandidateRealPath = compactSkillPath(params.candidateRealPath);
  const rootResolved =
    path.resolve(params.rootDir) === params.rootRealPath
      ? ""
      : ` rootResolved=${compactRootRealPath}`;
  const candidateIsSymlink = isSymlinkPath(params.candidatePath);
  const bundled = params.source === "openclaw-bundled";
  const reason = bundled
    ? candidateIsSymlink
      ? "bundled-symlink-escape"
      : "bundled-root-escape"
    : candidateIsSymlink
      ? "symlink-escape"
      : "path-escape";
  const consoleHint = `reason=${reason}${bundled ? " hint=likely-stray-local-symlink-or-checkout-mutation" : ""}`;
  skillsLogger.warn("Skipping escaped skill path outside its configured root.", {
    source: params.source,
    rootDir: params.rootDir,
    rootRealPath: params.rootRealPath,
    path: params.candidatePath,
    realPath: params.candidateRealPath,
    reason,
    consoleMessage:
      `Skipping escaped skill path outside its configured root: ` +
      `source=${params.source} root=${compactRootDir}${rootResolved} ` +
      `${consoleHint} requested=${compactCandidatePath} ` +
      `resolved=${compactCandidateRealPath}`,
  });
}

function resolveContainedSkillPath(params: {
  source: string;
  rootDir: string;
  rootRealPath: string;
  candidatePath: string;
  allowedSymlinkTargetRealPaths?: readonly string[];
  onDiagnostic?: SkillDiscoveryReporter;
}): string | null {
  const candidateRealPath = tryRealpath(params.candidatePath);
  if (!candidateRealPath) {
    params.onDiagnostic?.({
      kind: "read",
      path: params.candidatePath,
      message: "Could not resolve skill path.",
    });
    return null;
  }
  if (
    isPathInside(params.rootRealPath, candidateRealPath) ||
    params.allowedSymlinkTargetRealPaths?.some((root) =>
      isPathInside(path.resolve(root), path.resolve(candidateRealPath)),
    )
  ) {
    return candidateRealPath;
  }
  warnEscapedSkillPath({
    source: params.source,
    rootDir: params.rootDir,
    rootRealPath: params.rootRealPath,
    candidatePath: path.resolve(params.candidatePath),
    candidateRealPath,
  });
  params.onDiagnostic?.({
    kind: "invalid",
    path: params.candidatePath,
    message: "Skill path resolves outside its configured root.",
  });
  return null;
}

function resolveNestedSkillsRoot(dir: string, maxEntriesToScan: number): string {
  const nested = path.join(dir, "skills");
  try {
    if (!fs.existsSync(nested) || !fs.statSync(nested).isDirectory()) {
      return dir;
    }
  } catch {
    return dir;
  }

  const scanLimit = Math.max(0, maxEntriesToScan);
  if (
    !hasSkillFileCandidate(dir) &&
    containsDiscoverableSkill(dir, {
      maxCandidateDirs: scanLimit,
      skipTopLevelDirName: "skills",
      symlinkCandidates: true,
    })
  ) {
    return dir;
  }

  return containsDiscoverableSkill(nested, { maxCandidateDirs: scanLimit, includeRoot: true })
    ? nested
    : dir;
}

function shouldEnforceConfiguredSkillRootContainment(source: string): boolean {
  return source !== "openclaw-managed" && source !== "agents-skills-personal";
}

function shouldUseConfiguredSymlinkTargets(source: string): boolean {
  return (
    source === "openclaw-workspace" ||
    source === "openclaw-extra" ||
    source === "agents-skills-project"
  );
}

function resolveSkillRootCandidatePath(params: {
  source: string;
  rootDir: string;
  rootRealPath: string;
  candidatePath: string;
  allowedSymlinkTargetRealPaths: readonly string[];
  onDiagnostic?: SkillDiscoveryReporter;
}): string | null {
  if (!shouldEnforceConfiguredSkillRootContainment(params.source)) {
    return tryRealpath(params.candidatePath);
  }
  return resolveContainedSkillPath({
    ...params,
    allowedSymlinkTargetRealPaths: shouldUseConfiguredSymlinkTargets(params.source)
      ? params.allowedSymlinkTargetRealPaths
      : [],
  });
}

export function canonicalSkillDirForSource(
  source: string,
  skillDirRealPath: string,
): string | undefined {
  return shouldEnforceConfiguredSkillRootContainment(source) ? undefined : skillDirRealPath;
}

function resolveSkillFilePath(params: {
  source: string;
  skillDir: string;
  skillDirRealPath: string;
  onDiagnostic?: SkillDiscoveryReporter;
}): string | null {
  const candidatePath = path.join(params.skillDir, "SKILL.md");
  const resolved = resolveContainedSkillPath({
    source: params.source,
    rootDir: params.skillDir,
    rootRealPath: params.skillDirRealPath,
    candidatePath,
    onDiagnostic: params.onDiagnostic,
  });
  // Let the root-scoped loader diagnose named paths that cannot be resolved.
  return resolved || tryRealpath(candidatePath) ? resolved : path.resolve(candidatePath);
}

export function discoverSkillCandidates(params: {
  dir: string;
  source: string;
  limits: ResolvedSkillDiscoveryLimits;
  allowedSymlinkTargetRealPaths: readonly string[];
  onDiagnostic?: SkillDiscoveryReporter;
}): DiscoveredSkillCandidates {
  const rootDir = path.resolve(params.dir);
  let rootRealPath: string;
  try {
    rootRealPath = fs.realpathSync(rootDir);
  } catch (error) {
    if (!isMissingPathError(error)) {
      params.onDiagnostic?.({ kind: "read", path: rootDir, message: String(error) });
    }
    return { candidates: [], rootIsSkill: false };
  }
  // Workshop roots are containers; promotion would hide a child skill named "skills".
  const rootIsContainer = params.source === "openclaw-workshop";
  const baseDir = rootIsContainer
    ? rootDir
    : resolveNestedSkillsRoot(params.dir, params.limits.maxCandidatesPerRoot);
  const baseDirRealPath = resolveSkillRootCandidatePath({
    source: params.source,
    rootDir,
    rootRealPath,
    candidatePath: baseDir,
    allowedSymlinkTargetRealPaths: params.allowedSymlinkTargetRealPaths,
    onDiagnostic: params.onDiagnostic,
  });
  if (!baseDirRealPath) {
    return { candidates: [], rootIsSkill: false };
  }

  if (!rootIsContainer && hasSkillFileCandidate(baseDir)) {
    const rootSkillRealPath = resolveSkillFilePath({
      source: params.source,
      skillDir: baseDir,
      skillDirRealPath: baseDirRealPath,
      onDiagnostic: params.onDiagnostic,
    });
    return {
      candidates: rootSkillRealPath
        ? [
            {
              skillDir: baseDir,
              skillDirRealPath: baseDirRealPath,
              name: path.basename(baseDir),
            },
          ]
        : [],
      rootIsSkill: true,
    };
  }

  const maxCandidatesPerRoot = Math.max(0, params.limits.maxCandidatesPerRoot);
  const maxSkillsLoadedPerSource = Math.max(0, params.limits.maxSkillsLoadedPerSource);
  const nestedSkillsRootPath = path.resolve(baseDir, "skills");
  const baseDirIsNestedSkillsRoot = path.resolve(baseDir) === path.resolve(rootDir, "skills");
  const baseDirLooksLikeSkillsRoot = path.basename(baseDir) === "skills";
  const discoveryBudget = createSkillDiscoveryBudget(maxCandidatesPerRoot);
  const reportTruncatedScan = (scan: ChildDirectoryScan, nestedDir?: string) => {
    const candidateLimitReached = scan.dirs.length > maxCandidatesPerRoot;
    discoveryBudget.truncated ||= candidateLimitReached;
    if (!scan.truncated && !candidateLimitReached) {
      return;
    }
    const subject = nestedDir ? "Nested skills directory" : "Skills root";
    const reason = scan.truncated ? "looks suspiciously large" : "has many entries";
    skillsLogger.warn(`${subject} ${reason}, truncating discovery.`, {
      dir: params.dir,
      baseDir,
      ...(nestedDir
        ? { nestedDir, nestedChildDirCount: scan.dirs.length }
        : { childDirCount: scan.dirs.length }),
      ...(scan.truncated
        ? {
            scannedEntryCount: scan.scannedEntryCount,
            maxEntriesToScan: resolveRawEntryScanLimit(maxCandidatesPerRoot),
          }
        : {}),
      maxCandidatesPerRoot: params.limits.maxCandidatesPerRoot,
      maxSkillsLoadedPerSource: params.limits.maxSkillsLoadedPerSource,
      ...(nestedDir ? { maxGroupedSkillScanDepth: MAX_GROUPED_SKILL_SCAN_DEPTH } : {}),
    });
  };
  const childDirScan = listChildDirectories(baseDir, {
    budget: discoveryBudget,
    maxCandidateDirs: maxCandidatesPerRoot,
    onDiagnostic: params.onDiagnostic,
  });
  const childDirs = childDirScan.dirs.toSorted();
  const limitedChildren =
    maxSkillsLoadedPerSource === 0 ? [] : childDirs.slice(0, maxCandidatesPerRoot);
  if (
    maxSkillsLoadedPerSource > 0 &&
    childDirs.includes("skills") &&
    !limitedChildren.includes("skills")
  ) {
    limitedChildren.push("skills");
  }

  reportTruncatedScan(childDirScan);

  let configuredRootCandidate: CandidateSkillDir | undefined;
  if (!rootIsContainer && path.resolve(baseDir) !== rootDir && hasSkillFileCandidate(rootDir)) {
    const configuredRootSkillRealPath = resolveSkillFilePath({
      source: params.source,
      skillDir: rootDir,
      skillDirRealPath: rootRealPath,
      onDiagnostic: params.onDiagnostic,
    });
    if (configuredRootSkillRealPath) {
      configuredRootCandidate = {
        skillDir: rootDir,
        skillDirRealPath: rootRealPath,
        name: path.basename(rootDir),
      };
    }
  }
  const skillCandidates: CandidateSkillDir[] = [];
  const scanQueue: Array<{ skillDir: string; name: string; depth: number }> = limitedChildren.map(
    (name) => ({
      skillDir: path.join(baseDir, name),
      name,
      depth: name === "skills" && !hasSkillFileCandidate(path.join(baseDir, name)) ? 0 : 1,
    }),
  );

  for (const candidate of scanQueue) {
    const skillDirRealPath = resolveSkillRootCandidatePath({
      source: params.source,
      rootDir,
      rootRealPath: baseDirRealPath,
      candidatePath: candidate.skillDir,
      allowedSymlinkTargetRealPaths: params.allowedSymlinkTargetRealPaths,
      onDiagnostic: params.onDiagnostic,
    });
    if (!skillDirRealPath) {
      continue;
    }

    if (hasSkillFileCandidate(candidate.skillDir)) {
      const skillMdRealPath = resolveSkillFilePath({
        source: params.source,
        skillDir: candidate.skillDir,
        skillDirRealPath,
        onDiagnostic: params.onDiagnostic,
      });
      if (skillMdRealPath) {
        skillCandidates.push({
          skillDir: candidate.skillDir,
          skillDirRealPath,
          name: candidate.name,
        });
      }
      continue;
    }

    const candidatePath = path.resolve(candidate.skillDir);
    const maxGroupedDepth =
      params.source === "openclaw-extra" &&
      !baseDirIsNestedSkillsRoot &&
      !baseDirLooksLikeSkillsRoot &&
      candidatePath !== nestedSkillsRootPath &&
      !isPathInside(nestedSkillsRootPath, candidatePath)
        ? MAX_CONFIGURED_ROOT_GROUPED_SKILL_SCAN_DEPTH
        : MAX_GROUPED_SKILL_SCAN_DEPTH;
    if (candidate.depth >= maxGroupedDepth) {
      continue;
    }

    const nestedChildScan = listChildDirectories(candidate.skillDir, {
      budget: discoveryBudget,
      maxCandidateDirs: maxCandidatesPerRoot,
      onDiagnostic: params.onDiagnostic,
    });
    const nestedChildren = nestedChildScan.dirs;
    reportTruncatedScan(nestedChildScan, candidate.skillDir);

    for (const nestedName of nestedChildren.toSorted().slice(0, maxCandidatesPerRoot)) {
      scanQueue.push({
        skillDir: path.join(candidate.skillDir, nestedName),
        name: `${candidate.name}/${nestedName}`,
        depth: candidate.depth + 1,
      });
    }
  }

  if (discoveryBudget.truncated) {
    params.onDiagnostic?.({
      kind: "invalid",
      path: rootDir,
      message:
        "Skill inventory reached its discovery limit; inspect the remaining skills separately.",
    });
    skillsLogger.warn("Skills root hit recursive discovery budget, truncating discovery.", {
      dir: params.dir,
      baseDir,
      maxCandidatesPerRoot: params.limits.maxCandidatesPerRoot,
      maxSkillsLoadedPerSource: params.limits.maxSkillsLoadedPerSource,
      maxGroupedSkillScanDepth: MAX_GROUPED_SKILL_SCAN_DEPTH,
    });
  }

  return {
    candidates: skillCandidates.toSorted((a, b) => a.name.localeCompare(b.name)),
    rootIsSkill: false,
    ...(configuredRootCandidate ? { configuredRootCandidate } : {}),
  };
}

/** Discover validated generated plugin-skill symlink candidates. */
export function discoverPluginSkills(params: {
  pluginSkillsDir: string;
  pluginSkillRoots: readonly PluginSkillRoot[];
  source: string;
  limits: ResolvedSkillDiscoveryLimits;
}): PluginSkillCandidate[] {
  // Root order owns hardlink provenance, including aliases of the same directory.
  // Resolve once per discovery and carry the first match through the file read.
  const allowedRoots = params.pluginSkillRoots.map(({ dir, rejectHardlinks }) => ({
    realPath: tryRealpath(dir),
    rejectHardlinks,
  }));
  if (!allowedRoots.some(({ realPath }) => realPath !== null)) {
    return [];
  }

  const rootDir = path.resolve(params.pluginSkillsDir);
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  const rootRealPath = tryRealpath(rootDir) ?? rootDir;
  const maxCandidatesPerRoot = Math.max(0, params.limits.maxCandidatesPerRoot);
  const maxSkillsLoadedPerSource = Math.max(0, params.limits.maxSkillsLoadedPerSource);
  const childDirScan = listChildDirectories(rootDir, {
    maxCandidateDirs: maxCandidatesPerRoot,
  });
  const childDirs =
    maxSkillsLoadedPerSource === 0
      ? []
      : childDirScan.dirs.toSorted().slice(0, maxCandidatesPerRoot);
  const candidates: PluginSkillCandidate[] = [];

  for (const name of childDirs) {
    const skillDir = path.join(rootDir, name);
    if (!isSymlinkPath(skillDir)) {
      continue;
    }
    const skillDirRealPath = tryRealpath(skillDir);
    const pluginRoot =
      skillDirRealPath &&
      allowedRoots.find(
        ({ realPath }) => realPath !== null && isPathInside(realPath, skillDirRealPath),
      );
    if (!skillDirRealPath || !pluginRoot) {
      if (skillDirRealPath) {
        warnEscapedSkillPath({
          source: params.source,
          rootDir,
          rootRealPath,
          candidatePath: path.resolve(skillDir),
          candidateRealPath: skillDirRealPath,
        });
      }
      continue;
    }

    const skillMd = path.join(skillDir, "SKILL.md");
    let skillMdStat: fs.Stats;
    try {
      skillMdStat = fs.lstatSync(skillMd);
    } catch {
      continue;
    }
    if (!skillMdStat.isFile() || skillMdStat.isSymbolicLink()) {
      continue;
    }
    const skillMdRealPath = tryRealpath(skillMd);
    if (!skillMdRealPath || !isPathInside(skillDirRealPath, skillMdRealPath)) {
      continue;
    }
    candidates.push({ skillDir, skillDirRealPath, rejectHardlinks: pluginRoot.rejectHardlinks });
  }
  return candidates;
}
