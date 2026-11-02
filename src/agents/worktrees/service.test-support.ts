import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, assert, beforeAll } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { withWorktreeMutationLease } from "./allocation.js";
import { git } from "./git-fixture.test-support.js";
import { insertRegistryWorktree } from "./registry.js";
import {
  admitWorktreeRunLeaseInDatabase,
  type WorktreeRunLeaseRowInput,
} from "./run-lease-store.kernel.js";
import {
  listTemplatesAsync,
  markTemplateReadyAsync,
  releaseTemplateReaderAsync,
  retainTemplateReaderAsync,
} from "./template-registry-async.js";
import type { ManagedWorktreeRecord } from "./types.js";

const execFileAsync = promisify(execFile);

export { git } from "./git-fixture.test-support.js";

export function makeWorktreeRecord(
  repoRoot: string,
  id: string,
  overrides: Partial<ManagedWorktreeRecord> = {},
): ManagedWorktreeRecord {
  return {
    id,
    name: id,
    repoRoot,
    repoFingerprint: "0123456789abcdef",
    path: repoRoot,
    branch: id,
    baseRef: "HEAD",
    ownerKind: "session",
    createdAt: 1,
    lastActiveAt: 1,
    ...overrides,
  };
}

export async function seedWorktreeRunLease(
  env: NodeJS.ProcessEnv,
  record: ManagedWorktreeRecord,
  owner: Pick<WorktreeRunLeaseRowInput, "pid" | "startTime"> = {
    pid: process.pid,
    startTime: null,
  },
): Promise<void> {
  await insertRegistryWorktree(env, record);
  const input = { worktreeId: record.id, token: record.id, now: 1, ...owner };
  runOpenClawStateWriteTransaction(({ db }) => admitWorktreeRunLeaseInDatabase(db, input), { env });
}

export async function initializeManagedWorktreeTestRepository(root: string): Promise<string> {
  const repo = path.join(root, "repo");
  await fs.mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "OpenClaw Test");
  await git(repo, "config", "user.email", "openclaw-test@example.invalid");
  await fs.writeFile(path.join(repo, "README.md"), "base\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  const remote = path.join(root, "remote.git");
  await git(root, "init", "--bare", "-b", "main", remote);
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "-u", "origin", "main");
  return await fs.realpath(repo);
}

export function useManagedWorktreeTestRepository(
  prepare?: (repo: string) => Promise<void>,
): (root: string) => Promise<string> {
  const templateDirs = useAutoCleanupTempDirTracker(afterAll);
  let templateRoot: string;
  beforeAll(async () => {
    templateRoot = templateDirs.make("openclaw-worktree-template-");
    const repo = await initializeManagedWorktreeTestRepository(templateRoot);
    await prepare?.(repo);
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

type ManagedWorktreeFixtureParams = Pick<ManagedWorktreeRecord, "name" | "repoRoot"> &
  Partial<Pick<ManagedWorktreeRecord, "ownerKind" | "ownerId" | "repoFingerprint">> & {
    env: NodeJS.ProcessEnv;
    now: number;
    provisionedPaths?: readonly string[];
    stateDir: string;
  };

export async function materializeManagedWorktreeFixtures(
  params: Omit<ManagedWorktreeFixtureParams, "name"> & { names: string[] },
): Promise<ManagedWorktreeRecord[]> {
  const repoFingerprint = params.repoFingerprint ?? "downstream-fixture";
  const records = params.names.map((name) =>
    makeWorktreeRecord(params.repoRoot, `fixture-${name}`, {
      name,
      repoFingerprint,
      path: path.join(params.stateDir, "worktrees", repoFingerprint, name),
      branch: `openclaw/${name}`,
      ownerKind: params.ownerKind ?? "manual",
      ...(params.ownerId ? { ownerId: params.ownerId } : {}),
      createdAt: params.now,
      lastActiveAt: params.now,
    }),
  );
  for (const record of records) {
    await fs.mkdir(path.dirname(record.path), { recursive: true });
  }
  const commands = records.map(({ repoRoot, branch, path: target }) => [
    "-C",
    repoRoot,
    "worktree",
    "add",
    "-b",
    branch,
    "--",
    target,
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
    for (const provisionedPath of provisionedPaths) {
      const source = path.join(record.repoRoot, provisionedPath);
      const target = path.join(record.path, provisionedPath);
      const sourceStat = await fs.lstat(source);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target, fsConstants.COPYFILE_FICLONE);
      if (process.platform !== "win32") {
        await fs.chmod(target, sourceStat.mode & 0o7777);
      }
    }
  }
  for (const record of records) {
    await insertRegistryWorktree(params.env, record, { provisionedPaths });
  }
  return records;
}

export async function ageManagedWorktreeTemplates(
  env: NodeJS.ProcessEnv,
  lastUsedAt: number,
): Promise<void> {
  for (const template of await listTemplatesAsync(env)) {
    await withWorktreeMutationLease({ env, id: `template:${template.cacheKey}` }, async (guard) => {
      const key = `age-template:${template.id}`;
      const reader = {
        id: template.id,
        key,
        owner: { pid: process.pid, host: hostname(), startedAt: null },
        unpublish: true,
      } satisfies Parameters<typeof retainTemplateReaderAsync>[1];
      assert(await retainTemplateReaderAsync(env, reader, guard.commitGuard));
      try {
        assert(await markTemplateReadyAsync(env, template.id, lastUsedAt, guard.commitGuard));
      } finally {
        await releaseTemplateReaderAsync(env, key, guard.commitGuard);
      }
    });
  }
}

export async function materializeManagedWorktreeFixture(
  params: ManagedWorktreeFixtureParams,
): Promise<ManagedWorktreeRecord> {
  const { name, ...shared } = params;
  return (await materializeManagedWorktreeFixtures({ ...shared, names: [name] }))[0]!;
}
