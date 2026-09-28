import { createHash, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { isMissingPathError } from "../../infra/errors.js";
import { normalizeGitPathForFilesystem } from "../../infra/git-exec.js";
import { runOutsideCommandProcessScope } from "../../process/exec-spawn.js";
import type { WorktreeGitPolicy } from "./checkout-git-config.js";
import { commandError, listGitWorktrees, requireGit, runGit } from "./git.js";
import { canonicalPathKey } from "./orphan-paths.js";
import { WorktreeBranchMovedError } from "./removal-errors.js";
import type { ExactStateRetirement } from "./snapshot-exact-state-contract.js";
import type { ExactStateSnapshot } from "./snapshot-exact-state.js";
import type { ManagedWorktreeRecord } from "./types.js";

type GitOptions = Parameters<typeof runGit>[2];

function missingPathOrThrow(error: unknown): undefined {
  if (!isMissingPathError(error)) {
    throw error;
  }
  return undefined;
}

export async function requireManagedWorktreeHead(
  record: ManagedWorktreeRecord,
  options: GitOptions,
): Promise<string> {
  const branch = await runGit(record.path, ["symbolic-ref", "--quiet", "HEAD"], options);
  if (branch.code !== 0 && branch.code !== 1) {
    throw commandError("git symbolic-ref --quiet HEAD", branch);
  }
  if (branch.code !== 0 || branch.stdout.trim() !== `refs/heads/${record.branch}`) {
    throw new WorktreeBranchMovedError(
      `Worktree HEAD no longer owns ${record.branch}; checkout and branch preserved.`,
    );
  }
  return await requireGit(record.path, ["rev-parse", "--verify", "HEAD^{commit}"], options);
}

/** Keep native branch deletion's ancestry and checked-out-elsewhere checks. */
export async function prepareSnapshotBranchDeletion(
  record: ManagedWorktreeRecord,
  snapshotRef: string,
  snapshot: string,
  options: GitOptions,
): Promise<GitOptions> {
  const merges = await runGit(
    record.repoRoot,
    ["config", "--get-all", `branch.${record.branch}.merge`],
    options,
  );
  if (merges.code !== 0 && merges.code !== 1) {
    throw commandError("git config --get-all", merges);
  }
  const source = merges.code === 0 ? merges.stdout.split("\n")[0]! : snapshotRef;
  await requireGit(record.repoRoot, ["check-ref-format", source], options);
  const remote = `openclaw-removal-${randomUUID()}`;
  // branch.merge is multi-valued; appending an upstream cannot replace it.
  // A command-local fetch mapping resolves its first value to our snapshot.
  // No fetch or config write occurs, and args[0] stays "branch" for ref admission.
  const config = [
    `branch.${record.branch}.remote=${remote}`,
    `remote.${remote}.fetch=+${source}:${snapshotRef}`,
    ...(merges.code === 1 ? [`branch.${record.branch}.merge=${source}`] : []),
  ];
  const deletionOptions = {
    ...options,
    env: {
      ...options?.env,
      // Replace inherited parameters: they must not undo hooks/fsmonitor policy.
      GIT_CONFIG_PARAMETERS: config.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" "),
    },
  };
  const upstream = await requireGit(
    record.repoRoot,
    ["rev-parse", "--verify", `${record.branch}@{upstream}^{commit}`],
    deletionOptions,
  );
  if (upstream !== snapshot) {
    throw new Error(`Cannot bind branch cleanup to ${snapshotRef}; checkout preserved.`);
  }
  return deletionOptions;
}

/** Once destructive deletion starts, its allocation owner joins it without a deadline. */
export async function removeManagedCheckout(
  record: ManagedWorktreeRecord,
  git: WorktreeGitPolicy,
  requireLossless: boolean | undefined,
  assertCurrent?: () => void,
): Promise<void> {
  const removed = await runOutsideCommandProcessScope(() =>
    git.run(
      record.repoRoot,
      ["worktree", "remove", ...(requireLossless ? [] : ["--force"]), "--", record.path],
      { beforeRun: assertCurrent, killProcessTree: true, waitForExit: true },
    ),
  );
  if (removed.code !== 0) {
    throw commandError("git worktree remove", removed);
  }
}

