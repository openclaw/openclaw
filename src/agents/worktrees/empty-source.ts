import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../config/state-dir.js";
import { mergeProcessEnv } from "../../infra/process-env.js";
import { listGitWorktrees, requireGit, worktreePathExists } from "./git.js";
import { listRegistryWorktrees } from "./registry.js";
import type { ManagedWorktreeRecord } from "./types.js";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const INITIAL_COMMIT = `tree ${EMPTY_TREE}\nauthor OpenClaw <openclaw@localhost> 0 +0000\ncommitter OpenClaw <openclaw@localhost> 0 +0000\n\nEmpty workspace\n`;
const INITIAL_COMMIT_ID = createHash("sha1")
  .update(`commit ${Buffer.byteLength(INITIAL_COMMIT)}\0${INITIAL_COMMIT}`)
  .digest("hex");

function sourceParent(env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), "worktree-sources", "empty");
}

function sourceName(ownerId: string): string {
  return createHash("sha256").update(ownerId).digest("hex");
}

async function validateSource(
  sourceRoot: string,
  gitOptions: Parameters<typeof requireGit>[2],
): Promise<void> {
  const root = await fs.lstat(sourceRoot);
  const metadata = await fs.lstat(path.join(sourceRoot, ".git"));
  const entries = await fs.readdir(sourceRoot);
  if (
    !root.isDirectory() ||
    !metadata.isDirectory() ||
    entries.length !== 1 ||
    entries[0] !== ".git" ||
    (await requireGit(sourceRoot, ["symbolic-ref", "HEAD"], gitOptions)) !== "refs/heads/main" ||
    (await requireGit(sourceRoot, ["rev-parse", "--verify", "HEAD^{commit}"], gitOptions)) !==
      INITIAL_COMMIT_ID ||
    (await requireGit(sourceRoot, ["status", "--porcelain=v1"], gitOptions)) !== ""
  ) {
    throw new Error("The empty workspace source has changed.");
  }
}

/** Called under the managed-worktree allocation lease, including source publication. */
export async function ensureEmptyWorktreeSource(params: {
  env: NodeJS.ProcessEnv;
  ownerId: string;
  signal?: AbortSignal;
  commitGuard: () => void;
}): Promise<string> {
  const { env, commitGuard } = params;
  // Each session owns its Git metadata as well as its files. Git configuration
  // and remote changes made by one empty task cannot affect another task.
  const gitEnv = Object.fromEntries(
    Object.entries(mergeProcessEnv([process.env, env])).filter(
      ([key]) => !key.toUpperCase().startsWith("GIT_"),
    ),
  );
  gitEnv.GIT_CONFIG_NOSYSTEM = "1";
  gitEnv.GIT_CONFIG_GLOBAL = os.devNull;
  gitEnv.GIT_NO_REPLACE_OBJECTS = "1";
  const gitOptions = {
    baseEnv: gitEnv,
    env: gitEnv,
    signal: params.signal,
    beforeRun: commitGuard,
  };
  params.signal?.throwIfAborted();
  commitGuard();
  await fs.mkdir(sourceParent(env), { recursive: true, mode: 0o700 });
  const ownerRoot = path.join(await fs.realpath(sourceParent(env)), sourceName(params.ownerId));
  const sourceRoot = path.join(ownerRoot, "workspace");
  if (!(await worktreePathExists(sourceRoot))) {
    if (
      listRegistryWorktrees(env).some((record) => path.relative(sourceRoot, record.repoRoot) === "")
    ) {
      throw new Error(
        `Empty workspace source is missing: ${sourceRoot}. Restore its original Git metadata before starting this workspace; existing session history and snapshots depend on it.`,
      );
    }
    commitGuard();
    await fs.mkdir(ownerRoot, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(ownerRoot)).isDirectory()) {
      throw new Error(`Empty workspace source parent is not a directory: ${ownerRoot}`);
    }
    commitGuard();
    const temporary = await fs.mkdtemp(path.join(ownerRoot, ".empty-"));
    try {
      await requireGit(
        temporary,
        ["init", "--quiet", "--template=", "--object-format=sha1", "-b", "main"],
        gitOptions,
      );
      await requireGit(temporary, ["hash-object", "-w", "-t", "tree", "--stdin"], {
        ...gitOptions,
        input: "",
      });
      await requireGit(temporary, ["hash-object", "-w", "-t", "commit", "--stdin"], {
        ...gitOptions,
        input: INITIAL_COMMIT,
      });
      await requireGit(temporary, ["update-ref", "refs/heads/main", INITIAL_COMMIT_ID], gitOptions);
      await validateSource(temporary, gitOptions);
      commitGuard();
      await fs.rename(temporary, sourceRoot);
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
      await fs.rmdir(ownerRoot).catch(() => undefined);
    }
    return sourceRoot;
  }

  try {
    await validateSource(sourceRoot, gitOptions);
  } catch (cause) {
    params.signal?.throwIfAborted();
    commitGuard();
    throw new Error(
      `Empty workspace source is unavailable or modified: ${sourceRoot}. Restore its original Git metadata and keep existing session files; OpenClaw will not recreate it over existing data.`,
      { cause },
    );
  }
  commitGuard();
  return sourceRoot;
}

