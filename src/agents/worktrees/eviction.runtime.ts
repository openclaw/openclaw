import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { safeRealpathSync } from "@openclaw/fs-safe/path";
import {
  readGitMetadataDirectories,
  readGitObjectStorageDependencies,
  readGitWorktreeAdministrations,
  type GitObjectStorageDependencies,
  type GitWorktreeAdministration,
} from "../../infra/git-root.js";
import { requestGitWorkerEffect } from "../../infra/git-worker-context.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { indexWorktreePaths } from "./gc-dependencies.js";
import type {
  GitWorktreeOperations,
  WorktreeEvictionCandidate,
  WorktreeEvictionReason,
} from "./git-worktree-operations.js";
import { commandError, listGitWorktrees, requireGit, requireGitBuffer, runGit } from "./git.js";

// Both object IDs are immutable; new branch/default commits invalidate their entry.
const classifications = new Map<string, WorktreeEvictionReason>();
const defaultPatches = new Map<string, Set<string>>();
function gitOptions(root: string, storage = readGitMetadataDirectories(root)) {
  if (!storage) {
    throw new Error(`Git metadata is unavailable for ${root}`);
  }
  return {
    // Native commands and filesystem inspection must target the same recorded repository.
    env: {
      GIT_DIR: storage.gitDir,
      GIT_COMMON_DIR: storage.commonDir,
      GIT_WORK_TREE: undefined,
      GIT_OBJECT_DIRECTORY: path.join(storage.commonDir, "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_NO_LAZY_FETCH: "1",
    },
    maxOutputBytes: 64 * 1024 * 1024,
    terminateOnOutputLimit: true,
  };
}

function dependencyInspectionBudget() {
  const started = performance.now();
  return () => {
    if (performance.now() - started >= 5_000) {
      throw new Error("Worktree dependency inspection exceeded its 5-second budget; retry cleanup");
    }
  };
}

function checkoutKey(checkout: string) {
  const resolved = safeRealpathSync(checkout) ?? path.resolve(checkout);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function administrationInventory(commonDir: string, assertBudget: () => void) {
  const inventory = readGitWorktreeAdministrations(commonDir, assertBudget);
  const byCheckout = new Map<string, GitWorktreeAdministration[]>();
  for (const entry of inventory.entries) {
    assertBudget();
    const key = checkoutKey(entry.checkoutPath);
    const entries = byCheckout.get(key) ?? [];
    entries.push(entry);
    byCheckout.set(key, entries);
  }
  return { ...inventory, byCheckout };
}

export function readWorktreeSourceDependencies(
  input: GitWorktreeOperations["worktree.eviction-source"]["input"],
): GitWorktreeOperations["worktree.eviction-source"]["output"] {
  const assertBudget = dependencyInspectionBudget();
  const sourceStorage = readGitMetadataDirectories(input.sourceRoot, assertBudget);
  let complete = sourceStorage !== undefined;
  const requiredPaths = new Set([
    ...input.requiredPaths,
    input.sourceRoot,
    checkoutKey(input.sourceRoot),
    input.commonDir,
    ...(sourceStorage?.paths ?? []),
  ]);
  for (const commonDir of new Set([input.commonDir, sourceStorage?.commonDir])) {
    if (!commonDir) {
      continue;
    }
    const objects = readGitObjectStorageDependencies(commonDir, assertBudget);
    complete &&= objects.complete;
    for (const dependency of objects.paths) {
      requiredPaths.add(dependency);
    }
  }
  const repositories = new Map<string, ReturnType<typeof readGitMetadataDirectories>>();
  const inventories = new Map<string, ReturnType<typeof administrationInventory>>();
  const ownedPaths: Array<{ id: string; path: string }> = [];
  for (const record of input.records) {
    assertBudget();
    ownedPaths.push(record, { id: record.id, path: checkoutKey(record.path) });
    if (!repositories.has(record.repoRoot)) {
      repositories.set(record.repoRoot, readGitMetadataDirectories(record.repoRoot, assertBudget));
    }
    const storage = repositories.get(record.repoRoot);
    if (storage && !inventories.has(storage.commonDir)) {
      inventories.set(storage.commonDir, administrationInventory(storage.commonDir, assertBudget));
    }
    // Unknown victim metadata cannot authorize native removal; purge rechecks that boundary.
    const administrations = storage ? inventories.get(storage.commonDir) : undefined;
    for (const entry of administrations?.byCheckout.get(checkoutKey(record.path)) ?? []) {
      ownedPaths.push(
        { id: record.id, path: entry.adminPath },
        { id: record.id, path: entry.physicalAdminPath },
      );
    }
  }
  const ancestors = indexWorktreePaths(ownedPaths);
  const worktreeIds = new Set<string>();
  for (const required of requiredPaths) {
    assertBudget();
    for (const id of ancestors(required)) {
      worktreeIds.add(id);
    }
  }
  return { worktreeIds: [...worktreeIds], complete };
}

export async function prepareWorktreeEvictionRepositories(
  repoRoots: string[],
): Promise<GitWorktreeOperations["worktree.eviction-repositories"]["output"]> {
  const repositories: GitWorktreeOperations["worktree.eviction-repositories"]["output"] = [];
  for (const repoRoot of repoRoots) {
    const repository: (typeof repositories)[number] = {
      repoRoot,
      commonDir: readGitMetadataDirectories(repoRoot)?.commonDir,
      heads: {},
    };
    try {
      repository.defaultHead = await defaultBranchHead(repoRoot);
      if (repository.defaultHead) {
        // Native inventory resolves symbolic and reftable HEADs once per repository.
        for (const checkout of await listGitWorktrees(repoRoot, gitOptions(repoRoot))) {
          if (checkout.head && !/^0+$/u.test(checkout.head)) {
            repository.heads[path.resolve(checkout.path)] = checkout.head;
          }
        }
      }
    } catch {
      await requestGitWorkerEffect({ type: "worktree.assert-current", input: {} });
    }
    repositories.push(repository);
  }
  return repositories;
}

async function defaultBranchHead(repoRoot: string): Promise<string | undefined> {
  const remoteHead = await runGit(
    repoRoot,
    ["rev-parse", "--verify", "refs/remotes/origin/HEAD^{commit}"],
    gitOptions(repoRoot),
  );
  if (remoteHead.code === 0) {
    return remoteHead.stdout.trim();
  }
  const remote = await runGit(
    repoRoot,
    ["config", "--get", "remote.origin.url"],
    gitOptions(repoRoot),
  );
  // An unavailable remote default cannot turn an arbitrary local branch into
  // proof of landing. Local-only repositories use their primary checkout HEAD.
  return remote.code === 1
    ? await requireGit(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"], gitOptions(repoRoot))
    : undefined;
}

async function patchIds(repoRoot: string, patch: Buffer): Promise<Set<string>> {
  const ids = await requireGit(repoRoot, ["patch-id", "--stable"], {
    ...gitOptions(repoRoot),
    input: patch,
  });
  return new Set(
    ids
      .split("\n")
      .map((line) => line.split(" ")[0]!)
      .filter(Boolean),
  );
}

async function classifyBranch(
  repoRoot: string,
  head: string,
  upstream: string,
): Promise<WorktreeEvictionReason> {
  const cacheKey = `${repoRoot}:${head}:${upstream}`;
  const cached = classifications.get(cacheKey);
  if (cached) {
    return cached;
  }
  const ancestor = await runGit(
    repoRoot,
    ["merge-base", "--is-ancestor", head, upstream],
    gitOptions(repoRoot),
  );
  let reason: WorktreeEvictionReason = "idle-age";
  if (ancestor.code === 0) {
    reason = "merged";
  } else if (ancestor.code === 1) {
    const base = await requireGit(repoRoot, ["merge-base", head, upstream], gitOptions(repoRoot));
    const cherry = await requireGit(repoRoot, ["cherry", upstream, head], gitOptions(repoRoot));
    if (cherry.trim() && !cherry.split("\n").some((line) => line.startsWith("+"))) {
      reason = "squashed";
    } else {
      // git cherry compares individual commits; a multi-commit squash needs the
      // complete branch delta compared with each landed default-branch patch.
      const branchIds = await patchIds(
        repoRoot,
        await requireGitBuffer(
          repoRoot,
          ["diff", "--binary", "--no-ext-diff", "--no-textconv", base, head],
          gitOptions(repoRoot),
        ),
      );
      const historyKey = `${repoRoot}:${base}:${upstream}`;
      let landedIds = defaultPatches.get(historyKey);
      if (!landedIds) {
        landedIds = await patchIds(
          repoRoot,
          await requireGitBuffer(
            repoRoot,
            [
              "log",
              "--no-merges",
              "--format=medium",
              "--binary",
              "--no-ext-diff",
              "--no-textconv",
              "-p",
              `${base}..${upstream}`,
            ],
            gitOptions(repoRoot),
          ),
        );
        defaultPatches.set(historyKey, landedIds);
        pruneMapToMaxSize(defaultPatches, 64);
      }
      if (branchIds.size > 0 && [...branchIds].every((id) => landedIds.has(id))) {
        reason = "squashed";
      }
    }
  } else {
    throw commandError("git merge-base --is-ancestor", ancestor);
  }
  classifications.set(cacheKey, reason);
  pruneMapToMaxSize(classifications, 8192);
  return reason;
}

export async function classifyWorktreeEvictions(
  records: GitWorktreeOperations["worktree.eviction-classify"]["input"]["records"],
): Promise<WorktreeEvictionCandidate[]> {
  const candidates: WorktreeEvictionCandidate[] = [];
  for (const record of records) {
    let reason: WorktreeEvictionReason = "idle-age";
    try {
      const { head, defaultHead: upstream } = record;
      if (head && upstream) {
        reason = await classifyBranch(record.repoRoot, head, upstream);
        if (reason === "idle-age" && record.mergedHeads?.some((landed) => landed.sha === head)) {
          const remote = await runGit(
            record.repoRoot,
            ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${record.branch}`],
            gitOptions(record.repoRoot),
          );
          if (remote.code === 1) {
            for (const landed of record.mergedHeads) {
              if (landed.sha !== head || !landed.mergeCommitSha) {
                continue;
              }
              const merged = await runGit(
                record.repoRoot,
                ["merge-base", "--is-ancestor", landed.mergeCommitSha, upstream],
                gitOptions(record.repoRoot),
              );
              if (merged.code === 0) {
                reason = "squashed";
                break;
              }
            }
          }
        }
      }
    } catch {
      // Unreadable, moved and missing Git state still participate in age eviction.
      // A cancelled host refuses this effect instead of silently losing authority.
      await requestGitWorkerEffect({ type: "worktree.assert-current", input: {} });
    }
    candidates.push({ id: record.id, reason });
  }
  return candidates;
}

/** The host holds the registry removal claim and joins this write without cancellation. */
export async function purgeWorktreeCheckout(
  record: GitWorktreeOperations["worktree.eviction-purge"]["input"]["record"],
  live: GitWorktreeOperations["worktree.eviction-purge"]["input"]["live"],
): Promise<void> {
  const checkout = path.resolve(record.path);
  const source = path.resolve(record.repoRoot);
  const stat = fsSync.lstatSync(checkout, { bigint: true, throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) {
    throw new Error(
      "Managed worktree checkout is not a directory; repair its path before eviction",
    );
  }
  const physicalCheckout = stat ? fsSync.realpathSync.native(checkout) : checkout;
  const sourceStorage = readGitMetadataDirectories(source);
  const registrations = sourceStorage
    ? await listGitWorktrees(source, gitOptions(source, sourceStorage)).catch(() => [])
    : [];
  const primary = registrations[0]?.path;
  const assertBudget = dependencyInspectionBudget();
  let deletionStorage = readGitMetadataDirectories(source, assertBudget);
  const readAdministration = (storage: typeof deletionStorage) => {
    if (!storage) {
      return undefined;
    }
    const inventory = administrationInventory(storage.commonDir, assertBudget);
    const matches = inventory.byCheckout.get(checkoutKey(checkout)) ?? [];
    if (!inventory.complete || matches.length > 1) {
      throw new Error("Managed worktree administration is unavailable or ambiguous; retry cleanup");
    }
    return matches[0];
  };
  const administration = readAdministration(deletionStorage);
  const registered = administration !== undefined;
  const targets = [{ path: checkout, physicalPath: physicalCheckout, stat, physicalStat: stat }];
  if (administration) {
    const adminStat = fsSync.lstatSync(administration.adminPath, { bigint: true });
    targets.push({
      path: administration.adminPath,
      physicalPath: administration.physicalAdminPath,
      stat: adminStat,
      physicalStat: fsSync.statSync(administration.adminPath, { bigint: true }),
    });
  }
  const assertTargetsCurrent = () => {
    for (const target of targets) {
      const current = fsSync.lstatSync(target.path, { bigint: true, throwIfNoEntry: false });
      const physical = current ? fsSync.statSync(target.path, { bigint: true }) : undefined;
      if (
        target.stat
          ? !current ||
            current.dev !== target.stat.dev ||
            current.ino !== target.stat.ino ||
            physical?.dev !== target.physicalStat?.dev ||
            physical?.ino !== target.physicalStat?.ino ||
            fsSync.realpathSync.native(target.path) !== target.physicalPath
          : current !== undefined
      ) {
        throw new Error("Managed worktree purge target changed; retry cleanup");
      }
    }
  };
  const others = live.filter((candidate) => candidate.id !== record.id);
  const roots = [...new Set([source, ...others.map((candidate) => candidate.repoRoot)])];
  const contains = (target: string) => {
    return targets.some(({ physicalPath }) => {
      const relative = path.relative(physicalPath, target);
      return (
        relative === "" ||
        (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      );
    });
  };
  const fenced = new Set<string>();
  let admitted = false;
  for (;;) {
    await yieldTurn();
    // A fresh worker census follows every snapshot/fence await; no cached absence
    // authorizes deletion, and a slow volume defers before any destructive action.
    assertTargetsCurrent();
    const objects = new Map<string, GitObjectStorageDependencies>();
    const objectDependencies = (storage: ReturnType<typeof readGitMetadataDirectories>) => {
      if (!storage) {
        return undefined;
      }
      let dependencies = objects.get(storage.commonDir);
      if (!dependencies) {
        dependencies = readGitObjectStorageDependencies(storage.commonDir, assertBudget);
        objects.set(storage.commonDir, dependencies);
      }
      return dependencies;
    };
    const repositories = new Map<
      string,
      {
        physicalRoot: string;
        storage: ReturnType<typeof readGitMetadataDirectories>;
        objects: GitObjectStorageDependencies | undefined;
      }
    >();
    for (const root of roots) {
      const storage = readGitMetadataDirectories(root, assertBudget);
      repositories.set(root, {
        physicalRoot: safeRealpathSync(root) ?? root,
        storage,
        objects: objectDependencies(storage),
      });
      assertBudget();
    }
    const currentSource = repositories.get(source)!;
    const currentAdministration = readAdministration(currentSource.storage);
    if (
      currentAdministration?.adminPath !== administration?.adminPath ||
      currentAdministration?.physicalAdminPath !== administration?.physicalAdminPath
    ) {
      throw new Error("Managed worktree purge administration changed; retry cleanup");
    }
    deletionStorage = currentSource.storage;
    if (contains(currentSource.physicalRoot)) {
      throw new Error("Managed worktree eviction cannot remove the source repository");
    }
    if (
      primary &&
      (path.resolve(primary) === checkout ||
        path.resolve(primary).startsWith(`${checkout}${path.sep}`))
    ) {
      throw new Error("Managed worktree eviction cannot remove the primary repository");
    }
    const checkoutStorage = readGitMetadataDirectories(checkout, assertBudget);
    // A standalone repository replacing the victim is still ordinary purgeable data.
    const checkoutCommonDir =
      checkoutStorage && path.relative(checkoutStorage.gitDir, checkoutStorage.commonDir) !== ""
        ? checkoutStorage.commonDir
        : undefined;
    const checkoutObjects = checkoutCommonDir ? objectDependencies(checkoutStorage) : undefined;
    if (
      [
        ...(currentSource.storage?.paths ?? []),
        checkoutCommonDir,
        ...(currentSource.objects?.paths ?? []),
        ...(checkoutObjects?.paths ?? []),
      ].some((directory) => directory !== undefined && contains(directory))
    ) {
      throw new Error(
        "Managed worktree eviction cannot remove its source Git metadata; relocate the shared Git directory outside the checkout first",
      );
    }
    if (currentSource.objects?.complete === false || checkoutObjects?.complete === false) {
      throw new Error(
        "Managed worktree source Git object dependencies are incomplete; repair its object storage before eviction",
      );
    }
    const unresolved: string[] = [];
    for (const candidate of others) {
      const repository = repositories.get(candidate.repoRoot)!;
      const physicalPath = safeRealpathSync(candidate.path);
      const storage = readGitMetadataDirectories(candidate.path, assertBudget);
      const checkoutDependencies = objectDependencies(storage);
      if (
        [
          candidate.path,
          physicalPath,
          candidate.repoRoot,
          repository.physicalRoot,
          ...(repository.storage?.paths ?? []),
          ...(storage?.paths ?? []),
          ...(repository.objects?.paths ?? []),
          ...(checkoutDependencies?.paths ?? []),
        ].some((target) => target != null && contains(target))
      ) {
        throw new Error(
          `Worktree acquired a live checkout or repository dependency: ${candidate.id}; retry cleanup after that checkout retires`,
        );
      }
      if (
        (!repository.storage ||
          !storage ||
          !repository.objects?.complete ||
          !checkoutDependencies?.complete) &&
        !fenced.has(candidate.id)
      ) {
        unresolved.push(candidate.id);
      }
      assertBudget();
    }
    assertBudget();
    assertTargetsCurrent();
    if (unresolved.length === 0) {
      if (admitted) {
        break;
      }
      await requestGitWorkerEffect({ type: "worktree.eviction-admit", input: {} });
      admitted = true;
      continue;
    }
    await requestGitWorkerEffect({
      type: "worktree.eviction-fence",
      input: { worktreeIds: unresolved },
    });
    for (const id of unresolved) {
      fenced.add(id);
    }
  }
  if (registered) {
    // Two force flags deliberately override stale/foreign Git locks. The registry
    // removal claim, not a branch name or Git lock file, owns run exclusion.
    await requireGit(source, ["worktree", "remove", "--force", "--force", "--", checkout], {
      ...gitOptions(source, deletionStorage),
      killProcessTree: true,
      waitForExit: true,
    });
  } else if (stat) {
    // Git registration may already be missing. Delete only the host's claimed
    // checkout path; never prune shared metadata or delete a possibly moved branch.
    await fs.rm(checkout, { recursive: true, force: true });
  }
}
