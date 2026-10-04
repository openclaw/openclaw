import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { isMissingPathError } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { WorktreeAllocationGuard } from "./allocation.js";
import type { WorktreeGcProgress } from "./gc-progress.js";
import {
  canonicalPathKey,
  resolveManagedWorktreePathKeys,
  shouldPreserveOrphanCandidate,
} from "./orphan-paths.js";
import { getRegistryWorktree, listRegistryWorktrees } from "./registry.js";
import { retireManagedWorktreeSnapshot } from "./snapshot-host.js";
import { WORKTREE_TEMPLATE_DIRECTORY } from "./template-cache.js";
import type { ManagedWorktreeRecord } from "./types.js";

const log = createSubsystemLogger("agents/worktrees");

export async function collectRetiredWorktreeArtifacts({
  env,
  getConfig,
  records,
  expiresBefore,
  progress,
  withAllocationLease,
}: {
  env: NodeJS.ProcessEnv;
  getConfig?: () => OpenClawConfig;
  records: readonly ManagedWorktreeRecord[];
  expiresBefore: number;
  progress: WorktreeGcProgress;
  withAllocationLease: (run: (guard: WorktreeAllocationGuard) => Promise<void>) => Promise<void>;
}): Promise<{ orphansDeleted: number; snapshotsPruned: number }> {
  let orphansDeleted = 0;
  let snapshotsPruned = 0;
  const expired = records.filter(
    (record) => record.removedAt !== undefined && record.removedAt < expiresBefore,
  );
  const entries = await fs
    .readdir(path.join(resolveStateDir(env), "worktrees"), { withFileTypes: true })
    .catch(() => []);
  const hasOrphanCandidates = entries.some(
    (entry) => entry.isDirectory() && entry.name !== WORKTREE_TEMPLATE_DIRECTORY,
  );
  if (hasOrphanCandidates || expired.length > 0) {
    try {
      // Skip empty passes above; all destructive cleanup uses fresh facts under
      // the same lease as allocation and restore, including their partial paths.
      await withAllocationLease(async (guard) => {
        if (hasOrphanCandidates) {
          try {
            orphansDeleted = await reconcileOrphans(
              env,
              getConfig,
              listRegistryWorktrees(env),
              guard,
            );
          } catch (error) {
            progress.error("orphans", error);
            log.warn(`worktree orphan cleanup deferred: ${String(error)}`);
          }
        }
        for (const record of expired) {
          try {
            const current = getRegistryWorktree(env, record.id);
            if (!current || current.removedAt === undefined || current.removedAt >= expiresBefore) {
              continue;
            }
            await retireManagedWorktreeSnapshot({
              workerAuthority: guard.workerAuthority,
              record: current,
              env,
              signal: guard.signal,
              assertCurrent: () => guard.commitGuard?.(),
            });
            snapshotsPruned += 1;
          } catch (error) {
            progress.error("snapshots", error, record.id);
            log.warn(`snapshot retention failed for ${record.id}: ${String(error)}`);
          }
        }
      });
    } catch (error) {
      progress.error("orphans", error);
      log.warn(`worktree cleanup deferred: ${String(error)}`);
    }
  }
  return { orphansDeleted, snapshotsPruned };
}

async function reconcileOrphans(
  env: NodeJS.ProcessEnv,
  getConfig: (() => OpenClawConfig) | undefined,
  records: ManagedWorktreeRecord[],
  guard: WorktreeAllocationGuard,
): Promise<number> {
  const managedPaths = await resolveManagedWorktreePathKeys(records);
  if (!managedPaths) {
    return 0;
  }
  // Only the default state-owned area grants orphan cleanup authority. A custom
  // root can contain unrelated directories; its cleanup is registry-bound above.
  const worktreesRoot = path.join(resolveStateDir(env), "worktrees");
  const fingerprints = await fs.readdir(worktreesRoot, { withFileTypes: true }).catch(() => []);
  if (fingerprints.length === 0) {
    return 0;
  }
  const defaultRoot = await canonicalPathKey(worktreesRoot);
  const customRoots = new Set<string>();
  // Retain roots from recorded paths after configuration changes. Canonical
  // overlap protects nested roots and symlink aliases before recursive deletion.
  for (const root of [
    getConfig?.().worktreeRoot,
    ...records.map((record) => path.dirname(path.dirname(record.path))),
  ]) {
    if (!root) {
      continue;
    }
    try {
      const canonical = await canonicalPathKey(root);
      if (canonical !== defaultRoot) {
        customRoots.add(canonical);
      }
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
  }
  let deleted = 0;
  for (const fingerprint of fingerprints) {
    if (!fingerprint.isDirectory() || fingerprint.name === WORKTREE_TEMPLATE_DIRECTORY) {
      continue;
    }
    const fingerprintPath = path.join(worktreesRoot, fingerprint.name);
    // A root entry can be a checkout, not a fingerprint container; descending
    // before applying the same preservation rule would expose its contents to deletion.
    if (await shouldPreserveOrphanCandidate(fingerprintPath, managedPaths, customRoots)) {
      continue;
    }
    const names = await fs.readdir(fingerprintPath, { withFileTypes: true }).catch(() => []);
    for (const name of names) {
      if (!name.isDirectory()) {
        continue;
      }
      const candidate = path.join(fingerprintPath, name.name);
      if (await shouldPreserveOrphanCandidate(candidate, managedPaths, customRoots)) {
        continue;
      }
      guard.commitGuard?.();
      await fs.rm(candidate, { recursive: true, force: true });
      deleted += 1;
    }
    guard.commitGuard?.();
    await fs.rmdir(fingerprintPath).catch(() => undefined);
  }
  return deleted;
}
