import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "../../infra/path-guards.js";
import { worktreePathExists } from "./git.js";

export async function canonicalPathKey(target: string): Promise<string> {
  const canonical = await fs.realpath(target);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export async function shouldPreserveOrphanCandidate(
  target: string,
  managedPaths: ReadonlySet<string>,
  customRoots: ReadonlySet<string>,
): Promise<boolean> {
  const targetKey = await canonicalPathKey(target);
  if (
    managedPaths.has(targetKey) ||
    [...customRoots].some((root) => isPathInside(root, targetKey) || isPathInside(targetKey, root))
  ) {
    return true;
  }
  // Any top-level .git entry marks uncertain user work; broken indirection only
  // strengthens preservation and must never abort global orphan cleanup.
  return await worktreePathExists(path.join(target, ".git"));
}
