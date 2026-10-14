import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { observeOwnedDirectory } from "../infra/owned-directory-observation.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { createLazyPromise } from "../shared/lazy-promise.js";

/** Find the nearest .git entry, including the file used by linked worktrees. */
export function findGitCheckoutRoot(start: string): string | null {
  let current = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(current, ".git"))) {
      return current;
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

const workspaceCheckouts = new Map<string, { value: boolean; refresh(): void; close(): void }>();

/** Display projection only; action admission keeps using current Git discovery. */
export function hasWorkspaceGitCheckout(start: string): boolean {
  const key = path.resolve(start);
  const cached = workspaceCheckouts.get(key);
  if (cached) {
    return cached.value;
  }
  const observers: Array<{ close(): void }> = [];
  let pending = false;
  const entry = {
    value: insideGitCheckout(key),
    refresh() {
      this.value = insideGitCheckout(key);
    },
    close() {
      for (const observer of observers) {
        observer.close();
      }
    },
  };
  workspaceCheckouts.set(key, entry);
  for (let directory = key, child: string | undefined; ;) {
    const childName = child;
    observers.push(
      observeOwnedDirectory(directory, (filename) => {
        if (!pending && (filename === undefined || filename === ".git" || filename === childName)) {
          pending = true;
          queueMicrotask(() => {
            pending = false;
            if (workspaceCheckouts.get(key) === entry) {
              entry.refresh();
            }
          });
        }
      }),
    );
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    child = path.basename(directory);
    directory = parent;
  }
  for (const [oldest, status] of workspaceCheckouts) {
    if (workspaceCheckouts.size <= 128) {
      break;
    }
    workspaceCheckouts.delete(oldest);
    status.close();
  }
  return entry.value;
}

// Git availability is process-stable; cache the probe result, including failure, until restart.
const isGitAvailable = createLazyPromise(async () => {
  try {
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
  beforePersistentApply?.();
  try {
    await runCommandWithTimeout(["git", "init"], { cwd: dir, timeoutMs: 10_000 });
  } catch {
    // Ignore git init failures; workspace creation should still succeed.
  }
  const root = path.resolve(dir);
  for (const [workspace, checkout] of workspaceCheckouts) {
    if (workspace === root || workspace.startsWith(root + path.sep)) {
      checkout.refresh();
    }
  }
}
