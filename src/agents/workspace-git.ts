import { existsSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { createLazyPromise } from "../shared/lazy-promise.js";

/** Find the nearest Git metadata, including damaged linked-worktree pointers. */
export function findGitCheckoutRoot(start: string): string | null {
  let current = path.resolve(start);
  for (;;) {
    const metadata = path.join(current, ".git");
    if (existsSync(metadata)) {
      try {
        if (readdirSync(metadata).length > 0) {
          return current;
        }
      } catch {
        // Files and unreadable metadata still require checkout preservation.
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function insideGitCheckout(start: string): boolean {
  return findGitCheckoutRoot(start) !== null;
}

const WORKSPACE_GIT_CACHE_MS = 30_000;
const workspaceCheckouts = new Map<string, { value: boolean; checkedAt: number }>();

/** Display projection only; action admission keeps using current Git discovery. */
export function hasWorkspaceGitCheckout(start: string): boolean {
  const key = path.resolve(start);
  const cached = workspaceCheckouts.get(key);
  const now = Date.now();
  if (cached && now - cached.checkedAt < WORKSPACE_GIT_CACHE_MS) {
    return cached.value;
  }
  const entry = {
    value: insideGitCheckout(key),
    checkedAt: now,
  };
  workspaceCheckouts.set(key, entry);
  pruneMapToMaxSize(workspaceCheckouts, 128);
  return entry.value;
}

// Git availability is process-stable; cache the probe result, including failure, until restart.
const isGitAvailable = createLazyPromise(async () => {
  try {
    const { runCommandWithTimeout } = await import("../process/exec.js");
    const result = await runCommandWithTimeout(["git", "--version"], { timeoutMs: 2_000 });
    return result.code === 0;
  } catch {
    return false;
  }
});

export async function ensureGitRepo(
  dir: string,
  isBrandNewWorkspace: boolean,
  beforePersistentApply?: () => void,
) {
  if (!isBrandNewWorkspace) {
    return;
  }
  beforePersistentApply?.();
  if (await fs.stat(path.join(dir, ".git")).catch(() => undefined)) {
    return;
  }
  if (!(await isGitAvailable())) {
    return;
  }
  const { runCommandWithTimeout } = await import("../process/exec.js");
  beforePersistentApply?.();
  try {
    await runCommandWithTimeout(["git", "init"], { cwd: dir, timeoutMs: 10_000 });
  } catch {
    // Ignore git init failures; workspace creation should still succeed.
  }
  const root = path.resolve(dir);
  for (const workspace of workspaceCheckouts.keys()) {
    if (workspace === root || workspace.startsWith(root + path.sep)) {
      workspaceCheckouts.delete(workspace);
    }
  }
}