/** Explicit detached retirement never grants ownership of another symbolic branch. */
export async function requireExactManagedWorktreeHead(
  record: ManagedWorktreeRecord,
  expected: ExactStateRetirement,
  options: GitOptions,
): Promise<string> {
  assertExactStateOwner(record, expected);
  const symbolic = await runGit(record.path, ["symbolic-ref", "--quiet", "HEAD"], options);
  if (symbolic.code !== 1) {
    throw new Error("Exact-state retirement requires detached HEAD; checkout preserved");
  }
  const head = await requireGit(record.path, ["rev-parse", "--verify", "HEAD^{commit}"], options);
  const branchHead = await requireGit(
    record.repoRoot,
    ["rev-parse", "--verify", `refs/heads/${record.branch}^{commit}`],
    options,
  );
  if (head !== expected.head || branchHead !== expected.branchHead) {
    throw new Error("Worktree HEAD or recorded branch changed; checkout preserved");
  }
  return head;
}

export function assertExactStateOwner(
  record: ManagedWorktreeRecord,
  expected: ExactStateRetirement,
): void {
  if (
    record.removedAt !== undefined ||
    record.ownerKind !== expected.ownerKind ||
    record.ownerId !== expected.ownerId ||
    record.createdAt !== expected.createdAt ||
    record.lastActiveAt !== expected.lastActiveAt
  ) {
    throw new Error("Worktree exact-state owner or lifecycle changed; checkout preserved");
  }
}

/** Hold Git's own file-ref/index exclusion points through verification and deletion. */
export async function withExactStateGitLocks<T>(
  record: ManagedWorktreeRecord,
  assertCurrent: () => void,
  run: () => Promise<T>,
  additionalRefs: readonly string[] = [],
): Promise<T> {
  const options = { beforeRun: assertCurrent, killProcessTree: true };
  const storage = await runGit(
    record.repoRoot,
    ["config", "--get", "extensions.refStorage"],
    options,
  );
  if (storage.code !== 1 && (storage.code !== 0 || storage.stdout.trim() !== "files")) {
    throw new Error("Exact-state retirement requires Git file refs; source preserved");
  }
  const held: { path: string; handle: FileHandle; dev: number; ino: number }[] = [];
  try {
    for (const name of ["index", "HEAD", `refs/heads/${record.branch}`, ...additionalRefs]) {
      const target =
        path.resolve(
          record.path,
          normalizeGitPathForFilesystem(
            await requireGit(record.path, ["rev-parse", "--git-path", name], options),
          ),
        ) + ".lock";
      // Packed branches can have no loose-ref parent yet. Git still locks this
      // exact loose-ref path before updating or deleting a packed branch.
      assertCurrent();
      await fs.mkdir(path.dirname(target), { recursive: true });
      assertCurrent();
      const handle = await fs.open(target, "wx", 0o600);
      const stat = await handle.stat();
      held.push({ path: target, handle, dev: stat.dev, ino: stat.ino });
    }
    assertCurrent();
    return await run();
  } finally {
    for (const lock of held.toReversed()) {
      await lock.handle.close();
      const current = await fs.lstat(lock.path).catch(missingPathOrThrow);
      // Native checkout deletion may have removed its own administrative files.
      // Never unlink a lock whose incarnation has been replaced by another writer.
      if (current?.dev === lock.dev && current.ino === lock.ino) {
        await fs.unlink(lock.path);
      }
    }
  }
}

