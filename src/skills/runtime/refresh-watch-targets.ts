import fs from "node:fs";
import path from "node:path";
import { resolveRealpathOrAbsolute } from "../../infra/boundary-path.js";
import { tryRealpath } from "../loading/symlink-targets.js";
import {
  DEFAULT_SKILLS_WATCH_IGNORED,
  isTrustedSymlinkSkillTarget,
  makeSkillsWatchTarget,
  readBudgetedDirEntries,
} from "./refresh-watch-path.js";

export type WatchTarget = {
  path: string;
  watchRoot: string;
  depth: number;
  executionOnly?: true;
};

export const GROUPED_SKILLS_WATCH_DEPTH = 6;
const CONFIGURED_ROOT_WATCH_DEPTH = 2;
const MAX_SYMLINK_WATCH_TARGETS_PER_ROOT = 100;
const MAX_SYMLINK_WATCH_DIRECTORY_SCANS_PER_ROOT = 200;
const MAX_SYMLINK_WATCH_RAW_ENTRIES_PER_ROOT = 2_000;

function addWatchTarget(targets: Map<string, WatchTarget>, raw: string, depth: number): void {
  const target = makeSkillsWatchTarget(raw, depth);
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

export function addSkillSourceWatchTargets(
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
  const rootRealPath = resolveRealpathOrAbsolute(root);
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
    resolveRealpathOrAbsolute(companionSkillsRoot),
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
  for (const queued of queue) {
    if (
      watched >= MAX_SYMLINK_WATCH_TARGETS_PER_ROOT ||
      directoryScans >= MAX_SYMLINK_WATCH_DIRECTORY_SCANS_PER_ROOT ||
      rawEntries >= MAX_SYMLINK_WATCH_RAW_ENTRIES_PER_ROOT
    ) {
      break;
    }
    const current = queued;
    if (!current) {
      continue;
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
      if (DEFAULT_SKILLS_WATCH_IGNORED.some((re) => re.test(childPath))) {
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
