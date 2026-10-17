// QA Lab product proof for the managed-worktree child CLI lifecycle.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import type {
  ManagedWorktreeGcResult,
  ManagedWorktreeRecord,
  RemoveManagedWorktreeResult,
} from "../../../../src/agents/worktrees/types.js";
import { closeOpenClawStateDatabaseForTest } from "../../../../src/state/openclaw-state-db.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";

const execFileAsync = promisify(execFile);
const WORKTREE_NAME = "qa-managed-worktree";

type CommandResult = Awaited<ReturnType<OpenClawTestInstance["cli"]>>;
type WorktreeListJson = { worktrees: ManagedWorktreeRecord[] };

let instance: OpenClawTestInstance | undefined;
let tempRoot: string | undefined;

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await instance?.cleanup();
  instance = undefined;
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

async function worktrees<T>(...args: string[]): Promise<T> {
  if (!instance) {
    throw new Error("CLI fixture is not running");
  }
  const result: CommandResult = await instance.cli(["worktrees", ...args, "--json"]);
  if (result.code !== 0) {
    throw new Error(
      `worktrees ${args.join(" ")} failed with exit ${String(result.code)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout) as T;
}

async function expectProvisionedFiles(worktreePath: string) {
  const env = path.join(worktreePath, ".env.local");
  const tool = path.join(worktreePath, "generated", "tool.sh");
  await expect(fs.readFile(env, "utf8")).resolves.toBe("TOKEN=fixture\n");
  await expect(fs.readFile(tool, "utf8")).resolves.toContain("echo generated");
  expect((await fs.stat(env)).mode & 0o777).toBe(0o600);
  expect((await fs.stat(tool)).mode & 0o777).toBe(0o755);
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trimEnd();
}

async function initializeRepository(root: string): Promise<{ baseCommit: string; repo: string }> {
  const repo = path.join(root, "source");
  await fs.mkdir(path.join(repo, ".openclaw"), { recursive: true });
  await fs.mkdir(path.join(repo, "generated"), { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "OpenClaw Test");
  await git(repo, "config", "user.email", "openclaw-test@example.invalid");
  await fs.writeFile(path.join(repo, "README.md"), "base\n");
  await fs.writeFile(path.join(repo, ".gitignore"), ".env.local\ngenerated/\n");
  await fs.writeFile(path.join(repo, ".worktreeinclude"), ".env.local\ngenerated/**\n");
  const setupScript = path.join(repo, ".openclaw", "worktree-setup.sh");
  await fs.writeFile(
    setupScript,
    '#!/bin/sh\nset -eu\nprintf "%s\\n%s\\n" "$OPENCLAW_SOURCE_TREE_PATH" "$OPENCLAW_WORKTREE_PATH" > "$OPENCLAW_WORKTREE_PATH/setup-marker.txt"\n',
  );
  await fs.chmod(setupScript, 0o755);
  await git(repo, "add", "README.md", ".gitignore", ".worktreeinclude", setupScript);
  await git(repo, "commit", "-m", "initialize managed worktree fixture");

  await fs.writeFile(path.join(repo, ".env.local"), "TOKEN=fixture\n");
  await fs.chmod(path.join(repo, ".env.local"), 0o600);
  await fs.writeFile(path.join(repo, "generated", "tool.sh"), "#!/bin/sh\necho generated\n");
  await fs.chmod(path.join(repo, "generated", "tool.sh"), 0o755);

  return {
    baseCommit: await git(repo, "rev-parse", "HEAD"),
    repo: await fs.realpath(repo),
  };
}

it(
  "provisions, snapshots, restores, and preserves a manual worktree through gc",
  { timeout: 180_000 },
  async () => {
    const canonicalTmp = await fs.realpath(os.tmpdir());
    tempRoot = await fs.mkdtemp(path.join(canonicalTmp, "openclaw-managed-worktree-cli-"));
    const { baseCommit, repo } = await initializeRepository(tempRoot);
    instance = await createOpenClawTestInstance({ name: "qa-managed-worktree-cli" });
    const stateDir = await fs.realpath(instance.stateDir);

    const created = await worktrees<ManagedWorktreeRecord>(
      "create",
      repo,
      "--name",
      WORKTREE_NAME,
      "--base-ref",
      "HEAD",
    );
    expect(created).toMatchObject({
      name: WORKTREE_NAME,
      repoRoot: repo,
      branch: `openclaw/${WORKTREE_NAME}`,
      baseRef: "HEAD",
      ownerKind: "manual",
      id: expect.any(String),
      repoFingerprint: expect.any(String),
      createdAt: expect.any(Number),
      lastActiveAt: expect.any(Number),
    });
    expect(await fs.realpath(created.path)).toBe(
      path.join(stateDir, "worktrees", created.repoFingerprint, WORKTREE_NAME),
    );
    expect(await git(repo, "rev-parse", `refs/heads/${created.branch}`)).toBe(baseCommit);

    await expectProvisionedFiles(created.path);

    const setupPaths = (await fs.readFile(path.join(created.path, "setup-marker.txt"), "utf8"))
      .trim()
      .split("\n");
    expect(setupPaths).toHaveLength(2);
    expect(await fs.realpath(setupPaths[0]!)).toBe(repo);
    expect(await fs.realpath(setupPaths[1]!)).toBe(await fs.realpath(created.path));

    await fs.writeFile(path.join(created.path, "README.md"), "dirty tracked change\n");
    await fs.writeFile(path.join(created.path, "notes.txt"), "restored note\n");

    const removed = await worktrees<RemoveManagedWorktreeResult>("remove", created.id);
    const expectedSnapshotRef = `refs/openclaw/snapshots/${created.id}`;
    expect(removed).toEqual({ removed: true, snapshotRef: expectedSnapshotRef });
    const snapshotCommit = await git(repo, "rev-parse", expectedSnapshotRef);
    expect(await git(repo, "show-ref", "--verify", expectedSnapshotRef)).toContain(
      expectedSnapshotRef,
    );
    await expect(fs.access(created.path)).rejects.toMatchObject({ code: "ENOENT" });

    const removedList = await worktrees<WorktreeListJson>("list");
    expect(removedList.worktrees).toContainEqual(
      expect.objectContaining({ id: created.id, removedAt: expect.any(Number) }),
    );

    const restored = await worktrees<ManagedWorktreeRecord>("restore", created.id);
    expect(restored).toMatchObject({
      id: created.id,
      branch: created.branch,
      path: created.path,
    });
    expect(restored.removedAt).toBeUndefined();
    const status = await git(restored.path, "status", "--porcelain");
    expect(status.split("\n")).toEqual(expect.arrayContaining([" M README.md", "?? notes.txt"]));
    await expect(fs.readFile(path.join(restored.path, "README.md"), "utf8")).resolves.toBe(
      "dirty tracked change\n",
    );
    await expect(fs.readFile(path.join(restored.path, "notes.txt"), "utf8")).resolves.toBe(
      "restored note\n",
    );
    await expectProvisionedFiles(restored.path);
    expect(await git(repo, "rev-parse", `refs/heads/${created.branch}`)).toBe(baseCommit);
    expect((await git(repo, "log", "--format=%H", created.branch)).split("\n")).not.toContain(
      snapshotCommit,
    );

    const gc = await worktrees<ManagedWorktreeGcResult>("gc");
    expect(gc).toMatchObject({
      removed: [],
      orphansDeleted: expect.any(Number),
      snapshotsPruned: expect.any(Number),
    });
    const activeList = await worktrees<WorktreeListJson>("list");
    expect(activeList.worktrees).toContainEqual(
      expect.objectContaining({ id: created.id, ownerKind: "manual" }),
    );
    expect(
      activeList.worktrees.find((record) => record.id === created.id)?.removedAt,
    ).toBeUndefined();
    await fs.access(created.path);
  },
);
