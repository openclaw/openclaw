import { randomBytes, randomUUID, createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { resolveWorktreeBase } from "./base-ref.js";
import { lockState, lockWorktreeForProcess, unlockWorktree } from "./git-lock.js";
import {
  commandError,
  listGitWorktrees,
  pathExists,
  removeEmptyParents,
  requireGit,
  requireGitRaw,
  runGit,
  type GitResult,
} from "./git.js";
import {
  deleteRegistryWorktree,
  findRegistryWorktreeByPath,
  findLiveRegistryWorktreeByOwner,
  findLiveRegistryWorktreeByPath,
  getRegistryWorktree,
  insertRegistryWorktreeIfPathFree,
  listRegistryWorktrees,
  updateRegistryWorktree,
} from "./registry.js";
import {
  abortWorktreeRemoval,
  claimWorktreeRemoval,
  finalizeWorktreeRemoval,
  hasLiveWorktreeRunLease,
} from "./run-lease.js";
import type {
  CreateManagedWorktreeParams,
  ManagedWorktreeBranch,
  ManagedWorktreeBranchesResult,
  ManagedWorktreeGcResult,
  ManagedWorktreeOwnerKind,
  ManagedWorktreeRecord,
  RemoveManagedWorktreeResult,
} from "./types.js";

export const IDLE_GC_MS = 7 * 24 * 60 * 60 * 1000; // Idle worktrees remain restorable after automatic cleanup.
export const SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // Snapshot refs expire with their registry affordance.
export const WORKTREE_GC_INTERVAL_MS = 60 * 60 * 1000;
const SETUP_SCRIPT_TIMEOUT_MS = 120_000;
// Provisioning heartbeat contract (distinct from run leases in run-lease.ts): a provisioning
// holder bumps lastActiveAt on a wall-clock interval for the whole provisioning phase, so no
// stall class (large include-file copy, slow setup, ...) leaves a silence gap while the
// process lives. A claim silent for PROVISIONING_STALE_MS has a dead holder and gc may
// reclaim the path and branch.
export const PROVISIONING_HEARTBEAT_MS = 30_000; // 40x inside the stale threshold.
export const PROVISIONING_STALE_MS = 10 * SETUP_SCRIPT_TIMEOUT_MS;

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Non-forced removal aborted because the safety snapshot failed. */
export class WorktreeSnapshotError extends Error {
  readonly snapshotError: string;
  constructor(snapshotError: string, options?: ErrorOptions) {
    super(`worktree snapshot failed; removal aborted: ${snapshotError}`, options);
    this.snapshotError = snapshotError;
  }
}

/** Name reuse hit a same-path row still provisioning; retry after it settles or gc reaps it. */
export class WorktreeProvisioningError extends Error {
  constructor(name: string) {
    super(`worktree provisioning in progress: ${name}`);
  }
}

/** Provisioning outlived PROVISIONING_STALE_MS and gc reclaimed the path mid-create. */
export class WorktreeProvisioningReapedError extends Error {
  constructor(name: string) {
    super(`worktree provisioning exceeded its window and was reclaimed: ${name}`);
  }
}

/** Snapshot restore refused: a provisioning-origin snapshot has no usable checkout. */
export class WorktreeUnprovisionedRestoreError extends Error {
  constructor(name: string) {
    super(`cannot restore a worktree that never finished provisioning: ${name}; create it again`);
  }
}
const SNAPSHOT_REF_PREFIX = "refs/openclaw/snapshots";
const log = createSubsystemLogger("agents/worktrees");

type ServiceOptions = {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
};

type ManagedWorktreeGcParams = {
  isOwnerActive?: (ownerKind: ManagedWorktreeOwnerKind, ownerId: string) => boolean;
};

function resultMessage(result: GitResult): string {
  return (result.stderr || result.stdout).trim().split("\n").slice(-12).join("\n");
}

function validateName(name: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new Error("worktree name must match [a-z0-9][a-z0-9-]{0,63}");
  }
  return name;
}

function generateName(): string {
  return `wt-${randomBytes(4).toString("hex")}`;
}

function recordOwnerMatches(
  record: ManagedWorktreeRecord,
  params: Pick<CreateManagedWorktreeParams, "ownerKind" | "ownerId">,
): boolean {
  return (
    record.ownerKind === (params.ownerKind ?? "manual") &&
    (record.ownerId ?? undefined) === (params.ownerId ?? undefined)
  );
}

function worktreeNameInUseError(record: ManagedWorktreeRecord, name: string): Error {
  return new Error(
    `worktree name is already in use by ${record.ownerKind}${record.ownerId ? ` ${record.ownerId}` : ""}: ${name}`,
  );
}

