import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { isPathInside } from "../../infra/path-guards.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { tryRealpath } from "../loading/symlink-targets.js";
import type { WorkspaceSkillSourcePlan } from "../loading/workspace-skill-sources.js";
import { areOrderedArraysEqual } from "./ordered-array-equality.js";
import { resolveSkillsWatchSourceRoots } from "./refresh-source-roots.js";
import {
  DEFAULT_SKILLS_WATCH_IGNORED,
  isTrustedSymlinkSkillTarget,
  readBudgetedDirEntries,
  toWatchRoot,
} from "./refresh-watch-path.js";

export type WatchTarget = {
  path: string;
  authorityPath: string;
  depth: number;
  executionOnly?: true;
};

function skillsWatchTargetsMatch(previous: WatchTarget, next: WatchTarget): boolean {
  return (
    previous.path === next.path &&
    previous.authorityPath === next.authorityPath &&
    previous.depth === next.depth &&
    previous.executionOnly === next.executionOnly
  );
}

export function compareSkillsWatchTargets(
  previous: readonly WatchTarget[],
  next: readonly WatchTarget[],
  covered: readonly WatchTarget[],
): { targetsUnchanged: boolean; sharedTargetsChanged: boolean } {
  // Resolved targets have stable sorted order, so positional equality is intentional.
  const targetsUnchanged = areOrderedArraysEqual(previous, next, skillsWatchTargetsMatch);
  if (targetsUnchanged) {
    return { targetsUnchanged, sharedTargetsChanged: false };
  }
  const sharedTargetsChanged =
    next.some(
      (target) =>
        !target.executionOnly && !covered.some((prior) => skillsWatchTargetsMatch(prior, target)),
    ) ||
    previous.some(
      (prior) =>
        !prior.executionOnly && !next.some((target) => skillsWatchTargetsMatch(prior, target)),
    );
  return { targetsUnchanged, sharedTargetsChanged };
}

export type SkillsWatchTargetCacheEntry = {
  signature: string;
  targets: WatchTarget[];
};

const GROUPED_SKILLS_WATCH_DEPTH = 6;
const CONFIGURED_ROOT_WATCH_DEPTH = 2;
const MAX_SYMLINK_WATCH_TARGETS_PER_ROOT = 100;
const MAX_SYMLINK_WATCH_DIRECTORY_SCANS_PER_ROOT = 200;
const MAX_SYMLINK_WATCH_RAW_ENTRIES_PER_ROOT = 2_000;

export function resolveSkillsWatchTargets(
  workspaceDir: string,
  config: OpenClawConfig | undefined,
  agentId: string | undefined,
  executionWorkspaceDir: string | undefined,
  pluginMetadataSnapshot: PluginMetadataSnapshot | undefined,
  sourcePlan?: WorkspaceSkillSourcePlan,
  cached?: SkillsWatchTargetCacheEntry,
): SkillsWatchTargetCacheEntry {
  const { executionRoots, baseRoots, extraDirs, pluginSkillDirs, allowedSymlinkTargetRealPaths } =
    resolveSkillsWatchSourceRoots(
      workspaceDir,
      config,
      agentId,
      executionWorkspaceDir,
      pluginMetadataSnapshot,
      sourcePlan,
    );
  const signature = JSON.stringify({
    basePaths: baseRoots.map((root) => toWatchRoot(root.path)),
    executionPaths: executionRoots.map((root) => toWatchRoot(root.dir)),
    extraDirs: extraDirs.map(toWatchRoot),
    pluginSkillDirs: pluginSkillDirs.map(toWatchRoot),
    allowSymlinkTargets: allowedSymlinkTargetRealPaths,
  });
  if (cached?.signature === signature) {
    return cached;
  }

  const targets = new Map<string, WatchTarget>();
  for (const root of baseRoots) {
    addSkillSourceWatchTargets(
      targets,
      root.path,
      root.source,
      allowedSymlinkTargetRealPaths,
      GROUPED_SKILLS_WATCH_DEPTH,
    );
  }
  for (const resolved of extraDirs) {
    addSkillSourceWatchTargets(targets, resolved, "openclaw-extra", allowedSymlinkTargetRealPaths);
  }
  for (const dir of pluginSkillDirs) {
    addSkillSourceWatchTargets(targets, dir, "openclaw-plugin", allowedSymlinkTargetRealPaths);
  }
  const executionTargets = new Map<string, WatchTarget>();
  for (const root of executionRoots) {
    addSkillSourceWatchTargets(
      executionTargets,
      root.dir,
      root.source,
      allowedSymlinkTargetRealPaths,
      GROUPED_SKILLS_WATCH_DEPTH,
    );
  }
  for (const [key, target] of executionTargets) {
    const shared = targets.get(key);
    if (shared) {
      shared.depth = Math.max(shared.depth, target.depth);
    } else {
      targets.set(key, { ...target, executionOnly: true });
    }
  }
  const sortedTargets = Array.from(targets.values()).toSorted((a, b) =>
    a.path.localeCompare(b.path),
  );
  const authorityWorkspaces = [workspaceDir, executionWorkspaceDir].flatMap((workspace) =>
    workspace ? [workspace, resolvePathViaExistingAncestorSync(workspace)] : [],
  );
  for (const target of sortedTargets) {
    // Explicit workspace parents survive replacement of workspace-owned roots.
    // External configured/plugin/target roots retain their own admitted parent.
    for (const workspace of authorityWorkspaces) {
      if (isPathInside(workspace, target.path)) {
        target.authorityPath = path.dirname(workspace);
        break;
      }
    }
  }
  return { signature, targets: sortedTargets };
}

