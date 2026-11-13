import fs from "node:fs/promises";
import path from "node:path";
import { observeOwnedDirectory } from "../infra/owned-directory-observation.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import { createLazyPromise } from "../shared/lazy-promise.js";
import { runWorkspaceFilesystemOperation } from "./workspace-filesystem.js";
import type { WorkspaceStateGuard } from "./workspace-state-store.worker-contract.js";

/** Find the nearest Git metadata, including damaged linked-worktree pointers. */
export async function findGitCheckoutRoot(start: string): Promise<string | null> {
  let current = path.resolve(start);
  for (;;) {
    const metadata = path.join(current, ".git");
    if (await fs.stat(metadata).catch(() => undefined)) {
      try {
        if ((await fs.readdir(metadata)).length > 0) {
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

export async function insideGitCheckout(start: string): Promise<boolean> {
  return (await findGitCheckoutRoot(start)) !== null;
}

type WorkspaceCheckout = {
  value?: Promise<boolean>;
  watches: ReturnType<typeof observeOwnedDirectory>[];
};
const workspaceCheckouts = resolveGlobalMap<string, WorkspaceCheckout>(
  Symbol.for("openclaw.workspaceCheckouts"),
  (entries) => {
    for (const entry of entries.values()) {
      entry.watches.forEach((watch) => watch.close());
    }
    entries.clear();
  },
  "shared-state",
);

/** Display projection only; action admission keeps using current Git discovery. */
export function hasWorkspaceGitCheckout(start: string): Promise<boolean> {
  const key = path.resolve(start);
  let entry = workspaceCheckouts.get(key);
  if (!entry) {
    entry = { watches: [] };
    workspaceCheckouts.set(key, entry);
    const selected = entry;
    const invalidate = (_filename?: string, event?: string) => {
      // Recovery ticks preserve the recorded fact while native observation is healthy.
      if (event || selected.watches.some((watch) => !watch.isWatching())) {
        selected.value = undefined;
      }
    };
    // Ancestor metadata and replaced lexical aliases can both change checkout membership.
    for (
      let current = key, child: string | undefined;
      ;
      child = current, current = path.dirname(current)
    ) {
      const childName = child && path.basename(child);
      selected.watches.push(
        observeOwnedDirectory(current, (filename, event) => {
          if (!filename || filename === ".git" || filename === childName) {
            invalidate(filename, event);
          }
        }),
        observeOwnedDirectory(path.join(current, ".git"), (filename, event) => {
          if (!filename || event !== "change") {
            invalidate(filename, event);
          }
        }),
      );
      if (path.dirname(current) === current) {
        break;
      }
    }
    if (workspaceCheckouts.size > 128) {
      const oldest = workspaceCheckouts.entries().next().value!;
      oldest[1].watches.forEach((watch) => watch.close());
      workspaceCheckouts.delete(oldest[0]);
    }
  }
  return (entry.value ??= insideGitCheckout(key));
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
  guard?: WorkspaceStateGuard,
) {
  if (!isBrandNewWorkspace) {
    return;
  }
  guard?.assertHost?.();
  if (await fs.stat(path.join(dir, ".git")).catch(() => undefined)) {
    return;
  }
  if (!(await isGitAvailable())) {
    return;
  }
  guard?.assertHost?.();
  await runWorkspaceFilesystemOperation({ kind: "git-init", dir }, guard);
  const root = path.resolve(dir);
  for (const [workspace, entry] of workspaceCheckouts) {
    if (workspace === root || workspace.startsWith(root + path.sep)) {
      entry.value = undefined;
    }
  }
}