async function resolveRepository(repoRoot: string): Promise<{
  repoRoot: string;
  sourceRoot: string;
  commonDir: string;
  originUrl: string;
  fingerprint: string;
}> {
  const requested = await fs.realpath(repoRoot).catch(() => {
    throw new Error(`repository does not exist: ${repoRoot}`);
  });
  const rootResult = await runGit(requested, ["rev-parse", "--show-toplevel"]);
  if (rootResult.code !== 0) {
    throw new Error(`not a git checkout: ${repoRoot}`);
  }
  const sourceRoot = await fs.realpath(rootResult.stdout.trim());
  const commonRaw = await requireGit(sourceRoot, ["rev-parse", "--git-common-dir"]);
  const commonDir = await fs.realpath(
    path.isAbsolute(commonRaw) ? commonRaw : path.resolve(sourceRoot, commonRaw),
  );
  const primary = (await listGitWorktrees(sourceRoot))[0]?.path ?? sourceRoot;
  const canonicalRoot = await fs.realpath(primary);
  const origin = await runGit(canonicalRoot, ["config", "--get", "remote.origin.url"]);
  const originUrl = origin.code === 0 ? origin.stdout.trim() : "";
  const fingerprint = createHash("sha256")
    .update(`${commonDir}\n${originUrl}`)
    .digest("hex")
    .slice(0, 16);
  return { repoRoot: canonicalRoot, sourceRoot, commonDir, originUrl, fingerprint };
}

async function ensureNoSymlinkDirectory(root: string, relativePath: string): Promise<boolean> {
  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        return false;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  return true;
}

async function copyIncludedFiles(repoRoot: string, worktreePath: string): Promise<void> {
  const includePath = path.join(repoRoot, ".worktreeinclude");
  if (!(await pathExists(includePath))) {
    return;
  }
  const candidatesRaw = await requireGitRaw(repoRoot, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "-z",
  ]);
  const includedRaw = await requireGitRaw(repoRoot, [
    "ls-files",
    "--others",
    "--ignored",
    `--exclude-from=${includePath}`,
    "-z",
  ]);
  const included = new Set(includedRaw.split("\0").filter(Boolean));
  for (const relativePath of candidatesRaw.split("\0").filter(Boolean)) {
    if (!included.has(relativePath) || path.isAbsolute(relativePath)) {
      continue;
    }
    const normalized = path.normalize(relativePath);
    if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
      continue;
    }
    if (
      !(await ensureNoSymlinkDirectory(repoRoot, normalized)) ||
      !(await ensureNoSymlinkDirectory(worktreePath, normalized))
    ) {
      continue;
    }
    const source = path.join(repoRoot, normalized);
    const destination = path.join(worktreePath, normalized);
    const sourceStat = await fs.lstat(source).catch(() => undefined);
    if (!sourceStat?.isFile() || sourceStat.isSymbolicLink()) {
      continue;
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    });
    await fs.chmod(destination, sourceStat.mode);
  }
}

async function cleanupFailedCreate(repoRoot: string, worktreePath: string, branch: string) {
  const removed = await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
  const deletedBranch = await runGit(repoRoot, ["branch", "-D", branch]);
  await runGit(repoRoot, ["worktree", "prune"]);
  if (removed.code !== 0 || deletedBranch.code !== 0) {
    throw new Error(
      `failed to clean up worktree creation: ${resultMessage(removed) || resultMessage(deletedBranch)}`,
    );
  }
}

async function resetFailedWorktreeAdd(
  repoRoot: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  const listed = (await listGitWorktrees(repoRoot)).some(
    (entry) => path.resolve(entry.path) === path.resolve(worktreePath),
  );
  if (listed) {
    const removed = await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
    if (removed.code !== 0) {
      throw commandError("git worktree remove", removed);
    }
  } else if (await pathExists(worktreePath)) {
    // A failed add can leave an unregistered directory; it is safe debris once git omits it.
    await fs.rm(worktreePath, { recursive: true, force: true });
  }
  const branchExists = await runGit(repoRoot, [
    "show-ref",
    "--quiet",
    "--verify",
    `refs/heads/${branch}`,
  ]);
  if (branchExists.code === 0) {
    await requireGit(repoRoot, ["branch", "-D", branch]);
  }
  await requireGit(repoRoot, ["worktree", "prune"]);
}

async function canResetFailedWorktreeAdd(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  failure: GitResult,
): Promise<boolean> {
  const message = resultMessage(failure);
  const createdBranch = message.includes(`Preparing worktree (new branch '${branch}')`);
  if (message.includes("unable to checkout working tree") || createdBranch) {
    return true;
  }
  const listed = (await listGitWorktrees(repoRoot)).some(
    (entry) => path.resolve(entry.path) === path.resolve(worktreePath),
  );
  if (listed || (await pathExists(worktreePath))) {
    return false;
  }
  const branchExists = await runGit(repoRoot, [
    "show-ref",
    "--quiet",
    "--verify",
    `refs/heads/${branch}`,
  ]);
  return branchExists.code === 1;
}

/**
 * A create() that crashed between `git worktree add` and its registry insert leaves a live
 * git worktree + managed branch with no registry row. Adoption requires an exact match on
 * both path and branch so foreign or detached worktrees are never silently claimed.
 */
