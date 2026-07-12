import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  deleteRegistryWorktree,
  findRegistryWorktreeByPath,
  getRegistryWorktree,
  insertRegistryWorktree,
  listRegistryWorktrees,
  updateRegistryWorktree,
} from "./registry.js";
import { acquireWorktreeRunLease } from "./run-lease.js";
import {
  IDLE_GC_MS,
  ManagedWorktreeService,
  PROVISIONING_HEARTBEAT_MS,
  PROVISIONING_STALE_MS,
  SNAPSHOT_RETENTION_MS,
} from "./service.js";
import type { ManagedWorktreeRecord } from "./types.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

async function gitWithInput(cwd: string, args: string[], input: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = execFile("git", ["-C", cwd, ...args], { encoding: "utf8" }, (error, stdout) => {
      if (error) {
        reject(new Error(error.message, { cause: error }));
      } else {
        resolve(stdout.trim());
      }
    });
    child.stdin?.end(input);
  });
}

async function initializeRepository(root: string, name = "repo"): Promise<string> {
  const repo = path.join(root, name);
  await fs.mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "OpenClaw Test");
  await git(repo, "config", "user.email", "openclaw-test@example.invalid");
  await fs.writeFile(path.join(repo, "README.md"), "base\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  return await fs.realpath(repo);
}

async function addRemote(root: string, repo: string): Promise<string> {
  const remote = path.join(root, "remote.git");
  await execFileAsync("git", ["clone", "--bare", repo, remote]);
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "-u", "origin", "main");
  await git(repo, "remote", "set-head", "origin", "-a");
  return remote;
}