function addWatchTarget(targets: Map<string, WatchTarget>, raw: string, depth: number): void {
  const target: WatchTarget = { path: toWatchRoot(raw), authorityPath: path.dirname(raw), depth };
  target.depth = Math.max(target.depth, targets.get(target.path)?.depth ?? 0);
  targets.set(target.path, target);
}

function addSkillRootWatchTargets(
  targets: Map<string, WatchTarget>,
  root: string,
  rootDepth: number,
): string {
  addWatchTarget(targets, root, rootDepth);
  const companionSkillsRoot = path.join(root, "skills");
  addWatchTarget(targets, companionSkillsRoot, GROUPED_SKILLS_WATCH_DEPTH);
  return companionSkillsRoot;
}

function addSkillSourceWatchTargets(
  targets: Map<string, WatchTarget>,
  root: string,
  source: string,
  allowedSymlinkTargetRealPaths: readonly string[],
  rootDepth = path.basename(root) === "skills"
    ? GROUPED_SKILLS_WATCH_DEPTH
    : CONFIGURED_ROOT_WATCH_DEPTH,
): void {
  const companionSkillsRoot = addSkillRootWatchTargets(targets, root, rootDepth);
  // Both bounded scans share the source's containment identity for this preparation.
  // Trusted symlink leaves below remain registration-only, never recursive scans.
  const rootRealPath = resolvePathViaExistingAncestorSync(root);
  if (toWatchRoot(rootRealPath) !== toWatchRoot(root)) {
    // The configured source admits its canonical root even when an ancestor,
    // rather than the leaf, is the alias (including missing descendants).
    addSkillRootWatchTargets(targets, rootRealPath, rootDepth);
  }
  addTrustedSymlinkSkillWatchTargets(
    targets,
    root,
    source,
    allowedSymlinkTargetRealPaths,
    rootDepth,
    rootRealPath,
    rootRealPath,
  );
  addTrustedSymlinkSkillWatchTargets(
    targets,
    companionSkillsRoot,
    source,
    allowedSymlinkTargetRealPaths,
    GROUPED_SKILLS_WATCH_DEPTH,
    rootRealPath,
    resolvePathViaExistingAncestorSync(companionSkillsRoot),
  );
}

function addTrustedSymlinkSkillWatchTargets(
  targets: Map<string, WatchTarget>,
  root: string,
  source: string,
  allowedSymlinkTargetRealPaths: readonly string[],
  maxDepth: number,
  containmentRootRealPath: string,
  rootRealPath: string,
): void {
  try {
    if (
      fs.lstatSync(root).isSymbolicLink() &&
      isTrustedSymlinkSkillTarget(
        source,
        containmentRootRealPath,
        rootRealPath,
        allowedSymlinkTargetRealPaths,
      )
    ) {
      addSkillRootWatchTargets(targets, rootRealPath, maxDepth);
    }
  } catch {
    return;
  }
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let watched = 0;
  let directoryScans = 0;
  let rawEntries = 0;
  for (const current of queue) {
    if (
      watched >= MAX_SYMLINK_WATCH_TARGETS_PER_ROOT ||
      directoryScans >= MAX_SYMLINK_WATCH_DIRECTORY_SCANS_PER_ROOT ||
      rawEntries >= MAX_SYMLINK_WATCH_RAW_ENTRIES_PER_ROOT
    ) {
      break;
    }
    const scan = readBudgetedDirEntries(
      current.dir,
      MAX_SYMLINK_WATCH_RAW_ENTRIES_PER_ROOT - rawEntries,
    );
    directoryScans += 1;
    rawEntries += scan.scannedEntryCount;
    if (!scan.ok) {
      continue;
    }
    for (const entry of scan.entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (watched >= MAX_SYMLINK_WATCH_TARGETS_PER_ROOT) {
        break;
      }
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const childPath = path.join(current.dir, entry.name);
      // Exclusions apply within this admitted source, never to its ancestors.
      if (DEFAULT_SKILLS_WATCH_IGNORED.some((re) => re.test(path.relative(root, childPath)))) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        const targetRealPath = tryRealpath(childPath);
        if (
          targetRealPath &&
          isTrustedSymlinkSkillTarget(
            source,
            containmentRootRealPath,
            targetRealPath,
            allowedSymlinkTargetRealPaths,
          )
        ) {
          addSkillRootWatchTargets(targets, targetRealPath, GROUPED_SKILLS_WATCH_DEPTH);
          watched += 1;
        }
        continue;
      }
      if (entry.isDirectory() && current.depth < maxDepth) {
        queue.push({ dir: childPath, depth: current.depth + 1 });
      }
    }
  }
}
