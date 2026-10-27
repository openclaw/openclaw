import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { materializeErrorStack } from "../../infra/error-graph-internal.js";
import { isMissingPathError } from "../../infra/errors.js";
import { isPathInside } from "../../infra/path-guards.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { WorktreeAllocationGuard } from "./allocation.js";
import type { WorktreeGcProgress } from "./gc-progress.js";
import {
  canonicalPathKey,
  resolveManagedWorktreePathKeys,
  shouldPreserveOrphanCandidate,
} from "./orphan-paths.js";
import { readPendingWorktrees } from "./pending-slots.js";
import { readRegistryWorktrees } from "./registry-read.js";
import { isWorktreePermissionError } from "./removal-errors.js";
import { captureWorktreeRunEndContext } from "./run-end-lifecycle.js";
import { retireExpiredManagedWorktreeSnapshot } from "./snapshot-host.js";
import { WORKTREE_TEMPLATE_DIRECTORY } from "./template-cache.js";
import type { ManagedWorktreeRecord } from "./types.js";

const log = createSubsystemLogger("agents/worktrees");

export async function collectRetiredWorktreeArtifacts({
  env,
  getConfig,
  records,
  expiresBefore,
  progress,
  orphanFailures,
  withAllocationLease,
}: {
  env: NodeJS.ProcessEnv;
  getConfig?: () => OpenClawConfig;
  records: readonly ManagedWorktreeRecord[];
  expiresBefore: number;
  progress: WorktreeGcProgress;
  orphanFailures: Map<string, { dev: number; ino: number; error: unknown }>;
  withAllocationLease: (run: (guard: WorktreeAllocationGuard) => Promise<void>) => Promise<void>;
}): Promise<{ orphansDeleted: number; snapshotsPruned: number }> {
  const context = captureWorktreeRunEndContext(env);
  let orphansDeleted = 0;
  let snapshotsPruned = 0;
  const pending = await readPendingWorktrees(context.environment);
  const expired = records.filter(
    (record) => record.removedAt !== undefined && record.removedAt < expiresBefore,
  );
  const entries = await fs
    .readdir(path.join(resolveStateDir(context.environment), "worktrees"), {
      withFileTypes: true,
    })
    .catch((error: unknown) => {
      if (isMissingPathError(error)) {
        return [];
      }
      progress.error("orphans", error);
      return undefined;
    });
  const hasOrphanCandidates =
    entries?.some((entry) => entry.isDirectory() && entry.name !== WORKTREE_TEMPLATE_DIRECTORY) ??
    false;
  if (entries && !hasOrphanCandidates) {
    orphanFailures.clear();
  }
  if (hasOrphanCandidates || expired.length > 0 || pending.length > 0) {
    try {
      await withAllocationLease(async (guard) => {
        const slots = await readPendingWorktrees(context.environment);
        for (const { record, state } of slots) {
          if (state !== "recovering") {
            continue;
          }
          progress.result.retiredCheckoutPaths.push(record.path);
          progress.error(
            "orphans",
            new Error(
              `Interrupted worktree creation retained at ${record.path}; inspect its Git registration and native processes before manual recovery`,
            ),
            record.id,
          );
        }
        if (hasOrphanCandidates) {
          try {
            const pendingRecords = slots.map(({ record }) => record);
            const currentRecords = await readRegistryWorktrees(context.environment, {}, context);
            context.admission.assertCurrent();
            guard.signal?.throwIfAborted();
            guard.commitGuard?.();
            orphansDeleted = await reconcileOrphans(
              context.environment,
              getConfig,
              [...pendingRecords, ...currentRecords],
              pendingRecords.map((record) => record.path),
              guard,
              progress,
              orphanFailures,
            );
          } catch (error) {
            progress.error("orphans", error);
            log.warn(`worktree orphan cleanup deferred: ${String(error)}`);
          }
        }
        for (const record of expired) {
          try {
            if (
              await retireExpiredManagedWorktreeSnapshot({
                env,
                id: record.id,
                expiresBefore,
                guard,
              })
            ) {
              snapshotsPruned += 1;
            }
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

async function restoreOrphanDirectoryWriteAccess(
  root: string,
  assertCurrent: () => void,
): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) {
    return;
  }
  const visit = async (directory: string): Promise<void> => {
    const stat = await fs.lstat(directory);
    // Never chmod files: pnpm may hardlink them to its shared store.
    if (!stat.isDirectory() || stat.uid !== uid) {
      return;
    }
    const canonical = await fs.realpath(directory);
    if (!isPathInside(root, canonical)) {
      throw new Error(`Orphan directory escaped removal root: ${directory}`);
    }
    if ((stat.mode & 0o200) === 0) {
      // Pin the directory itself so a replaced leaf cannot chmod a symlink target.
      const handle = await fs.open(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        const current = await handle.stat();
        if (current.uid !== uid || current.dev !== stat.dev || current.ino !== stat.ino) {
          throw new Error(`Orphan directory changed during permission repair: ${directory}`);
        }
        assertCurrent();
        await handle.chmod(current.mode | 0o200);
      } finally {
        await handle.close();
      }
    }
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        await visit(path.join(directory, entry.name));
      }
    }
  };
  await visit(root);
}

async function reconcileOrphans(
  env: NodeJS.ProcessEnv,
  getConfig: (() => OpenClawConfig) | undefined,
  records: ManagedWorktreeRecord[],
  pendingPaths: readonly string[],
  guard: WorktreeAllocationGuard,
  progress: WorktreeGcProgress,
  orphanFailures: Map<string, { dev: number; ino: number; error: unknown }>,
): Promise<number> {
  const managedPaths = await resolveManagedWorktreePathKeys(records);
  if (!managedPaths) {
    return 0;
  }
  // Cloning briefly removes its destination; the reserved canonical path still owns its parent.
  for (const pendingPath of pendingPaths) {
    managedPaths.add(process.platform === "win32" ? pendingPath.toLowerCase() : pendingPath);
  }
  // Only the default state-owned area grants orphan cleanup authority. A custom
  // root can contain unrelated directories; its cleanup is registry-bound above.
  const worktreesRoot = path.join(resolveStateDir(env), "worktrees");
  const fingerprints = await fs.readdir(worktreesRoot, { withFileTypes: true });
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
  const candidates = new Set<string>();
  const assertCurrent = () => {
    guard.signal?.throwIfAborted();
    guard.commitGuard?.();
  };
  for (const fingerprint of fingerprints) {
    if (!fingerprint.isDirectory() || fingerprint.name === WORKTREE_TEMPLATE_DIRECTORY) {
      continue;
    }
    const fingerprintPath = path.join(defaultRoot, fingerprint.name);
    // A root entry can be a checkout, not a fingerprint container; descending
    // before applying the same preservation rule would expose its contents to deletion.
    if (await shouldPreserveOrphanCandidate(fingerprintPath, managedPaths, customRoots)) {
      continue;
    }
    const names = await fs
      .readdir(fingerprintPath, { withFileTypes: true })
      .catch((error: unknown) => {
        if (isMissingPathError(error)) {
          return [];
        }
        progress.error("orphans", error, fingerprintPath);
        return undefined;
      });
    if (!names) {
      // Failed enumeration does not prove that remembered orphans disappeared.
      for (const candidate of orphanFailures.keys()) {
        if (isPathInside(fingerprintPath, candidate)) {
          candidates.add(candidate);
        }
      }
      continue;
    }
    for (const name of names) {
      if (!name.isDirectory()) {
        continue;
      }
      const candidate = path.join(fingerprintPath, name.name);
      if (await shouldPreserveOrphanCandidate(candidate, managedPaths, customRoots)) {
        continue;
      }
      candidates.add(candidate);
      const source = await fs.lstat(candidate);
      const previous = orphanFailures.get(candidate);
      if (previous) {
        if (source.dev === previous.dev && source.ino === previous.ino) {
          progress.error("orphans", previous.error, candidate);
          continue;
        }
        orphanFailures.delete(candidate);
      }
      try {
        assertCurrent();
        try {
          await fs.rm(candidate, { recursive: true, force: true });
        } catch (error) {
          if (!isWorktreePermissionError(error)) {
            throw error;
          }
          const current = await fs.lstat(candidate);
          if (!current.isDirectory() || current.dev !== source.dev || current.ino !== source.ino) {
            throw new Error(`Orphan removal root changed during cleanup: ${candidate}`, {
              cause: error,
            });
          }
          await restoreOrphanDirectoryWriteAccess(candidate, assertCurrent);
          assertCurrent();
          // One repair and one retry; an unrepaired orphan must not block its siblings.
          await fs.rm(candidate, { recursive: true, force: true });
        }
        orphanFailures.delete(candidate);
        deleted += 1;
      } catch (error) {
        assertCurrent();
        const stat = await fs.lstat(candidate).catch(() => undefined);
        if (stat?.dev === source.dev && stat.ino === source.ino) {
          materializeErrorStack(error);
          orphanFailures.set(candidate, { dev: stat.dev, ino: stat.ino, error });
        }
        progress.error("orphans", error, candidate);
        log.warn(
          `worktree orphan cleanup deferred for ${candidate}; repair access and run openclaw worktrees gc --retry-deferred: ${String(error)}`,
        );
      }
    }
    if (!pendingPaths.some((pendingPath) => isPathInside(fingerprintPath, pendingPath))) {
      guard.commitGuard?.();
      await fs.rmdir(fingerprintPath).catch(() => undefined);
    }
  }
  for (const candidate of orphanFailures.keys()) {
    if (!candidates.has(candidate)) {
      orphanFailures.delete(candidate);
    }
  }
  return deleted;
}