describe("ManagedWorktreeService", () => {
  let templateRoot: string;
  let templateRepo: string;
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let now: number;
  let service: ManagedWorktreeService;

  beforeAll(async () => {
    const tempRoot = await fs.realpath(os.tmpdir());
    templateRoot = await fs.mkdtemp(path.join(tempRoot, "openclaw-managed-worktrees-template-"));
    templateRepo = await initializeRepository(templateRoot);
  });

  afterAll(async () => {
    await fs.rm(templateRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const tempRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(tempRoot, "openclaw-managed-worktrees-"));
    repo = path.join(root, "repo");
    await fs.cp(templateRepo, repo, { recursive: true });
    repo = await fs.realpath(repo);
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "openclaw-state") };
    now = 1_700_000_000_000;
    service = new ManagedWorktreeService({ env, now: () => now });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("creates from origin HEAD and returns the existing live named worktree", async () => {
    await addRemote(root, repo);
    const created = await service.create({ repoRoot: repo, name: "remote-task" });
    const repeated = await service.create({ repoRoot: repo, name: "remote-task" });

    expect(created.baseRef).toBe("origin/main");
    expect(created.branch).toBe("openclaw/remote-task");
    expect(created.path).toContain(path.join("worktrees", created.repoFingerprint, "remote-task"));
    expect(await git(created.path, "branch", "--show-current")).toBe(created.branch);
    expect(repeated).toEqual(created);
  });

  it("lists repository branches default-first with deterministic ordering", async () => {
    await addRemote(root, repo);
    await git(repo, "branch", "feature-a");
    await git(repo, "push", "origin", "feature-a");
    await git(repo, "branch", "-D", "feature-a");
    await git(repo, "branch", "zeta-local");
    await git(repo, "checkout", "-b", "current-work");

    const result = await service.listRepositoryBranches(repo);
    expect(result.defaultBranch).toBe("main");
    expect(result.headBranch).toBe("current-work");
    // Remote-only branches keep their remote-qualified form so the returned
    // name always resolves as a git worktree base ref.
    expect(result.branches.map((branch) => branch.name)).toEqual([
      "main",
      "current-work",
      "origin/feature-a",
      "zeta-local",
    ]);
    expect(result.branches.find((branch) => branch.name === "origin/feature-a")?.kind).toBe(
      "remote",
    );
    expect(result.branches.find((branch) => branch.name === "main")?.kind).toBe("local");
  });

  it("creates a worktree from a remote-only branch ref returned by the picker", async () => {
    await addRemote(root, repo);
    await git(repo, "checkout", "-b", "remote-only");
    await fs.writeFile(path.join(repo, "remote-only.txt"), "remote\n");
    await git(repo, "add", "remote-only.txt");
    await git(repo, "commit", "-m", "remote only commit");
    await git(repo, "push", "origin", "remote-only");
    const remoteCommit = await git(repo, "rev-parse", "HEAD");
    await git(repo, "checkout", "main");
    await git(repo, "branch", "-D", "remote-only");

    const listed = await service.listRepositoryBranches(repo);
    const remoteRef = listed.branches.find((branch) => branch.kind === "remote")?.name;
    expect(remoteRef).toBe("origin/remote-only");
    const created = await service.create({
      repoRoot: repo,
      name: "from-remote",
      baseRef: remoteRef,
    });
    expect(await git(created.path, "rev-parse", "HEAD")).toBe(remoteCommit);
    expect(
      await git(created.path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"),
    ).toBe("origin/remote-only");
  });

  it("lists local branches without a remote", async () => {
    await git(repo, "branch", "side");
    const result = await service.listRepositoryBranches(repo);
    expect(result.defaultBranch).toBeUndefined();
    expect(result.headBranch).toBe("main");
    expect(result.branches.map((branch) => branch.name)).toEqual(["main", "side"]);
    expect(result.branches.every((branch) => branch.kind === "local")).toBe(true);
  });

  it("creates a worktree from an explicit base ref", async () => {
    await git(repo, "checkout", "-b", "base-branch");
    await fs.writeFile(path.join(repo, "base.txt"), "base branch file\n");
    await git(repo, "add", "base.txt");
    await git(repo, "commit", "-m", "base branch commit");
    const baseCommit = await git(repo, "rev-parse", "HEAD");
    await git(repo, "checkout", "main");

    const created = await service.create({
      repoRoot: repo,
      name: "based-task",
      baseRef: "base-branch",
    });
    expect(created.baseRef).toBe("base-branch");
    expect(await git(created.path, "rev-parse", "HEAD")).toBe(baseCommit);
  });

  it("normalizes dashed refs and revision expressions before creating branches", async () => {
    const initialCommit = await git(repo, "rev-parse", "HEAD");
    await fs.writeFile(path.join(repo, "history.txt"), "second\n");
    await git(repo, "add", "history.txt");
    await git(repo, "commit", "-m", "second commit");
    const secondCommit = await git(repo, "rev-parse", "HEAD");
    await fs.appendFile(path.join(repo, "history.txt"), "third\n");
    await git(repo, "add", "history.txt");
    await git(repo, "commit", "-m", "third commit");
    const thirdCommit = await git(repo, "rev-parse", "HEAD");
    await git(repo, "update-ref", "refs/tags/--force", thirdCommit);
    await git(repo, "reset", "--hard", initialCommit);

    const fromRef = await service.create({
      repoRoot: repo,
      name: "dashed-ref",
      baseRef: "--force",
    });
    const fromExpression = await service.create({
      repoRoot: repo,
      name: "dashed-expression",
      baseRef: "--force~1",
    });

    expect(fromRef.baseRef).toBe("--force");
    expect(await git(fromRef.path, "rev-parse", "HEAD")).toBe(thirdCommit);
    expect(fromExpression.baseRef).toBe("--force~1");
    expect(await git(fromExpression.path, "rev-parse", "HEAD")).toBe(secondCommit);
  });

  it("preserves Git's bare-dash previous-checkout shorthand", async () => {
    await git(repo, "checkout", "-b", "previous");
    await fs.writeFile(path.join(repo, "previous.txt"), "previous\n");
    await git(repo, "add", "previous.txt");
    await git(repo, "commit", "-m", "previous checkout commit");
    const previousCommit = await git(repo, "rev-parse", "HEAD");
    await git(repo, "checkout", "main");

    const created = await service.create({
      repoRoot: repo,
      name: "previous-checkout",
      baseRef: "-",
    });

    expect(created.baseRef).toBe("-");
    expect(await git(created.path, "rev-parse", "HEAD")).toBe(previousCommit);
  });

  it("rejects ambiguous dashed refs instead of choosing by ref precedence", async () => {
    const initialCommit = await git(repo, "rev-parse", "HEAD");
    await fs.writeFile(path.join(repo, "tag.txt"), "tag\n");
    await git(repo, "add", "tag.txt");
    await git(repo, "commit", "-m", "tag candidate");
    const tagCommit = await git(repo, "rev-parse", "HEAD");
    await git(repo, "reset", "--hard", initialCommit);
    await fs.writeFile(path.join(repo, "branch.txt"), "branch\n");
    await git(repo, "add", "branch.txt");
    await git(repo, "commit", "-m", "branch candidate");
    const branchCommit = await git(repo, "rev-parse", "HEAD");
    await git(repo, "update-ref", "refs/tags/--ambiguous", tagCommit);
    await git(repo, "update-ref", "refs/heads/--ambiguous", branchCommit);
    await git(repo, "config", "core.warnAmbiguousRefs", "false");

    await expect(
      service.create({
        repoRoot: repo,
        name: "ambiguous-ref",
        baseRef: "--ambiguous",
      }),
    ).rejects.toThrow(/git rev-parse --symbolic-full-name --verify failed/);

    expect(await git(repo, "branch", "--list", "openclaw/ambiguous-ref")).toBe("");
    expect(await service.list()).toEqual([]);
  });

  it.each(["--lock", "--orphan"])(
    "rejects absent dashed base %s without creating worktree state",
    async (baseRef) => {
      const before = await git(repo, "worktree", "list", "--porcelain");
      const name = baseRef.slice(2);

      await expect(service.create({ repoRoot: repo, name, baseRef })).rejects.toThrow(
        /git rev-parse --symbolic-full-name --verify failed/,
      );

      expect(await git(repo, "worktree", "list", "--porcelain")).toBe(before);
      expect(await git(repo, "branch", "--list", `openclaw/${name}`)).toBe("");
      expect(await service.list()).toEqual([]);
      await expect(fs.stat(path.join(env.OPENCLAW_STATE_DIR!, "worktrees"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("rejects name reuse across owners instead of adopting a foreign worktree", async () => {
    await service.create({
      repoRoot: repo,
      name: "shared-name",
      ownerKind: "session",
      ownerId: "agent:main:dashboard:one",
    });
    await expect(
      service.create({
        repoRoot: repo,
        name: "shared-name",
        ownerKind: "session",
        ownerId: "agent:main:dashboard:two",
      }),
    ).rejects.toThrow(/already in use by session/);
    await expect(service.create({ repoRoot: repo, name: "shared-name" })).rejects.toThrow(
      /already in use by session/,
    );
    // The rightful owner still reuses its record.
    const reused = await service.create({
      repoRoot: repo,
      name: "shared-name",
      ownerKind: "session",
      ownerId: "agent:main:dashboard:one",
    });
    expect(reused.ownerId).toBe("agent:main:dashboard:one");
  });

  it("does not remove a concurrent successful create during remote fallback", async () => {
    await addRemote(root, repo);

    const results = await Promise.allSettled([
      service.create({ repoRoot: repo, name: "concurrent" }),
      service.create({ repoRoot: repo, name: "concurrent" }),
    ]);
    const created = results.find(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.create>>> =>
        result.status === "fulfilled",
    )?.value;

    expect(created).toBeDefined();
    if (!created) {
      throw new Error("expected one concurrent create to succeed");
    }
    expect(await git(repo, "worktree", "list", "--porcelain")).toContain(created.path);
    expect(await git(created.path, "branch", "--show-current")).toBe("openclaw/concurrent");
  });

  it("falls back to local HEAD when fetch fails", async () => {
    await git(repo, "remote", "add", "origin", path.join(root, "missing.git"));
    const created = await service.create({ repoRoot: repo, name: "offline" });
    expect(created.baseRef).toBe("HEAD");
    expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
  });

  it("keeps registry operations anchored to the primary checkout", async () => {
    const linked = path.join(root, "linked-source");
    await git(repo, "worktree", "add", "-b", "linked-source", linked, "HEAD");
    const linkedRoot = await fs.realpath(linked);
    const created = await service.create({ repoRoot: linkedRoot, name: "linked-task" });
    expect(created.repoRoot).toBe(repo);
    await git(repo, "worktree", "remove", "--force", linkedRoot);

    await service.acquire(created.id);
    await service.release(created.id);
    await service.remove({ id: created.id, reason: "linked-source-removed" });
    const restored = await service.restore({ id: created.id });

    expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe("base\n");
  });

  it("retries worktree add from local HEAD when the resolved remote base is stale", async () => {
    await addRemote(root, repo);
    const blob = await git(repo, "rev-parse", "HEAD:README.md");
    const tooLongForCheckout = "x".repeat(300);
    const tree = await gitWithInput(
      repo,
      ["mktree"],
      `100644 blob ${blob}\t${tooLongForCheckout}\n`,
    );
    const remoteCommit = await git(repo, "commit-tree", tree, "-p", "HEAD", "-m", "bad remote");
    await git(repo, "push", "--force", "origin", `${remoteCommit}:refs/heads/main`);
    const created = await service.create({ repoRoot: repo, name: "stale-remote" });
    expect(created.baseRef).toBe("HEAD");
    expect(await git(created.path, "rev-parse", "HEAD")).toBe(await git(repo, "rev-parse", "HEAD"));
  });

  it("preserves a pre-existing branch when a managed name collides", async () => {
    await addRemote(root, repo);
    await git(repo, "branch", "openclaw/existing-name", "HEAD");
    const branchTip = await git(repo, "rev-parse", "openclaw/existing-name");

    await expect(service.create({ repoRoot: repo, name: "existing-name" })).rejects.toThrow(
      "branch already exists",
    );

    expect(await git(repo, "rev-parse", "openclaw/existing-name")).toBe(branchTip);
  });

  it("copies only included ignored regular files without following symlinks", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), "cache/\nlinked\nlinked-dir/\n");
    await fs.writeFile(path.join(repo, ".worktreeinclude"), "cache/*.txt\nlinked\nlinked-dir/**\n");
    await fs.mkdir(path.join(repo, "cache"));
    await fs.writeFile(path.join(repo, "cache", "keep.txt"), "keep\n", { mode: 0o744 });
    await fs.writeFile(path.join(repo, "cache", "skip.bin"), "skip\n");
    const outside = path.join(root, "outside.txt");
    await fs.writeFile(outside, "secret\n");
    await fs.symlink(outside, path.join(repo, "linked"));
    const outsideDir = path.join(root, "outside-dir");
    await fs.mkdir(outsideDir);
    await fs.writeFile(path.join(outsideDir, "escape.txt"), "secret\n");
    await fs.symlink(outsideDir, path.join(repo, "linked-dir"));

    const created = await service.create({ repoRoot: repo, name: "includes" });
    const copied = path.join(created.path, "cache", "keep.txt");
    expect(await fs.readFile(copied, "utf8")).toBe("keep\n");
    expect((await fs.stat(copied)).mode & 0o777).toBe(0o744);
    await expect(fs.stat(path.join(created.path, "cache", "skip.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(path.join(created.path, "linked"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.stat(path.join(created.path, "linked-dir", "escape.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never overwrites a base-ref file with an ignored source candidate", async () => {
    await fs.writeFile(path.join(repo, "collision.txt"), "from base\n");
    await git(repo, "add", "collision.txt");
    await git(repo, "commit", "-m", "base collision");
    await git(repo, "checkout", "-b", "source");
    await git(repo, "rm", "collision.txt");
    await fs.writeFile(path.join(repo, ".gitignore"), "collision.txt\n");
    await git(repo, "add", ".gitignore");
    await git(repo, "commit", "-m", "ignore local collision");
    await fs.writeFile(path.join(repo, "collision.txt"), "from source\n");
    await fs.writeFile(path.join(repo, ".worktreeinclude"), "collision.txt\n");

    const created = await service.create({
      repoRoot: repo,
      name: "no-overwrite",
      baseRef: "main",
    });

    expect(await fs.readFile(path.join(created.path, "collision.txt"), "utf8")).toBe("from base\n");
  });

  it("runs an executable setup script with source and worktree paths", async () => {
    await fs.mkdir(path.join(repo, ".openclaw"));
    const script = path.join(repo, ".openclaw", "worktree-setup.sh");
    await fs.writeFile(
      script,
      '#!/bin/sh\nprintf "%s\\n%s\\n" "$OPENCLAW_SOURCE_TREE_PATH" "$OPENCLAW_WORKTREE_PATH" > setup-paths.txt\n',
      { mode: 0o755 },
    );
    const created = await service.create({ repoRoot: repo, name: "setup" });
    expect(
      (await fs.readFile(path.join(created.path, "setup-paths.txt"), "utf8")).split("\n"),
    ).toEqual([repo, created.path, ""]);
  });

  it("removes the worktree and branch when setup fails", async () => {
    await fs.mkdir(path.join(repo, ".openclaw"));
    const script = path.join(repo, ".openclaw", "worktree-setup.sh");
    await fs.writeFile(script, "#!/bin/sh\necho setup-broke >&2\nexit 9\n", { mode: 0o755 });
    await expect(service.create({ repoRoot: repo, name: "broken-setup" })).rejects.toThrow(
      "setup-broke",
    );
    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain("broken-setup");
    expect(await git(repo, "branch", "--list", "openclaw/broken-setup")).toBe("");
  });

  it("restores tracked and untracked state while reprovisioning ignored files", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), "ignored.txt\nprovisioned.env\n");
    await fs.writeFile(path.join(repo, ".worktreeinclude"), "provisioned.env\n");
    await git(repo, "add", ".gitignore", ".worktreeinclude");
    await git(repo, "commit", "-m", "configure worktree provisioning");
    await fs.writeFile(path.join(repo, "provisioned.env"), "source secret\n");
    const created = await service.create({ repoRoot: repo, name: "roundtrip" });
    const originalHead = await git(created.path, "rev-parse", "HEAD");
    await fs.writeFile(path.join(created.path, "README.md"), "changed\n");
    await fs.writeFile(path.join(created.path, "untracked.txt"), "untracked\n");
    await fs.writeFile(path.join(created.path, "ignored.txt"), "ignored\n");

    const removed = await service.remove({ id: created.id, reason: "test" });
    expect(removed).toMatchObject({ removed: true, snapshotRef: expect.any(String) });
    await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(repo, "show-ref", "--verify", removed.snapshotRef!)).not.toBe("");
    const snapshotFiles = await git(repo, "ls-tree", "-r", "--name-only", removed.snapshotRef!);
    expect(snapshotFiles).not.toContain("ignored.txt");
    expect(snapshotFiles).not.toContain("provisioned.env");

    now += IDLE_GC_MS + 1;
    const restored = await service.restore({ id: created.id });
    expect(restored.removedAt).toBeUndefined();
    expect(restored.lastActiveAt).toBe(now);
    expect((await service.gc()).removed).toEqual([]);
    expect(await git(restored.path, "branch", "--show-current")).toBe(created.branch);
    expect(await git(restored.path, "rev-parse", "HEAD")).toBe(originalHead);
    expect(await git(restored.path, "log", "--format=%s", created.branch)).not.toContain(
      "OpenClaw worktree snapshot",
    );
    expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe("changed\n");
    expect(await fs.readFile(path.join(restored.path, "untracked.txt"), "utf8")).toBe(
      "untracked\n",
    );
    expect(await fs.readFile(path.join(restored.path, "provisioned.env"), "utf8")).toBe(
      "source secret\n",
    );
    await expect(fs.stat(path.join(restored.path, "ignored.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await git(restored.path, "status", "--porcelain")).split("\n")).toEqual([
      "M README.md",
      "?? untracked.txt",
    ]);
    expect(await git(restored.path, "diff", "--cached", "--name-only")).toBe("");
    expect(await git(restored.path, "diff", "--name-only")).toBe("README.md");
  });

  it("refuses to overwrite a branch recreated before restore", async () => {
    const created = await service.create({ repoRoot: repo, name: "restore-collision" });
    await service.remove({ id: created.id, reason: "test" });
    await git(repo, "branch", created.branch, "HEAD");
    const branchTip = await git(repo, "rev-parse", created.branch);

    await expect(service.restore({ id: created.id })).rejects.toThrow("already exists");

    expect(await git(repo, "rev-parse", created.branch)).toBe(branchTip);
    await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when a nested repository cannot be captured in full", async () => {
    const created = await service.create({ repoRoot: repo, name: "nested-repository" });
    const nested = await initializeRepository(created.path, "nested");
    await fs.writeFile(path.join(nested, "untracked-secret.txt"), "do not lose\n");

    await expect(service.remove({ id: created.id, reason: "test" })).rejects.toThrow(
      "nested git repositories cannot be snapshotted losslessly",
    );

    expect(await fs.readFile(path.join(nested, "untracked-secret.txt"), "utf8")).toBe(
      "do not lose\n",
    );
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
  });

  it("rematerializes a named workboard checkout from its retained snapshot", async () => {
    const created = await service.create({
      repoRoot: repo,
      name: "wb-card",
      ownerKind: "workboard",
      ownerId: "card",
    });
    await fs.writeFile(path.join(created.path, "worker.txt"), "worker state\n");
    await service.remove({ id: created.id, reason: "run-end" });

    const reusedFromSource = await service.create({
      repoRoot: repo,
      name: "wb-card",
      baseRef: created.branch,
      ownerKind: "workboard",
      ownerId: "card",
    });

    expect(reusedFromSource.id).toBe(created.id);
    expect(await fs.readFile(path.join(reusedFromSource.path, "worker.txt"), "utf8")).toBe(
      "worker state\n",
    );
  });

  it("removes lossless run-end worktrees but keeps dirty and unpushed work", async () => {
    await addRemote(root, repo);
    const clean = await service.create({ repoRoot: repo, name: "clean" });
    await service.acquire(clean.id);
    expect(await service.removeIfLossless(clean.id)).toBe(true);

    const dirty = await service.create({ repoRoot: repo, name: "dirty" });
    await service.acquire(dirty.id);
    await fs.writeFile(path.join(dirty.path, "dirty.txt"), "dirty\n");
    expect(await service.removeIfLossless(dirty.id)).toBe(false);
    expect(
      (await service.list()).find((entry) => entry.id === dirty.id)?.removedAt,
    ).toBeUndefined();

    const committed = await service.create({ repoRoot: repo, name: "committed" });
    await service.acquire(committed.id);
    await fs.writeFile(path.join(committed.path, "commit.txt"), "commit\n");
    await git(committed.path, "add", "commit.txt");
    await git(committed.path, "commit", "-m", "unpushed");
    expect(await service.removeIfLossless(committed.id)).toBe(false);
  });

  it("exempts manual worktrees and garbage collects idle run-owned worktrees", async () => {
    const manual = await service.create({ repoRoot: repo, name: "manual-idle" });
    const created = await service.create({
      repoRoot: repo,
      name: "idle-dead",
      ownerKind: "workboard",
    });
    await git(repo, "worktree", "lock", "--reason", "openclaw pid=999999", created.path);
    now += IDLE_GC_MS + 1;

    const result = await service.gc();
    expect(result.removed).toEqual([created.id]);
    expect(getRegistryWorktree(env, created.id)?.snapshotRef).toBeTruthy();
    expect(getRegistryWorktree(env, manual.id)?.removedAt).toBeUndefined();
    expect(await fs.stat(manual.path)).toBeTruthy();
  });

  it("uses owner activity to protect only active idle session worktrees", async () => {
    const active = await service.create({
      repoRoot: repo,
      name: "active-session",
      ownerKind: "session",
      ownerId: "agent:main:active",
    });
    const inactive = await service.create({
      repoRoot: repo,
      name: "inactive-session",
      ownerKind: "session",
      ownerId: "agent:main:inactive",
    });
    now += IDLE_GC_MS + 1;
    const isOwnerActive = vi.fn(
      (_ownerKind: string, ownerId: string) => ownerId === "agent:main:active",
    );

    const result = await service.gc({ isOwnerActive });

    expect(result.removed).toEqual([inactive.id]);
    expect(isOwnerActive).toHaveBeenCalledWith("session", "agent:main:active");
    expect(isOwnerActive).toHaveBeenCalledWith("session", "agent:main:inactive");
    expect(getRegistryWorktree(env, active.id)?.removedAt).toBeUndefined();
    expect(getRegistryWorktree(env, inactive.id)?.removedAt).toBeDefined();
  });

  it("protects foreign locks during idle garbage collection", async () => {
    const created = await service.create({
      repoRoot: repo,
      name: "foreign-lock",
      ownerKind: "session",
    });
    await git(repo, "worktree", "lock", "--reason", "other-tool", created.path);
    now += IDLE_GC_MS + 1;

    expect((await service.gc()).removed).toEqual([]);
    expect(await fs.stat(created.path)).toBeTruthy();
  });

  it("continues garbage collection after one worktree cannot be snapshotted", async () => {
    const removable = await service.create({
      repoRoot: repo,
      name: "removable",
      ownerKind: "workboard",
    });
    now += 1;
    const nestedRecord = await service.create({
      repoRoot: repo,
      name: "nested-idle",
      ownerKind: "workboard",
    });
    await initializeRepository(nestedRecord.path, "nested");
    now += IDLE_GC_MS + 1;

    const result = await service.gc();

    expect(result.removed).toEqual([removable.id]);
    expect(getRegistryWorktree(env, nestedRecord.id)?.removedAt).toBeUndefined();
    await expect(fs.stat(removable.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("continues garbage collection when one repository control path is missing", async () => {
    const otherRepo = await initializeRepository(root, "other-repo");
    const removable = await service.create({
      repoRoot: otherRepo,
      name: "other-removable",
      ownerKind: "session",
    });
    now += 1;
    const broken = await service.create({
      repoRoot: repo,
      name: "missing-control",
      ownerKind: "session",
    });
    await fs.rename(repo, path.join(root, "moved-repo"));
    now += IDLE_GC_MS + 1;

    const result = await service.gc();

    expect(result.removed).toEqual([removable.id]);
    expect(getRegistryWorktree(env, broken.id)?.removedAt).toBeUndefined();
  });

  it("deletes unregistered orphan debris but preserves git-listed worktrees", async () => {
    const debris = path.join(env.OPENCLAW_STATE_DIR!, "worktrees", "orphan-fingerprint", "debris");
    await fs.mkdir(debris, { recursive: true });
    await fs.writeFile(path.join(debris, "file"), "debris");
    const foreign = path.join(env.OPENCLAW_STATE_DIR!, "worktrees", "foreign-fingerprint", "live");
    await fs.mkdir(path.dirname(foreign), { recursive: true });
    await git(repo, "worktree", "add", "--detach", foreign, "HEAD");

    const result = await service.gc();
    expect(result.orphansDeleted).toBe(1);
    await expect(fs.stat(debris)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.stat(foreign)).toBeTruthy();
    await git(repo, "worktree", "remove", "--force", foreign);
  });

  it("adopts an orphaned worktree instead of throwing on a retried create() with the same name", async () => {
    const created = await service.create({
      repoRoot: repo,
      name: "orphan-retry",
      ownerKind: "workboard",
      ownerId: "card-42",
    });
    // Deleting the row reproduces the only remaining no-row crash window (between
    // `git worktree add` and the claim, which runs no user code) and pre-fix orphans.
    deleteRegistryWorktree(env, created.id);

    const retried = await service.create({
      repoRoot: repo,
      name: "orphan-retry",
      ownerKind: "workboard",
      ownerId: "card-42",
    });

    expect(retried.path).toBe(created.path);
    expect(retried.branch).toBe(created.branch);
    expect(retried.id).not.toBe(created.id);
    // The retry's owner must survive adoption so findLiveByOwner() and idle-gc still apply.
    expect(retried.ownerKind).toBe("workboard");
    expect(retried.ownerId).toBe("card-42");
    expect(getRegistryWorktree(env, retried.id)).toMatchObject({
      ownerKind: "workboard",
      ownerId: "card-42",
    });
    expect(service.findLiveByOwner("workboard", "card-42")?.id).toBe(retried.id);
    expect(await git(created.path, "branch", "--show-current")).toBe(created.branch);
  });

  it("re-runs provisioning when a retried create() adopts a pre-setup crash orphan", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), "included.env\n");
    await fs.writeFile(path.join(repo, ".worktreeinclude"), "included.env\n");
    await fs.writeFile(path.join(repo, "included.env"), "provisioned\n");
    await fs.mkdir(path.join(repo, ".openclaw"));
    await fs.writeFile(
      path.join(repo, ".openclaw", "worktree-setup.sh"),
      "#!/bin/sh\necho ran > setup-marker.txt\n",
      { mode: 0o755 },
    );
    const created = await service.create({ repoRoot: repo, name: "orphan-setup", baseRef: "main" });
    // Simulates a crash after `git worktree add` but before copy/setup and the registry insert:
    // undo the provisioning artifacts the initial create() produced and drop its registry row.
    deleteRegistryWorktree(env, created.id);
    await fs.rm(path.join(created.path, "included.env"));
    await fs.rm(path.join(created.path, "setup-marker.txt"));

    const retried = await service.create({ repoRoot: repo, name: "orphan-setup", baseRef: "main" });

    expect(retried.path).toBe(created.path);
    expect(retried.baseRef).toBe("main");
    expect(await fs.readFile(path.join(retried.path, "included.env"), "utf8")).toBe(
      "provisioned\n",
    );
    expect(await fs.readFile(path.join(retried.path, "setup-marker.txt"), "utf8")).toBe("ran\n");
  });

  it("cleans up instead of adopting when provisioning fails on the retried create()", async () => {
    await fs.mkdir(path.join(repo, ".openclaw"));
    await fs.writeFile(
      path.join(repo, ".openclaw", "worktree-setup.sh"),
      '#!/bin/sh\nif [ -f "$OPENCLAW_SOURCE_TREE_PATH/fail-setup" ]; then\n  echo setup-broke >&2\n  exit 9\nfi\nexit 0\n',
      { mode: 0o755 },
    );
    const created = await service.create({ repoRoot: repo, name: "orphan-refail" });
    deleteRegistryWorktree(env, created.id);
    await fs.writeFile(path.join(repo, "fail-setup"), "");

    await expect(service.create({ repoRoot: repo, name: "orphan-refail" })).rejects.toThrow(
      "setup-broke",
    );

    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain(created.path);
    expect(await git(repo, "branch", "--list", "openclaw/orphan-refail")).toBe("");
    await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(findRegistryWorktreeByPath(env, created.path)).toBeUndefined();
  });

  it("retried create() returns the concurrent winner's record instead of double-registering", async () => {
    const created = await service.create({ repoRoot: repo, name: "race-retry" });
    deleteRegistryWorktree(env, created.id);
    const winner: ManagedWorktreeRecord = { ...created, id: "race-winner" };
    let raced = false;
    // The first now() read inside the retried create() is adoptOrphan's createdAt, taken
    // right before the atomic claim (which precedes provisioning); the trapdoor inserts the
    // competing row there, deterministically simulating a concurrent create() winning the
    // path after this call's registry lookup.
    const racingService = new ManagedWorktreeService({
      env,
      now: () => {
        if (!raced) {
          raced = true;
          insertRegistryWorktree(env, winner);
        }
        return now;
      },
    });

    const retried = await racingService.create({ repoRoot: repo, name: "race-retry" });

    expect(retried.id).toBe("race-winner");
    const rows = listRegistryWorktrees(env).filter((entry) => entry.path === created.path);
    expect(rows.map((entry) => entry.id)).toEqual(["race-winner"]);
  });

  it("a losing retried create() does not provision or destroy the winner's worktree", async () => {
    await fs.mkdir(path.join(repo, ".openclaw"));
    await fs.writeFile(
      path.join(repo, ".openclaw", "worktree-setup.sh"),
      "#!/bin/sh\necho ran >> setup-marker.txt\n",
      { mode: 0o755 },
    );
    const created = await service.create({ repoRoot: repo, name: "race-loser" });
    deleteRegistryWorktree(env, created.id);
    // Pre-setup crash signature: the marker the initial create() wrote is gone.
    await fs.rm(path.join(created.path, "setup-marker.txt"));
    const winner: ManagedWorktreeRecord = { ...created, id: "race-winner" };
    let raced = false;
    const racingService = new ManagedWorktreeService({
      env,
      now: () => {
        if (!raced) {
          raced = true;
          insertRegistryWorktree(env, winner);
        }
        return now;
      },
    });

    const retried = await racingService.create({ repoRoot: repo, name: "race-loser" });

    expect(retried.id).toBe("race-winner");
    // Claim-before-provision: the loser ran no setup, no copy, and no cleanup on the
    // winner's path, and left the registry row set untouched.
    await expect(fs.stat(path.join(created.path, "setup-marker.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.stat(created.path)).toBeTruthy();
    const rows = listRegistryWorktrees(env).filter((entry) => entry.path === created.path);
    expect(rows.map((entry) => entry.id)).toEqual(["race-winner"]);
  });

  it("gc during a normal create() preserves the in-flight worktree and leaves one live row", async () => {
    const syncDir = path.join(root, "sync");
    await fs.mkdir(syncDir, { recursive: true });
    const startedFlag = path.join(syncDir, "setup-started");
    const releaseFlag = path.join(syncDir, "setup-release");
    await fs.mkdir(path.join(repo, ".openclaw"));
    // The setup script parks create() mid-provisioning until released, so gc deterministically
    // observes an in-flight create (live worktree + live claim-time row) and must preserve it.
    await fs.writeFile(
      path.join(repo, ".openclaw", "worktree-setup.sh"),
      `#!/bin/sh\n: > "${startedFlag}"\ni=0\nwhile [ ! -f "${releaseFlag}" ]; do\n  i=$((i + 1))\n  [ "$i" -gt 400 ] && exit 9\n  sleep 0.1\ndone\nexit 0\n`,
      { mode: 0o755 },
    );

    const createPromise = service.create({ repoRoot: repo, name: "during-gc" });
    while (!(await fs.stat(startedFlag).catch(() => undefined))) {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    const result = await service.gc();
    await fs.writeFile(releaseFlag, "");
    const created = await createPromise;

    expect(result.orphansDeleted).toBe(0);
    expect(await fs.stat(created.path)).toBeTruthy();
    const rows = listRegistryWorktrees(env).filter((entry) => entry.path === created.path);
    expect(rows.map((entry) => entry.id)).toEqual([created.id]);
  });

  it("normal create() returns the concurrent winner's record instead of double-registering", async () => {
    const sibling = await service.create({ repoRoot: repo, name: "sibling" });
    const winner: ManagedWorktreeRecord = {
      ...sibling,
      id: "race-winner",
      name: "race-normal",
      path: path.join(path.dirname(sibling.path), "race-normal"),
      branch: "openclaw/race-normal",
    };
    let raced = false;
    // Normal create()'s first now() read is the record's createdAt, taken right after
    // `git worktree add` and before the claim; the trapdoor inserts the competing row there,
    // simulating a concurrent registration winning the tiny post-add window.
    const racingService = new ManagedWorktreeService({
      env,
      now: () => {
        if (!raced) {
          raced = true;
          insertRegistryWorktree(env, winner);
        }
        return now;
      },
    });

    const created = await racingService.create({ repoRoot: repo, name: "race-normal" });

    expect(created.id).toBe("race-winner");
    const rows = listRegistryWorktrees(env).filter((entry) => entry.path === winner.path);
    expect(rows.map((entry) => entry.id)).toEqual(["race-winner"]);
  });

  it("a parked in-flight create() is invisible as a usable record and untouchable by retries", async () => {
    const syncDir = path.join(root, "sync");
    await fs.mkdir(syncDir, { recursive: true });
    const startedFlag = path.join(syncDir, "setup-started");
    const releaseFlag = path.join(syncDir, "setup-release");
    await fs.mkdir(path.join(repo, ".openclaw"));
    // The marker counts setup executions; the park keeps create #1 in its provisioning
    // window while same-name retries run against the live claim-time row.
    await fs.writeFile(
      path.join(repo, ".openclaw", "worktree-setup.sh"),
      `#!/bin/sh\necho ran >> setup-marker.txt\n: > "${startedFlag}"\ni=0\nwhile [ ! -f "${releaseFlag}" ]; do\n  i=$((i + 1))\n  [ "$i" -gt 400 ] && exit 9\n  sleep 0.1\ndone\nexit 0\n`,
      { mode: 0o755 },
    );

    const firstPromise = service.create({
      repoRoot: repo,
      name: "parked",
      ownerKind: "session",
      ownerId: "agent:parked",
    });
    while (!(await fs.stat(startedFlag).catch(() => undefined))) {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }

    // The claim-time row is observable but not usable: list() shows it provisioning, while
    // usable-record acquisition (findLiveByOwner, same-name create) refuses to hand it out.
    const parkedRows = listRegistryWorktrees(env).filter((entry) => entry.name === "parked");
    expect(parkedRows.map((entry) => entry.readiness)).toEqual(["provisioning"]);
    expect(service.findLiveByOwner("session", "agent:parked")).toBeUndefined();
    await expect(
      service.create({
        repoRoot: repo,
        name: "parked",
        ownerKind: "session",
        ownerId: "agent:parked",
      }),
    ).rejects.toThrow("worktree provisioning in progress: parked");
    await expect(service.create({ repoRoot: repo, name: "parked" })).rejects.toThrow(
      "worktree provisioning in progress: parked",
    );
    expect(listRegistryWorktrees(env).filter((entry) => entry.name === "parked")).toHaveLength(1);

    await fs.writeFile(releaseFlag, "");
    const first = await firstPromise;

    expect(first.readiness).toBe("ready");
    expect(service.findLiveByOwner("session", "agent:parked")?.id).toBe(first.id);
    // Only #1's setup execution ever ran; no retry adopted, re-provisioned, or cleaned up.
    expect(await fs.readFile(path.join(first.path, "setup-marker.txt"), "utf8")).toBe("ran\n");
    expect(await fs.stat(first.path)).toBeTruthy();
    const rows = listRegistryWorktrees(env).filter((entry) => entry.path === first.path);
    expect(rows.map((entry) => [entry.id, entry.readiness])).toEqual([[first.id, "ready"]]);
  });

  it("restore() revives a removed provisioning row as ready", async () => {
    const created = await service.create({
      repoRoot: repo,
      name: "restore-prov",
      ownerKind: "workboard",
      ownerId: "card-restore",
    });
    // Constructed post-claim crash: the row is left 'provisioning' over a real checkout,
    // then the operator recovers it via the normal remove -> restore path.
    updateRegistryWorktree(env, created.id, { readiness: "provisioning" });
    await service.remove({ id: created.id, reason: "operator-recovery" });

    const restored = await service.restore({ id: created.id });

    expect(restored.readiness).toBe("ready");
    expect(getRegistryWorktree(env, created.id)?.readiness).toBe("ready");
    // The revived row must not be reapable via its original claim timestamp.
    now += PROVISIONING_STALE_MS + 1;
    await service.gc();
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
    expect(await fs.stat(restored.path)).toBeTruthy();
    expect(service.findLiveByOwner("workboard", "card-restore")?.id).toBe(created.id);
  });

  it("create() fails closed when its provisioning row is reaped mid-flight", async () => {
    const syncDir = path.join(root, "sync-reap");
    await fs.mkdir(syncDir, { recursive: true });
    const startedFlag = path.join(syncDir, "setup-started");
    const releaseFlag = path.join(syncDir, "setup-release");
    await fs.mkdir(path.join(repo, ".openclaw"));
    await fs.writeFile(
      path.join(repo, ".openclaw", "worktree-setup.sh"),
      `#!/bin/sh\n: > "${startedFlag}"\ni=0\nwhile [ ! -f "${releaseFlag}" ]; do\n  i=$((i + 1))\n  [ "$i" -gt 400 ] && exit 9\n  sleep 0.1\ndone\nexit 0\n`,
      { mode: 0o755 },
    );

    const firstPromise = service.create({ repoRoot: repo, name: "reaped" });
    while (!(await fs.stat(startedFlag).catch(() => undefined))) {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    // Simulates gc reaping the claim while the (suspended/overlong) holder still runs:
    // the ready flip then updates zero rows and create() must not return a dead record.
    const parked = listRegistryWorktrees(env).find((entry) => entry.name === "reaped");
    deleteRegistryWorktree(env, parked!.id);
    await fs.writeFile(releaseFlag, "");

    await expect(firstPromise).rejects.toThrow(
      "worktree provisioning exceeded its window and was reclaimed: reaped",
    );
  });

  it("the wall-clock provisioning heartbeat keeps any provisioning stall alive through gc", async () => {
    // Fake only the interval APIs: the service's heartbeat timer becomes deterministically
    // fireable while the test's own polling and the parked child process stay real.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const syncDir = path.join(root, "sync");
      await fs.mkdir(syncDir, { recursive: true });
      const startedFlag = path.join(syncDir, "setup-started");
      const releaseFlag = path.join(syncDir, "setup-release");
      await fs.mkdir(path.join(repo, ".openclaw"));
      // The parked setup script stands in for any provisioning stall (one huge include-file
      // copy, a slow setup, ...): nothing but the timer proves the holder is alive.
      await fs.writeFile(
        path.join(repo, ".openclaw", "worktree-setup.sh"),
        `#!/bin/sh\n: > "${startedFlag}"\ni=0\nwhile [ ! -f "${releaseFlag}" ]; do\n  i=$((i + 1))\n  [ "$i" -gt 400 ] && exit 9\n  sleep 0.1\ndone\nexit 0\n`,
        { mode: 0o755 },
      );

      const createPromise = service.create({ repoRoot: repo, name: "stalled" });
      while (!(await fs.stat(startedFlag).catch(() => undefined))) {
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
      }

      // Far past the stale threshold relative to the claim (and to any pre-stall bump), a
      // single timer tick re-proves liveness; gc must preserve the claim.
      now += PROVISIONING_STALE_MS + 1;
      vi.advanceTimersByTime(PROVISIONING_HEARTBEAT_MS);
      const parked = listRegistryWorktrees(env).find((entry) => entry.name === "stalled");
      expect(parked?.readiness).toBe("provisioning");
      expect(now - parked!.createdAt).toBeGreaterThan(PROVISIONING_STALE_MS);
      // Pins that the timer fired: only its bump can have written the advanced clock.
      expect(parked?.lastActiveAt).toBe(now);
      await service.gc();
      expect(getRegistryWorktree(env, parked!.id)?.readiness).toBe("provisioning");
      expect(await fs.stat(parked!.path)).toBeTruthy();

      await fs.writeFile(releaseFlag, "");
      const created = await createPromise;
      expect(created.readiness).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("list() hard-deletes a missing-path provisioning claim instead of retiring it", async () => {
    const created = await service.create({ repoRoot: repo, name: "list-heal" });
    // Constructed: a provisioning claim whose directory vanished, discovered via list()
    // before any gc runs (the door that previously retired it into a permanent dead end).
    updateRegistryWorktree(env, created.id, { readiness: "provisioning" });
    await fs.rm(created.path, { recursive: true, force: true });

    const listed = await service.list();

    // Hard-deleted, not retired: no removed row lingers to collide with the surviving
    // branch, and the branch itself is gone — the name is genuinely retriable.
    expect(listed.find((entry) => entry.id === created.id)).toBeUndefined();
    expect(getRegistryWorktree(env, created.id)).toBeUndefined();
    expect(await git(repo, "branch", "--list", created.branch)).toBe("");
    const recreated = await service.create({ repoRoot: repo, name: "list-heal" });
    expect(recreated.readiness).toBe("ready");
  });

  it("gc reaps silent provisioning claims and preserves heartbeating ones", async () => {
    await fs.mkdir(path.join(repo, ".openclaw"));
    await fs.writeFile(
      path.join(repo, ".openclaw", "worktree-setup.sh"),
      "#!/bin/sh\necho ran > setup-marker.txt\n",
      { mode: 0o755 },
    );
    const named = await service.create({ repoRoot: repo, name: "stale-prov" });
    const autoNamed = await service.create({ repoRoot: repo });
    // Constructed post-claim crash state: live worktree + branch with a row still marked
    // 'provisioning' — exactly what a create() killed mid-setup leaves behind.
    updateRegistryWorktree(env, named.id, { readiness: "provisioning" });
    updateRegistryWorktree(env, autoNamed.id, { readiness: "provisioning" });

    // Liveness, not claim age, decides: well past the original claim's age a recent
    // heartbeat still proves a live holder, so gc must not touch the claim.
    now += PROVISIONING_STALE_MS + 1;
    updateRegistryWorktree(env, named.id, { lastActiveAt: now });
    updateRegistryWorktree(env, autoNamed.id, { lastActiveAt: now });
    await service.gc();
    expect(getRegistryWorktree(env, named.id)?.readiness).toBe("provisioning");
    expect(await fs.stat(named.path)).toBeTruthy();

    // A claim silent past the threshold has a dead holder: row, worktree, and branch go away.
    now += PROVISIONING_STALE_MS + 1;
    await service.gc();
    expect(getRegistryWorktree(env, named.id)).toBeUndefined();
    expect(getRegistryWorktree(env, autoNamed.id)).toBeUndefined();
    await expect(fs.stat(named.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(autoNamed.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(repo, "branch", "--list", named.branch)).toBe("");
    expect(await git(repo, "branch", "--list", autoNamed.branch)).toBe("");

    // Background recovery is complete: the same name (and any auto name) provisions fresh.
    const recreated = await service.create({ repoRoot: repo, name: "stale-prov" });
    expect(recreated.readiness).toBe("ready");
    expect(await fs.readFile(path.join(recreated.path, "setup-marker.txt"), "utf8")).toBe("ran\n");
  });

  it("gc hard-deletes provisioning claims whose directory vanished, keeping the name retriable", async () => {
    const created = await service.create({ repoRoot: repo, name: "gone-dir" });
    // Constructed: a provisioning claim whose directory is gone (crash + manual cleanup).
    updateRegistryWorktree(env, created.id, { readiness: "provisioning" });
    await fs.rm(created.path, { recursive: true, force: true });

    await service.gc();

    // No hidden retired row and no surviving branch — retiring instead would strand the
    // name forever (row invisible to adoption, branch collides with the next create).
    expect(getRegistryWorktree(env, created.id)).toBeUndefined();
    expect(await git(repo, "branch", "--list", created.branch)).toBe("");
    const recreated = await service.create({ repoRoot: repo, name: "gone-dir" });
    expect(recreated.readiness).toBe("ready");
  });

  it("gc reap defers to a live run lease via the shared removal claim", async () => {
    const created = await service.create({ repoRoot: repo, name: "leased-claim" });
    const lease = await acquireWorktreeRunLease(created.id, { env });
    // Constructed dead-holder state under a still-live run lease: the removal claim
    // rejects, so reap must skip rather than destroy a checkout a run is using.
    updateRegistryWorktree(env, created.id, { readiness: "provisioning" });
    now += PROVISIONING_STALE_MS + 1;

    await service.gc();
    expect(getRegistryWorktree(env, created.id)?.readiness).toBe("provisioning");
    expect(await fs.stat(created.path)).toBeTruthy();

    await lease.release();
    await service.gc();
    expect(getRegistryWorktree(env, created.id)).toBeUndefined();
    await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prunes expired snapshot refs and registry rows", async () => {
    const created = await service.create({ repoRoot: repo, name: "expired" });
    const removed = await service.remove({ id: created.id, reason: "retention" });
    now += SNAPSHOT_RETENTION_MS + 1;

    const result = await service.gc();
    expect(result.snapshotsPruned).toBe(1);
    expect(getRegistryWorktree(env, created.id)).toBeUndefined();
    await expect(git(repo, "show-ref", "--verify", removed.snapshotRef!)).rejects.toThrow();
  });
});
