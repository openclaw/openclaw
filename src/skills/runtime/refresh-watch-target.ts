import fs from "node:fs";
import path from "node:path";
import { resolveSkillsWatchPath, toWatchRoot } from "./refresh-watch-path.js";

export type SkillsWatchTarget = {
  path: string;
  watchRoot: string;
  depth: number;
};

function makeWatchTarget(raw: string, depth: number): SkillsWatchTarget {
  const watchPath = toWatchRoot(resolveSkillsWatchPath(raw));
  let watchRoot = watchPath;
  while (!fs.existsSync(watchRoot)) {
    const parent = path.dirname(watchRoot);
    if (parent === watchRoot) {
      break;
    }
    watchRoot = parent;
  }
  return { path: watchPath, watchRoot: toWatchRoot(watchRoot), depth };
}

function addWatchTarget(targets: Map<string, SkillsWatchTarget>, raw: string, depth: number): void {
  const target = makeWatchTarget(raw, depth);
  target.depth = Math.max(target.depth, targets.get(target.path)?.depth ?? 0);
  targets.set(target.path, target);
}

export function addSkillRootWatchTargets(
  targets: Map<string, SkillsWatchTarget>,
  root: string,
  rootDepth: number,
  groupedSkillsWatchDepth: number,
): string {
  addWatchTarget(targets, root, rootDepth);
  const companionSkillsRoot = path.join(root, "skills");
  addWatchTarget(targets, companionSkillsRoot, groupedSkillsWatchDepth);
  return companionSkillsRoot;
}