async function findAdoptableOrphan(
  repoRoot: string,
  worktreePath: string,
  branch: string,
): Promise<boolean> {
  const listed = await listGitWorktrees(repoRoot).catch(() => []);
  return listed.some(
    (entry) =>
      path.resolve(entry.path) === path.resolve(worktreePath) &&
      entry.branch === `refs/heads/${branch}`,
  );
}

async function runSetupScript(repoRoot: string, worktreePath: string): Promise<void> {
  const setupScript = path.join(repoRoot, ".openclaw", "worktree-setup.sh");
  const stat = await fs.stat(setupScript).catch(() => undefined);
  if (!stat?.isFile() || (stat.mode & 0o111) === 0) {
    return;
  }
  const result = await runCommandWithTimeout([setupScript], {
    timeoutMs: SETUP_SCRIPT_TIMEOUT_MS,
    cwd: worktreePath,
    env: {
      OPENCLAW_SOURCE_TREE_PATH: repoRoot,
      OPENCLAW_WORKTREE_PATH: worktreePath,
    },
  });
  if (result.code !== 0) {
    throw new Error(
      `worktree setup failed${resultMessage(result) ? `:\n${resultMessage(result)}` : ""}`,
    );
  }
}

async function snapshotWorktree(record: ManagedWorktreeRecord, reason: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-worktree-index-"));
  const indexPath = path.join(tempDir, "index");
  const snapshotRef = `${SNAPSHOT_REF_PREFIX}/${record.id}`;
  const env: NodeJS.ProcessEnv = {
    GIT_INDEX_FILE: indexPath,
    GIT_AUTHOR_NAME: "OpenClaw",
    GIT_AUTHOR_EMAIL: "openclaw@localhost",
    GIT_COMMITTER_NAME: "OpenClaw",
    GIT_COMMITTER_EMAIL: "openclaw@localhost",
  };
  try {
    await requireGit(record.path, ["read-tree", "HEAD"], { env });
    // Ignored files stay outside the repository object database; provisioning recreates them.
    await requireGit(record.path, ["add", "-A"], { env });
    const tree = await requireGit(record.path, ["write-tree"], { env });
    const treeEntries = await requireGit(record.path, ["ls-tree", "-r", tree]);
    // Gitlinks omit nested worktree files, so accepting one would violate the full-tree snapshot.
    if (treeEntries.split("\n").some((entry) => entry.startsWith("160000 "))) {
      throw new Error("nested git repositories cannot be snapshotted losslessly");
    }
    const parent = await requireGit(record.path, ["rev-parse", "HEAD"]);
    const commit = await requireGit(
      record.path,
      ["commit-tree", tree, "-p", parent, "-m", `OpenClaw worktree snapshot: ${reason}`],
      { env },
    );
    await requireGit(record.repoRoot, ["update-ref", snapshotRef, commit]);
    return snapshotRef;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export class ManagedWorktreeService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;

  constructor(options: ServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
  }

  async create(params: CreateManagedWorktreeParams): Promise<ManagedWorktreeRecord> {
    const repository = await resolveRepository(params.repoRoot);
    const name = validateName(params.name ?? generateName());
    const root = path.join(resolveStateDir(this.env), "worktrees", repository.fingerprint);
    const worktreePath = path.join(root, name);
    const existing = findRegistryWorktreeByPath(this.env, worktreePath);
    // Usable records are 'ready' only: a live 'provisioning' row means another create()
    // holds the claim (or crashed mid-setup, which gc reaps after PROVISIONING_STALE_MS).
    // Returning it would hand out a checkout whose copy/setup never finished.
    if (existing?.name === name && !existing.removedAt && existing.readiness === "provisioning") {
      throw new WorktreeProvisioningError(name);
    }
    // Name reuse only ever adopts the caller's own record. Without this guard a
    // caller-chosen name could bind a new owner to another session's or a
    // manual checkout and run inside it.
    if (existing?.name === name && !existing.removedAt && !recordOwnerMatches(existing, params)) {
      throw worktreeNameInUseError(existing, name);
    }
    if (existing?.name === name && existing.removedAt === undefined) {
      if (await pathExists(existing.path)) {
        return existing;
      }
      updateRegistryWorktree(this.env, existing.id, { removedAt: this.now() });
    }
    if (existing?.name === name && existing.removedAt !== undefined && existing.snapshotRef) {
      if (!recordOwnerMatches(existing, params)) {
        throw worktreeNameInUseError(existing, name);
      }
      if (existing.readiness === "provisioning") {
        // A provisioning-origin snapshot has no completed provisioning and no user work
        // (same rationale as the missing-path heal); drop the row and its snapshot ref so
        // the fresh create below provisions from scratch instead of restoring a stub.
        await runGit(existing.repoRoot, ["update-ref", "-d", existing.snapshotRef]);
        deleteRegistryWorktree(this.env, existing.id);
      } else {
        // restore() re-activates this EXISTING row via updateRegistryWorktree — it operates on
        // the row that already owns the path, so it cannot create a duplicate live row.
        return await this.restore({ id: existing.id });
      }
    }
    const branch = `openclaw/${name}`;
    const branchExists = await runGit(repository.repoRoot, [
      "show-ref",
      "--quiet",
      "--verify",
      `refs/heads/${branch}`,
    ]);
    if (branchExists.code === 0) {
      // No registry row was found above for this exact path, yet the managed branch already
      // exists: this is the crashed-create() signature. Adopt only on an exact live-worktree +
      // branch match; a bare branch collision (no worktree) keeps the throw below.
      if (
        existing === undefined &&
        (await findAdoptableOrphan(repository.repoRoot, worktreePath, branch))
      ) {
        // The crash may have hit before provisioning finished; claimThenProvision re-runs
        // copy + setup as the claim holder, or defers to a concurrent winner untouched.
        const adoptedBase = await resolveWorktreeBase(repository.repoRoot, params.baseRef);
        const adopted = await this.claimThenProvision({
          repository,
          params,
          name,
          worktreePath,
          branch,
          baseRef: adoptedBase.recordRef,
        });
        if (adopted) {
          return adopted;
        }
        // Winner vanished between claim and lookup; fall through to the collision error.
      }
      throw new Error(`branch already exists: ${branch}`);
    }
    if (branchExists.code !== 1) {
      throw commandError("git show-ref --verify", branchExists);
    }
    const base = await resolveWorktreeBase(repository.repoRoot, params.baseRef);
    await fs.mkdir(root, { recursive: true });
    let gitBase = base.gitOperand;
    let recordBase = base.recordRef;
    let added = await runGit(repository.repoRoot, [
      "worktree",
      "add",
      "-b",
      branch,
      "--",
      worktreePath,
      gitBase,
    ]);
    if (added.code !== 0 && base.remote) {
      if (!(await canResetFailedWorktreeAdd(repository.repoRoot, worktreePath, branch, added))) {
        throw commandError("git worktree add", added);
      }
      await resetFailedWorktreeAdd(repository.repoRoot, worktreePath, branch);
      gitBase = "HEAD";
      recordBase = "HEAD";
      added = await runGit(repository.repoRoot, [
        "worktree",
        "add",
        "-b",
        branch,
        "--",
        worktreePath,
        gitBase,
      ]);
    }
    if (added.code !== 0) {
      throw commandError("git worktree add", added);
    }
    // Claim immediately after the add so the in-flight create is registered before any user
    // code (copy/setup) runs; the only no-row window left is add -> claim, which runs no
    // user code and is what the adoption path above recovers.
    const record = await this.claimThenProvision({
      repository,
      params,
      name,
      worktreePath,
      branch,
      baseRef: recordBase,
    });
    if (!record) {
      throw new Error(`worktree registration raced and lost: ${worktreePath}`);
    }
    return record;
  }

  async list(): Promise<ManagedWorktreeRecord[]> {
    const records = listRegistryWorktrees(this.env);
    const listed: ManagedWorktreeRecord[] = [];
    for (const record of records) {
      if (record.removedAt === undefined && !(await pathExists(record.path))) {
        try {
          if (await this.healMissingPathRecord(record)) {
            continue;
          }
        } catch (error) {
          log.warn(`missing-path cleanup failed for ${record.id}: ${String(error)}`);
        }
      }
      listed.push(record);
    }
    return listed.filter((record) => record.removedAt === undefined || record.snapshotRef);
  }

  /**
   * Missing-path self-heal shared by list() and gc(). Provisioning rows carry no snapshot
   * and no user work — retiring one would hide the row while its branch survives and
   * permanently block the name, so row AND branch are hard-deleted. Ready rows retire
   * restorably. Returns true when the row was hard-deleted.
   */
  private async healMissingPathRecord(record: ManagedWorktreeRecord): Promise<boolean> {
    if (record.readiness === "provisioning") {
      await this.reapProvisioningRecord(record);
      return true;
    }
    const removedAt = this.now();
    updateRegistryWorktree(this.env, record.id, { removedAt });
    record.removedAt = removedAt;
    return false;
  }

  /**
   * Destroys a dead provisioning claim (worktree, branch, row). Every remover — this reap
   * included — serializes through the removal claim: a provisioning row cannot hold a run
   * lease by construction (sessions are only ever handed 'ready' records), but the uniform
   * claim keeps one serialization point with remove()/removeIfLossless() and excludes
   * competing removers; a live run lease rejects the claim and the caller skips the record.
   */
  private async reapProvisioningRecord(record: ManagedWorktreeRecord): Promise<void> {
    const claimToken = randomUUID();
    claimWorktreeRemoval(this.env, { worktreeId: record.id, token: claimToken, force: false });
    try {
      // resetFailedWorktreeAdd tolerates the partial states a dead holder leaves
      // (unlisted dir, missing branch), unlike the happy-path cleanupFailedCreate.
      await resetFailedWorktreeAdd(record.repoRoot, record.path, record.branch);
      deleteRegistryWorktree(this.env, record.id);
      finalizeWorktreeRemoval(this.env, record.id);
    } catch (error) {
      abortWorktreeRemoval(this.env, record.id, claimToken);
      throw error;
    }
  }

  findLiveByOwner(
    ownerKind: ManagedWorktreeOwnerKind,
    ownerId: string,
  ): ManagedWorktreeRecord | undefined {
    return findLiveRegistryWorktreeByOwner(this.env, ownerKind, ownerId);
  }

  /** Resolves the canonical registry root and the caller's own checkout root. */
  async resolveRepositoryPaths(
    repoRoot: string,
  ): Promise<{ canonicalRoot: string; sourceRoot: string }> {
    const resolved = await resolveRepository(repoRoot);
    return { canonicalRoot: resolved.repoRoot, sourceRoot: resolved.sourceRoot };
  }

  /**
   * Lists selectable base refs for a repository without touching the network.
   * Base-ref pickers must stay snappy; resolveWorktreeBase() still fetches on create
   * when no explicit ref is chosen.
   */
  async listRepositoryBranches(repoRoot: string): Promise<ManagedWorktreeBranchesResult> {
    const repository = await resolveRepository(repoRoot);
    // Keyed by short branch name; the stored name is always a resolvable base
    // ref, so remote-only branches keep their remote-qualified form
    // (origin/feature-a) instead of a bare name git cannot resolve.
    const branches = new Map<string, ManagedWorktreeBranch>();
    const remoteRaw = await runGit(repository.repoRoot, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/remotes",
    ]);
    if (remoteRaw.code === 0) {
      for (const refname of remoteRaw.stdout.split("\n")) {
        const trimmed = refname.trim();
        if (!trimmed.startsWith("refs/remotes/")) {
          continue;
        }
        const withoutPrefix = trimmed.slice("refs/remotes/".length);
        const slash = withoutPrefix.indexOf("/");
        if (slash <= 0) {
          continue;
        }
        const shortName = withoutPrefix.slice(slash + 1);
        // remote HEAD symrefs are pointers, not selectable branches.
        if (!shortName || shortName === "HEAD") {
          continue;
        }
        branches.set(shortName, { name: withoutPrefix, kind: "remote" });
      }
    }
    const localRaw = await runGit(repository.repoRoot, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
    ]);
    if (localRaw.code === 0) {
      for (const line of localRaw.stdout.split("\n")) {
        const name = line.trim();
        if (name) {
          branches.set(name, { name, kind: "local" });
        }
      }
    }
    const remoteHead = await runGit(repository.repoRoot, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    const defaultShort =
      remoteHead.code === 0
        ? remoteHead.stdout.trim().replace(/^origin\//, "") || undefined
        : undefined;
    const head = await runGit(repository.repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const headBranch = head.code === 0 ? head.stdout.trim() || undefined : undefined;
    const defaultBranch = defaultShort
      ? (branches.get(defaultShort)?.name ?? defaultShort)
      : undefined;
    // Deterministic picker ordering: default base first, current checkout next, rest alphabetical.
    const rank = (shortName: string) =>
      shortName === defaultShort ? 0 : shortName === headBranch ? 1 : 2;
    const sorted = [...branches.entries()]
      .toSorted(
        ([aShort, a], [bShort, b]) => rank(aShort) - rank(bShort) || a.name.localeCompare(b.name),
      )
      .map(([, branch]) => branch);
    return {
      branches: sorted,
      ...(defaultBranch ? { defaultBranch } : {}),
      ...(headBranch ? { headBranch } : {}),
    };
  }

  async acquire(id: string): Promise<ManagedWorktreeRecord> {
    const record = this.requireLiveRecord(id);
    await lockWorktreeForProcess(record);
    const lastActiveAt = this.now();
    updateRegistryWorktree(this.env, id, { lastActiveAt });
    return { ...record, lastActiveAt };
  }

  async release(id: string): Promise<void> {
    const record = getRegistryWorktree(this.env, id);
    if (!record || record.removedAt !== undefined || !(await pathExists(record.path))) {
      return;
    }
    const state = await lockState(record);
    if (state.kind === "live" && state.pid !== process.pid) {
      return;
    }
    if (state.kind === "foreign") {
      return;
    }
    if (state.kind !== "none") {
      await unlockWorktree(record);
    }
  }

  async remove(params: {
    id: string;
    reason: string;
    force?: boolean;
    claimToken?: string;
  }): Promise<RemoveManagedWorktreeResult> {
    const record = this.requireLiveRecord(params.id);
    const force = params.force ?? false;
    // Claim removal before any cleanliness or snapshot work so a live run lease
    // rejects it and an admitted run cannot start once the claim is held. The
    // opaque token makes the claim exclusive against competing removers; a caller
    // that already claimed (removeIfLossless) passes its token to keep one claim.
    const claimToken = params.claimToken ?? randomUUID();
    claimWorktreeRemoval(this.env, { worktreeId: record.id, token: claimToken, force });
    try {
      const state = await lockState(record);
      if ((state.kind === "live" || state.kind === "foreign") && !force) {
        throw new Error(
          state.kind === "live"
            ? `worktree is locked by live OpenClaw pid ${state.pid}`
            : `worktree has a foreign lock${state.reason ? `: ${state.reason}` : ""}`,
        );
      }
      if (state.kind !== "none") {
        await requireGit(record.repoRoot, ["worktree", "unlock", record.path]);
      }
      let snapshotRef = record.snapshotRef;
      let snapshotError: string | undefined;
      try {
        snapshotRef = await snapshotWorktree(record, params.reason);
        updateRegistryWorktree(this.env, record.id, { snapshotRef });
      } catch (error) {
        snapshotError = error instanceof Error ? error.message : String(error);
        if (!force) {
          throw new WorktreeSnapshotError(snapshotError, { cause: error });
        }
      }
      const removed = await runGit(record.repoRoot, ["worktree", "remove", "--force", record.path]);
      if (removed.code !== 0) {
        throw commandError("git worktree remove", removed);
      }
      const branchDelete = await runGit(record.repoRoot, ["branch", "-D", record.branch]);
      if (branchDelete.code !== 0) {
        throw commandError("git branch -D", branchDelete);
      }
      await requireGit(record.repoRoot, ["worktree", "prune"]);
      await removeEmptyParents(
        path.dirname(record.path),
        path.join(resolveStateDir(this.env), "worktrees"),
      );
      const removedAt = this.now();
      updateRegistryWorktree(this.env, record.id, { removedAt, snapshotRef });
      finalizeWorktreeRemoval(this.env, record.id);
      return {
        removed: true,
        ...(snapshotRef ? { snapshotRef } : {}),
        ...(snapshotError ? { snapshotError } : {}),
      };
    } catch (error) {
      abortWorktreeRemoval(this.env, record.id, claimToken);
      throw error;
    }
  }

  async restore(params: { id: string }): Promise<ManagedWorktreeRecord> {
    const record = getRegistryWorktree(this.env, params.id);
    if (!record?.snapshotRef || record.removedAt === undefined) {
      throw new Error(`worktree ${params.id} is not restorable`);
    }
    // A provisioning-origin snapshot contains no completed provisioning and no user work;
    // restoring it as ready would hand out an unusable checkout. Fresh create is the recovery.
    if (record.readiness === "provisioning") {
      throw new WorktreeUnprovisionedRestoreError(record.name);
    }
    if (!(await pathExists(record.repoRoot))) {
      throw new Error(`source repository no longer exists: ${record.repoRoot}`);
    }
    const parent = await requireGit(record.repoRoot, ["rev-parse", `${record.snapshotRef}^`]);
    await fs.mkdir(path.dirname(record.path), { recursive: true });
    await requireGit(record.repoRoot, [
      "worktree",
      "add",
      "--detach",
      record.path,
      record.snapshotRef,
    ]);
    let branchCreated = false;
    try {
      // Branch history stays at the original commit; the snapshot is restored as working state.
      await requireGit(record.repoRoot, ["branch", record.branch, parent]);
      branchCreated = true;
      await requireGit(record.path, ["symbolic-ref", "HEAD", `refs/heads/${record.branch}`]);
      await requireGit(record.path, ["reset"]);
      await copyIncludedFiles(record.repoRoot, record.path);
    } catch (error) {
      const removed = await runGit(record.repoRoot, ["worktree", "remove", "--force", record.path]);
      const branchDeleted = branchCreated
        ? await runGit(record.repoRoot, ["branch", "-D", record.branch])
        : undefined;
      if (removed.code !== 0 || (branchDeleted && branchDeleted.code !== 0)) {
        throw new Error(
          `${String(error)}\nrestore cleanup failed: ${resultMessage(removed) || (branchDeleted ? resultMessage(branchDeleted) : "")}`,
          { cause: error },
        );
      }
      throw error;
    }
    const lastActiveAt = this.now();
    // Restore fully rematerializes the checkout, so the row is ready regardless of the
    // readiness it was removed with; reviving a stale 'provisioning' row would let the next
    // gc reap the freshly restored worktree and strand its snapshot ref.
    updateRegistryWorktree(this.env, params.id, {
      removedAt: undefined,
      lastActiveAt,
      readiness: "ready",
    });
    // Clear any lease rows or removal marker stranded by a crash between git removal
    // and finalize so the restored worktree admits runs again.
    finalizeWorktreeRemoval(this.env, params.id);
    const restored: ManagedWorktreeRecord = { ...record, lastActiveAt, readiness: "ready" };
    delete restored.removedAt;
    return restored;
  }

  async removeIfLossless(id: string): Promise<boolean> {
    const record = this.requireLiveRecord(id);
    const claimToken = randomUUID();
    try {
      claimWorktreeRemoval(this.env, { worktreeId: id, token: claimToken, force: false });
    } catch {
      // A live run lease or a competing remover holds the worktree; a lossless
      // auto-cleanup must not race it.
      return false;
    }
    try {
      const status = await requireGit(record.path, ["status", "--porcelain"]);
      const unpushed = await requireGit(record.path, [
        "log",
        "HEAD",
        "--not",
        "--remotes",
        "--oneline",
      ]);
      if (status || unpushed) {
        abortWorktreeRemoval(this.env, id, claimToken);
        return false;
      }
    } catch (error) {
      abortWorktreeRemoval(this.env, id, claimToken);
      throw error;
    }
    await this.release(id);
    await this.remove({ id, reason: "run-end", claimToken });
    return true;
  }

  async removeIfLosslessByPath(worktreePath: string): Promise<boolean> {
    const record = findLiveRegistryWorktreeByPath(this.env, worktreePath);
    if (!record) {
      return false;
    }
    return await this.removeIfLossless(record.id);
  }

  async releaseByPath(worktreePath: string): Promise<void> {
    const record = findLiveRegistryWorktreeByPath(this.env, worktreePath);
    if (record) {
      await this.release(record.id);
    }
  }

  async gc(params: ManagedWorktreeGcParams = {}): Promise<ManagedWorktreeGcResult> {
    const now = this.now();
    const removed: string[] = [];
    const records = listRegistryWorktrees(this.env);
    for (const record of records) {
      try {
        if (record.removedAt === undefined && !(await pathExists(record.path))) {
          if (await this.healMissingPathRecord(record)) {
            continue;
          }
        }
        // A provisioning claim whose heartbeat is silent past PROVISIONING_STALE_MS has a
        // dead holder; reap worktree+branch+row so the next create() — including auto-named
        // orphans no retry will ever reach — starts fresh. Heartbeating claims stay untouched.
        if (
          record.removedAt === undefined &&
          record.readiness === "provisioning" &&
          now - record.lastActiveAt > PROVISIONING_STALE_MS
        ) {
          await this.reapProvisioningRecord(record);
          continue;
        }
        // Manual worktrees remain until explicit removal; only run-owned worktrees expire.
        const expiresWhenIdle = record.ownerKind === "workboard" || record.ownerKind === "session";
        if (
          record.removedAt === undefined &&
          expiresWhenIdle &&
          now - record.lastActiveAt > IDLE_GC_MS
        ) {
          if (
            record.ownerId !== undefined &&
            params.isOwnerActive?.(record.ownerKind, record.ownerId) === true
          ) {
            continue;
          }
          if (hasLiveWorktreeRunLease(this.env, record.id)) {
            continue;
          }
          const state = await lockState(record);
          if (state.kind === "live" || state.kind === "foreign") {
            continue;
          }
          if (state.kind === "dead") {
            await requireGit(record.repoRoot, ["worktree", "unlock", record.path]);
          }
          await this.remove({ id: record.id, reason: "idle-gc" });
          removed.push(record.id);
        }
      } catch (error) {
        log.warn(`idle cleanup failed for ${record.id}: ${String(error)}`);
      }
    }
    const orphansDeleted = await this.reconcileOrphans(records);
    let snapshotsPruned = 0;
    for (const record of listRegistryWorktrees(this.env)) {
      if (record.removedAt === undefined || now - record.removedAt <= SNAPSHOT_RETENTION_MS) {
        continue;
      }
      try {
        if (record.snapshotRef && (await pathExists(record.repoRoot))) {
          await requireGit(record.repoRoot, ["update-ref", "-d", record.snapshotRef]);
        }
        deleteRegistryWorktree(this.env, record.id);
        snapshotsPruned += 1;
      } catch (error) {
        log.warn(`snapshot retention failed for ${record.id}: ${String(error)}`);
      }
    }
    return { removed, orphansDeleted, snapshotsPruned };
  }

  /**
   * Shared post-`git worktree add` sequence for normal create and orphan adoption: claim the
   * path atomically FIRST, then only the claim holder provisions; on provisioning failure the
   * holder removes worktree+branch and drops its own row, so failed creates leave no row.
   * Invariant: an in-flight create holds a live row from claim-time onward, so a live worktree
   * with NO row genuinely means a crashed create — an in-flight worktree can never be adopted,
   * re-provisioned, or destroyed by a concurrent same-name call. A lost claim mirrors the
   * live-row-at-path shortcut; undefined means the claim lost and no live winner row exists.
   */
  private async claimThenProvision(args: {
    repository: { fingerprint: string; repoRoot: string; sourceRoot: string };
    params: CreateManagedWorktreeParams;
    name: string;
    worktreePath: string;
    branch: string;
    baseRef: string;
  }): Promise<ManagedWorktreeRecord | undefined> {
    const { repository, params, name, worktreePath, branch, baseRef } = args;
    const createdAt = this.now();
    const record: ManagedWorktreeRecord = {
      id: randomUUID(),
      name,
      repoFingerprint: repository.fingerprint,
      repoRoot: repository.repoRoot,
      path: worktreePath,
      branch,
      baseRef,
      ownerKind: params.ownerKind ?? "manual",
      ...(params.ownerId ? { ownerId: params.ownerId } : {}),
      readiness: "provisioning",
      createdAt,
      lastActiveAt: createdAt,
    };
    if (!insertRegistryWorktreeIfPathFree(this.env, record)) {
      // Claim lost: a concurrent create() owns the path; this call runs no setup, no copy,
      // no cleanup.
      const winner = findLiveRegistryWorktreeByPath(this.env, worktreePath);
      if (!winner) {
        return undefined;
      }
      // Only 'ready' rows are usable records; the winner is still provisioning its checkout.
      if (winner.readiness === "provisioning") {
        throw new WorktreeProvisioningError(name);
      }
      if (!recordOwnerMatches(winner, params)) {
        throw worktreeNameInUseError(winner, name);
      }
      return winner;
    }
    // The row is visible as 'provisioning' (list()) while copy/setup run; that is what makes
    // in-flight creates unadoptable and observable. Failed creates still end with no row.
    // Wall-clock provisioning heartbeat for the whole phase: any stall class (a single large
    // include-file copy, a slow setup) keeps proving a live holder, so gc never reaps a
    // claim whose process is still alive. Always cleared below; a leaked interval would
    // keep bumping a dead claim forever.
    const heartbeat = setInterval(() => {
      updateRegistryWorktree(this.env, record.id, { lastActiveAt: this.now() });
    }, PROVISIONING_HEARTBEAT_MS);
    try {
      await copyIncludedFiles(repository.sourceRoot, worktreePath);
      if (params.runSetupScript !== false) {
        await runSetupScript(repository.sourceRoot, worktreePath);
      }
    } catch (error) {
      // Claim-holder-only destruction: the row is held while the worktree is removed, then
      // dropped so no registration outlives the path.
      try {
        await cleanupFailedCreate(repository.repoRoot, worktreePath, branch);
      } catch (cleanupError) {
        throw new Error(`${String(error)}\n${String(cleanupError)}`, { cause: cleanupError });
      }
      deleteRegistryWorktree(this.env, record.id);
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
    // Readiness flips only after provisioning fully succeeded; every usable-record path
    // (entry shortcut, findLiveByOwner) filters on it. The flip is also the final heartbeat.
    const readyAt = this.now();
    updateRegistryWorktree(this.env, record.id, { readiness: "ready", lastActiveAt: readyAt });
    // Backstop for the pathological suspended holder: heartbeats can stall long enough for
    // gc to reap the claim mid-create; the flip above then updated zero rows. Never hand
    // back a record whose path was already reclaimed.
    const flipped = getRegistryWorktree(this.env, record.id);
    if (!flipped || flipped.removedAt !== undefined) {
      throw new WorktreeProvisioningReapedError(name);
    }
    return { ...record, readiness: "ready", lastActiveAt: readyAt };
  }

  private requireLiveRecord(id: string): ManagedWorktreeRecord {
    const record = getRegistryWorktree(this.env, id);
    if (!record || record.removedAt !== undefined) {
      throw new Error(`unknown active worktree: ${id}`);
    }
    return record;
  }

  private async reconcileOrphans(records: ManagedWorktreeRecord[]): Promise<number> {
    const managedPaths = new Set(records.map((record) => path.resolve(record.path)));
    const worktreesRoot = path.join(resolveStateDir(this.env), "worktrees");
    const fingerprints = await fs.readdir(worktreesRoot, { withFileTypes: true }).catch(() => []);
    let deleted = 0;
    for (const fingerprint of fingerprints) {
      if (!fingerprint.isDirectory()) {
        continue;
      }
      const fingerprintPath = path.join(worktreesRoot, fingerprint.name);
      const names = await fs.readdir(fingerprintPath, { withFileTypes: true }).catch(() => []);
      for (const name of names) {
        if (!name.isDirectory()) {
          continue;
        }
        const candidate = path.join(fingerprintPath, name.name);
        if (managedPaths.has(path.resolve(candidate))) {
          continue;
        }
        const repository = await resolveRepository(candidate).catch(() => undefined);
        if (repository) {
          const listed = await listGitWorktrees(repository.repoRoot).catch(() => []);
          if (listed.some((entry) => path.resolve(entry.path) === path.resolve(candidate))) {
            // Live git worktrees are preserved, never adopted: background gc cannot tell a
            // crash orphan from a legitimate manual worktree without an owner-safe recovery
            // marker (schema-backed). Retried create() is the supported crash-recovery path.
            continue;
          }
        }
        await fs.rm(candidate, { recursive: true, force: true });
        deleted += 1;
      }
      await fs.rmdir(fingerprintPath).catch(() => undefined);
    }
    return deleted;
  }
}

export const managedWorktrees = new ManagedWorktreeService();

export type {
  CreateManagedWorktreeParams,
  ManagedWorktreeGcResult,
  ManagedWorktreeRecord,
  RemoveManagedWorktreeResult,
} from "./types.js";
