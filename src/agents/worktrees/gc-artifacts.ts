import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { materializeErrorStack } from "../../infra/error-graph-internal.js";
import { isMissingPathError } from "../../infra/errors.js";
import { isPathInside } from "../../infra/path-guards.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  withWorktreeAllocationLease,
  withWorktreeMutationLease,
  type WorktreeAllocationGuard,
} from "./allocation.js";
import type { WorktreeGcProgress } from "./gc-progress.js";
import { worktreePathExists } from "./git.js";
import {
  collectOrphanWorktreeBranches,
  hasUnregisteredManagedBranches,
} from "./orphan-branches.js";
import {
  canonicalPathKey,
  resolveManagedWorktreePathKeys,
  shouldPreserveOrphanCandidate,
} from "./orphan-paths.js";
import { readPendingWorktrees } from "./pending-slots.js";
import { captureWorktreeRegistryReadGuard, readRegistryWorktrees } from "./registry-read.js";
import { worktreeGcRevision } from "./registry-read.kernel.js";
import { deleteRetiredCheckout, isRetiredCheckoutDeletionPending } from "./removal-git.js";
import { captureWorktreeRunEndContext } from "./run-end-lifecycle.js";
import { retireExpiredManagedWorktreeSnapshot } from "./snapshot-host.js";
import { WORKTREE_TEMPLATE_DIRECTORY } from "./template-cache.js";
import type { ManagedWorktreeRecord, WorktreeMutationGuard } from "./types.js";

const log = createSubsystemLogger("agents/worktrees");

export type WorktreeOrphanFailures = Map<string, { dev: number; ino: number; error: unknown }>;

async function hasUnregisteredArtifacts(
  root: string,
  entries: readonly Dirent[],
  records: readonly ManagedWorktreeRecord[],
): Promise<boolean> {
  const key = (target: string) => {
    const resolved = path.resolve(target);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const registered = new Set(records.map((record) => key(record.path)));
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === WORKTREE_TEMPLATE_DIRECTORY) {
      continue;
    }
    const directory = path.join(root, entry.name);
    if (registered.has(key(directory))) {
      continue;
    }
    const children = await fs.readdir(directory, { withFileTypes: true }).catch(() => undefined);
    if (
      !children ||
      children.length === 0 ||
      children.some(
        (child) => child.isDirectory() && !registered.has(key(path.join(directory, child.name))),
      )
    ) {
      return true;
    }
  }
  return false;
}