/** Archive the original inode tree: Git locks cannot revoke pre-existing workfile writers. */
export async function retireExactWorktree<T>(params: {
  record: ManagedWorktreeRecord;
  retirementName: string;
  snapshot: string;
  git: WorktreeGitPolicy;
  signal?: AbortSignal;
  assertCurrent: () => void;
  assertRollbackCurrent: () => void;
  verify: (quarantined: ManagedWorktreeRecord) => Promise<void>;
  finalize: (recoveryPath: string) => Promise<T>;
}): Promise<T> {
  const { record, git } = params;
  const destination = path.join(path.dirname(record.path), params.retirementName);
  const source = await fs.lstat(record.path);
  if (!source.isDirectory()) {
    throw new Error("Exact-state source is no longer a directory; source preserved");
  }
  const occupied = await fs.lstat(destination).catch(missingPathOrThrow);
  if (occupied) {
    throw new Error("Exact-state retirement destination is occupied; source preserved");
  }
  await git.require(record.repoRoot, ["worktree", "move", "--", record.path, destination], {
    signal: params.signal,
    beforeRun: params.assertCurrent,
    killProcessTree: true,
  });
  const moved = await fs.lstat(destination);
  if (moved.dev !== source.dev || moved.ino !== source.ino) {
    throw new Error(
      "Exact-state source identity changed; quarantined source and recovery snapshot preserved",
    );
  }
  let retired = false;
  try {
    const quarantined = { ...record, path: destination };
    return await withExactStateGitLocks(quarantined, params.assertCurrent, async () => {
      await params.verify(quarantined);
      params.signal?.throwIfAborted();
      params.assertCurrent();
      // A process can still hold a cwd, directory handle, hard link or writable
      // descriptor into this tree. Do not delete it. Native recovery retains the
      // original checkout alongside the immutable snapshot for the retention period.
      retired = true;
      return await params.finalize(destination);
    });
  } catch (error) {
    if (!retired) {
      try {
        // Caller cancellation cannot abandon a complete source at a temporary name.
        // Allocation ownership, not the revoked caller, owns this joined rollback.
        await requireGit(record.repoRoot, ["worktree", "move", "--", destination, record.path], {
          beforeRun: params.assertRollbackCurrent,
          killProcessTree: true,
        });
        await requireGit(
          record.repoRoot,
          ["update-ref", "-d", `refs/openclaw/removals/${record.id}`, params.snapshot],
          {
            beforeRun: params.assertRollbackCurrent,
            killProcessTree: true,
          },
        );
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Exact-state retirement stopped; source retained at ${destination} and recovery snapshot preserved`,
          { cause: rollbackError },
        );
      }
    }
    throw error;
  }
}

/** Synchronous admission/finalization fence after asynchronous native checks. */
export function assertExactStateSourceIdentity(
  target: string,
  metadata: Pick<ExactStateSnapshot, "sourceIdentity">,
): void {
  const stat = lstatSync(target, { bigint: true, throwIfNoEntry: false });
  if (
    !stat?.isDirectory() ||
    stat.dev.toString() !== metadata.sourceIdentity.device ||
    stat.ino.toString() !== metadata.sourceIdentity.inode
  ) {
    throw new Error("Retained exact-state source identity changed; sources and snapshot preserved");
  }
}

export async function requireExactWorktreeRepository(
  record: ManagedWorktreeRecord,
  sourcePath: string,
  options: GitOptions,
) {
  const commonAt = async (cwd: string) =>
    await canonicalPathKey(
      path.resolve(
        cwd,
        normalizeGitPathForFilesystem(
          await requireGit(cwd, ["rev-parse", "--git-common-dir"], options),
        ),
      ),
    );
  if ((await commonAt(sourcePath)) !== (await commonAt(record.repoRoot))) {
    throw new Error("Retained exact-state repository changed; source preserved");
  }
}

export async function hasExactWorktreeIndex(
  sourcePath: string,
  metadata: ExactStateSnapshot,
  options: GitOptions,
): Promise<boolean> {
  const index = path.resolve(
    sourcePath,
    normalizeGitPathForFilesystem(
      await requireGit(sourcePath, ["rev-parse", "--git-path", "index"], options),
    ),
  );
  const original = await fs.readFile(index).catch(missingPathOrThrow);
  if (!original) {
    return false;
  }
  if (createHash("sha256").update(original).digest("hex") !== metadata.indexSha256) {
    throw new Error("Retained exact-state index changed; source and snapshot preserved");
  }
  if (metadata.sharedIndex) {
    const bytes = await fs
      .readFile(path.join(path.dirname(index), metadata.sharedIndex.name))
      .catch(missingPathOrThrow);
    const digest =
      bytes &&
      createHash(metadata.head.length === 64 ? "sha256" : "sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
    if (digest !== metadata.sharedIndex.blob) {
      throw new Error("Retained exact-state shared index changed; source and snapshot preserved");
    }
  }
  return true;
}

/** Prefer the retained original tree, preserving even writes through old descriptors. */
export async function restoreRetiredExactWorktree<T>(params: {
  record: ManagedWorktreeRecord;
  metadata: ExactStateSnapshot;
  options: GitOptions;
  assertCurrent: () => void;
  finalize: () => Promise<T>;
}): Promise<T | undefined> {
  const { record, metadata, options, assertCurrent } = params;
  const retained = path.join(path.dirname(record.path), metadata.retirementName);
  const statAt = async (target: string) =>
    await fs.lstat(target, { bigint: true }).catch(missingPathOrThrow);
  const [retainedStat, liveStat, registrations] = await Promise.all([
    statAt(retained),
    statAt(record.path),
    listGitWorktrees(record.repoRoot),
  ]);
  const retainedRegistered = registrations.some((entry) => entry.path === retained);
  const liveRegistered = registrations.some((entry) => entry.path === record.path);
  if (!retainedStat && !retainedRegistered && !liveStat && !liveRegistered) {
    return undefined;
  }
  if (
    !retainedStat &&
    !retainedRegistered &&
    liveStat?.isDirectory() &&
    !liveRegistered &&
    (await fs.readdir(record.path)).length === 0
  ) {
    return undefined;
  }
  if ((retainedStat || retainedRegistered) && (liveStat || liveRegistered)) {
    throw new Error("Exact-state live path is occupied; both sources and snapshot preserved");
  }
  const alreadyMoved = !retainedStat && !retainedRegistered;
  const sourcePath = alreadyMoved ? record.path : retained;
  const stat = alreadyMoved ? liveStat : retainedStat;
  const registered = alreadyMoved ? liveRegistered : retainedRegistered;
  if (
    !stat?.isDirectory() ||
    !registered ||
    stat.dev.toString() !== metadata.sourceIdentity.device ||
    stat.ino.toString() !== metadata.sourceIdentity.inode
  ) {
    throw new Error(
      "Retained exact-state source identity or registration changed; source preserved",
    );
  }
  await requireExactWorktreeRepository(record, sourcePath, options);
  const archived = { ...record, path: sourcePath, removedAt: undefined };
  return await withExactStateGitLocks(archived, assertCurrent, async () => {
    await requireExactManagedWorktreeHead(
      archived,
      {
        ownerKind: record.ownerKind,
        ownerId: record.ownerId,
        createdAt: record.createdAt,
        lastActiveAt: record.lastActiveAt,
        head: metadata.head,
        branchHead: metadata.branchHead,
        indexSha256: metadata.indexSha256,
      },
      options,
    );
    if (!(await hasExactWorktreeIndex(sourcePath, metadata, options))) {
      throw new Error("Retained exact-state index missing; source and snapshot preserved");
    }
    const beforeMove = () => {
      assertCurrent();
      assertExactStateSourceIdentity(sourcePath, metadata);
    };
    beforeMove();
    // Native move never overlays a recreated live path. Once admitted, join it;
    // cancellation must not strand a partially completed filesystem rename.
    if (!alreadyMoved) {
      await requireGit(record.repoRoot, ["worktree", "move", "--", retained, record.path], {
        beforeRun: beforeMove,
        killProcessTree: true,
      });
    }
    assertCurrent();
    assertExactStateSourceIdentity(record.path, metadata);
    // Native writers remain excluded until the registry publishes the restored lifecycle.
    return await params.finalize();
  });
}