async function resolveEmptyWorktreeSourceRoot(params: {
  env: NodeJS.ProcessEnv;
  record: Pick<ManagedWorktreeRecord, "repoRoot" | "ownerKind" | "ownerId">;
}): Promise<string | undefined> {
  const { env, record } = params;
  if (
    record.ownerKind !== "session" ||
    !record.ownerId ||
    !(await worktreePathExists(sourceParent(env)))
  ) {
    return undefined;
  }
  const ownerRoot = path.join(await fs.realpath(sourceParent(env)), sourceName(record.ownerId));
  const expected = path.join(ownerRoot, "workspace");
  return path.relative(expected, record.repoRoot) === "" ? expected : undefined;
}

/** Called under the allocation lease after failed creation or final snapshot expiry. */
export async function removeUnusedEmptyWorktreeSource(params: {
  env: NodeJS.ProcessEnv;
  record: Pick<ManagedWorktreeRecord, "repoRoot" | "ownerKind" | "ownerId"> & { id?: string };
  signal?: AbortSignal;
  commitGuard: () => void;
}): Promise<void> {
  const { env, record, commitGuard } = params;
  const expected = await resolveEmptyWorktreeSourceRoot(params);
  if (!expected || !(await worktreePathExists(expected))) {
    return;
  }
  const ownerRoot = path.dirname(expected);
  const otherRecords = listRegistryWorktrees(env).filter(
    (other) => other.id !== record.id && path.relative(expected, other.repoRoot) === "",
  );
  if (otherRecords.length > 0) {
    if (
      record.id &&
      !otherRecords.some(
        (other) => other.ownerKind === "session" && other.ownerId === record.ownerId,
      )
    ) {
      throw new Error(`Empty workspace source still has retained worktrees; preserved ${expected}`);
    }
    return;
  }
  const ownerDirectory = await fs.lstat(ownerRoot);
  const root = await fs.lstat(expected);
  const metadata = await fs.lstat(path.join(expected, ".git"));
  const entries = await fs.readdir(expected);
  if (
    !ownerDirectory.isDirectory() ||
    !root.isDirectory() ||
    !metadata.isDirectory() ||
    entries.length !== 1 ||
    entries[0] !== ".git"
  ) {
    throw new Error(`Empty workspace source contains unexpected files; preserved ${expected}`);
  }
  const worktrees = await listGitWorktrees(expected, {
    signal: params.signal,
    beforeRun: commitGuard,
  });
  if (worktrees.length !== 1 || path.relative(expected, worktrees[0]!.path) !== "") {
    throw new Error(`Empty workspace source still has linked worktrees; preserved ${expected}`);
  }
  commitGuard();
  await fs.rm(expected, { recursive: true });
  commitGuard();
  await fs.rmdir(ownerRoot).catch(() => undefined);
}