export async function collectRetiredWorktreeArtifacts({
  env,
  getConfig,
  records,
  expiresBefore,
  retryDeferred,
  progress,
  orphanFailures,
  guard: callerGuard,
}: {
  env: NodeJS.ProcessEnv;
  getConfig?: () => OpenClawConfig;
  records: readonly ManagedWorktreeRecord[];
  expiresBefore: number;
  retryDeferred?: boolean;
  progress: WorktreeGcProgress;
  orphanFailures: WorktreeOrphanFailures;
  guard: WorktreeMutationGuard;
}): Promise<{ orphansDeleted: number; snapshotsPruned: number }> {
  const context = captureWorktreeRunEndContext(env);
  let orphansDeleted = 0;
  let snapshotsPruned = 0;
  const pending = await readPendingWorktrees(context.environment);
  const expired = records.filter(
    (record) => record.removedAt !== undefined && record.removedAt < expiresBefore,
  );
  const worktreesRoot = path.join(resolveStateDir(context.environment), "worktrees");
  const entries = await fs
    .readdir(worktreesRoot, {
      withFileTypes: true,
    })
    .catch((error: unknown) => {
      if (isMissingPathError(error)) {
        return [];
      }
      progress.error("orphans", error);
      return undefined;
    });
  let hasOrphanCandidates =
    entries?.some((entry) => entry.isDirectory() && entry.name !== WORKTREE_TEMPLATE_DIRECTORY) ??
    false;
  if (hasOrphanCandidates && entries && expired.length === 0 && pending.length === 0) {
    // Exact registered paths can only suppress a sweep. Unknown paths still get
    // the fresh registry and canonical safety checks under allocation custody.
    hasOrphanCandidates = await hasUnregisteredArtifacts(worktreesRoot, entries, records);
  }
  if (entries && !hasOrphanCandidates) {
    orphanFailures.clear();
  }
  const branchOwners = [...records, ...pending.map(({ record }) => record)];
  const repositories = new Set<string>();
  for (const repoRoot of new Set(branchOwners.map((record) => record.repoRoot))) {
    try {
      if (!(await worktreePathExists(repoRoot))) {
        continue;
      }
      if (
        await hasUnregisteredManagedBranches(
          repoRoot,
          branchOwners,
          context.admission.assertCurrent,
        )
      ) {
        repositories.add(repoRoot);
      }
    } catch (error) {
      context.admission.assertCurrent();
      progress.error("orphans", error, repoRoot);
    }
  }
  if (hasOrphanCandidates || expired.length > 0 || pending.length > 0 || repositories.size > 0) {
    try {
      await withWorktreeMutationLease({ ...callerGuard, env, id: "artifacts" }, async (guard) => {
        const slots = pending.length
          ? await withWorktreeAllocationLease({ ...guard, env }, () =>
              readPendingWorktrees(context.environment),
            )
          : [];
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
        for (const repoRoot of repositories) {
          try {
            const cleanup = await collectOrphanWorktreeBranches({ env, repoRoot, ...guard });
            const deleted = cleanup.branches.filter(
              (branch) => branch.outcome === "deleted",
            ).length;
            if (deleted > 0) {
              log.info(`Removed ${deleted} orphaned managed branches in ${repoRoot}.`);
            }
            for (const branch of cleanup.branches) {
              if (branch.outcome === "failed") {
                progress.error("orphans", branch.reason, branch.branch);
              }
            }
          } catch (error) {
            guard.commitGuard();
            progress.error("orphans", error, repoRoot);
          }
        }
        for (const record of expired) {
          try {
            const outcome = await retireExpiredManagedWorktreeSnapshot({
              env,
              id: record.id,
              expiresBefore,
              retryDeferred,
              guard,
            });
            if (typeof outcome === "string") {
              progress.result.retiredCheckoutPaths.push(record.path);
              progress.record("snapshots", "deferred", outcome, record.id);
              if (record.gcProtection !== outcome) {
                log.warn(
                  `snapshot retention deferred for ${record.id}: ${outcome}; inspect ${record.path}, then run openclaw worktrees gc --retry-deferred`,
                );
              }
            } else if (outcome) {
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

async function reconcileOrphans(
  env: NodeJS.ProcessEnv,
  getConfig: (() => OpenClawConfig) | undefined,
  records: ManagedWorktreeRecord[],
  pendingPaths: readonly string[],
  guard: WorktreeAllocationGuard,
  progress: WorktreeGcProgress,
  orphanFailures: WorktreeOrphanFailures,
): Promise<number> {
  const observed = new Map(records.map((record) => [record.id, worktreeGcRevision(record)]));
  const configuredRoot = getConfig?.().worktreeRoot;
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
    if (
      isRetiredCheckoutDeletionPending(fingerprintPath) ||
      (await shouldPreserveOrphanCandidate(fingerprintPath, managedPaths, customRoots))
    ) {
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
      let candidate = path.join(fingerprintPath, name.name);
      if (
        isRetiredCheckoutDeletionPending(candidate) ||
        (await shouldPreserveOrphanCandidate(candidate, managedPaths, customRoots))
      ) {
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
      let removalAttempted = false;
      try {
        const original = candidate;
        candidate = await withWorktreeAllocationLease({ ...guard, env }, async (allocation) => {
          const context = captureWorktreeRunEndContext(env);
          const accept = captureWorktreeRegistryReadGuard(context, "record");
          const slots = await readPendingWorktrees(env);
          const current = [
            ...slots.map(({ record }) => record),
            ...(await readRegistryWorktrees(env)),
          ];
          const assertRegistryCurrent = accept(undefined);
          if (
            getConfig?.().worktreeRoot !== configuredRoot ||
            current.length !== observed.size ||
            current.some((record) => observed.get(record.id) !== worktreeGcRevision(record))
          ) {
            throw new Error(
              "Worktree inventory changed during orphan planning; directory preserved",
            );
          }
          const stat = await fs.lstat(original);
          if (!stat.isDirectory() || stat.dev !== source.dev || stat.ino !== source.ino) {
            throw new Error("Orphan removal root changed during planning; directory preserved");
          }
          allocation.commitGuard();
          assertRegistryCurrent();
          // The atomic namespace change commits retirement. Recursive deletion owns only this
          // unselectable sibling after allocation is released; a crash leaves it for the next GC.
          const retired = path.join(fingerprintPath, `.openclaw-retired-${randomUUID()}`);
          removalAttempted = true;
          await fs.rename(original, retired);
          return retired;
        });
        candidates.add(candidate);
        assertCurrent();
        await deleteRetiredCheckout(candidate);
        orphanFailures.delete(candidate);
        deleted += 1;
      } catch (error) {
        assertCurrent();
        progress.error("orphans", error, candidate);
        if (!removalAttempted) {
          continue;
        }
        const stat = await fs.lstat(candidate).catch(() => undefined);
        if (stat?.dev === source.dev && stat.ino === source.ino) {
          materializeErrorStack(error);
          orphanFailures.set(candidate, { dev: stat.dev, ino: stat.ino, error });
        }
        log.warn(
          `worktree orphan cleanup deferred for ${candidate}; repair access and run openclaw worktrees gc --retry-deferred: ${String(error)}`,
        );
      }
    }
    if (!pendingPaths.some((pendingPath) => isPathInside(fingerprintPath, pendingPath))) {
      guard.commitGuard?.();
      // Leave the empty namespace container: a creator may already have reserved a child.
    }
  }
  for (const candidate of orphanFailures.keys()) {
    if (!candidates.has(candidate)) {
      orphanFailures.delete(candidate);
    }
  }
  return deleted;
}
