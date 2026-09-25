import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { insertRegistryWorktree } from "./registry.js";
import type { ManagedWorktreeOwnerKind, ManagedWorktreeRecord } from "./types.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

async function initializeRepository(repo: string): Promise<void> {
  await fs.mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "OpenClaw Test");
  await git(repo, "config", "user.email", "openclaw-test@example.invalid");
  await fs.writeFile(path.join(repo, "README.md"), "base\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
}

async function addRemote(root: string, repo: string): Promise<string> {
  const remote = path.join(root, "remote.git");
  await git(root, "init", "--bare", remote);
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "-u", "origin", "main");
  return await fs.realpath(repo);
}

export async function initializeManagedWorktreeTestRepository(root: string): Promise<string> {
  const repo = path.join(root, "repo");
  await initializeRepository(repo);
  return await addRemote(root, repo);
}

export function useManagedWorktreeTestRepository(): (root: string) => Promise<string> {
  const templateDirs = useAutoCleanupTempDirTracker(afterAll);
  let templateRoot: string;
  beforeAll(async () => {
    templateRoot = templateDirs.make("openclaw-worktree-template-");
    await initializeManagedWorktreeTestRepository(templateRoot);
  });

  // Copy the initial push too. Each case owns independent Git metadata and a
  // real remote; later fetches, pushes, locks, and state cannot reach the template.
  return async (root) => {
    const repo = path.join(root, "repo");
    await fs.cp(templateRoot, root, { recursive: true, mode: fsConstants.COPYFILE_FICLONE });
    await git(repo, "remote", "set-url", "origin", path.join(root, "remote.git"));
    return await fs.realpath(repo);
  };
}

async function copyProvisionedFiles(params: {
  repoRoot: string;
  worktreePath: string;
  provisionedPaths: readonly string[];
}): Promise<void> {
  for (const provisionedPath of params.provisionedPaths) {
    const source = path.join(params.repoRoot, provisionedPath);
    const target = path.join(params.worktreePath, provisionedPath);
    const sourceStat = await fs.lstat(source);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target, fsConstants.COPYFILE_FICLONE);
    if (process.platform !== "win32") {
      await fs.chmod(target, sourceStat.mode & 0o7777);
    }
  }
}

type ManagedWorktreeFixtureParams = {
  env: NodeJS.ProcessEnv;
  name: string;
  now: number;
  ownerKind?: ManagedWorktreeOwnerKind;
  ownerId?: string;
  provisionedPaths?: readonly string[];
  repoRoot: string;
  stateDir: string;
};

export async function materializeManagedWorktreeFixtures(
  params: Omit<ManagedWorktreeFixtureParams, "name"> & { names: string[] },
): Promise<ManagedWorktreeRecord[]> {
  const records = params.names.map((name): ManagedWorktreeRecord => ({
    id: `fixture-${name}`,
    name,
    repoFingerprint: "downstream-fixture",
    repoRoot: params.repoRoot,
    path: path.join(params.stateDir, "worktrees", "downstream-fixture", name),
    branch: `openclaw/${name}`,
    baseRef: "HEAD",
    ownerKind: params.ownerKind ?? "manual",
    ...(params.ownerId ? { ownerId: params.ownerId } : {}),
    createdAt: params.now,
    lastActiveAt: params.now,
  }));
  for (const record of records) {
    await fs.mkdir(path.dirname(record.path), { recursive: true });
  }
  const commands = records.map((record) => [
    "-C",
    record.repoRoot,
    "worktree",
    "add",
    "-b",
    record.branch,
    "--",
    record.path,
    "HEAD",
  ]);
  if (records.length > 1) {
    // Fork Git from a small process instead of the resident Vitest runtime.
    // Every fixture still has a real, independently registered Git worktree.
    const creation = execFileAsync(process.execPath, [
      "-e",
      `const { execFileSync } = require("node:child_process");
       const { readFileSync } = require("node:fs");
       for (const args of JSON.parse(readFileSync(0, "utf8"))) {
         execFileSync("git", args);
       }`,
    ]);
    creation.child.stdin?.end(JSON.stringify(commands));
    await creation;
  } else {
    for (const args of commands) {
      await execFileAsync("git", args);
    }
  }
  const provisionedPaths = params.provisionedPaths ?? [];
  for (const record of records) {
    await copyProvisionedFiles({
      repoRoot: record.repoRoot,
      worktreePath: record.path,
      provisionedPaths,
    });
  }
  const register = () => {
    for (const record of records) {
      insertRegistryWorktree(params.env, record, { provisionedPaths });
    }
  };
  if (records.length > 1) {
    // All asynchronous setup is complete before committing the fixture rows together.
    runOpenClawStateWriteTransaction(register, { env: params.env });
  } else {
    register();
  }
  return records;
}

export async function materializeManagedWorktreeFixture(
  params: ManagedWorktreeFixtureParams,
): Promise<ManagedWorktreeRecord> {
  const { name, ...shared } = params;
  return (await materializeManagedWorktreeFixtures({ ...shared, names: [name] }))[0]!;
}
