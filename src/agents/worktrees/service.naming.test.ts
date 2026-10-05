import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { listGitWorktrees } from "./git.js";
import { ManagedWorktreeService, SNAPSHOT_RETENTION_MS } from "./service.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}

describe("ManagedWorktreeService allocation and orphan preservation", () => {
  let root: string;
  let repo: string;
  let service: ManagedWorktreeService;
  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  let branchOrdinal = 0;

  beforeEach(async () => {
    const tempRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(tempRoot, "openclaw-worktree-naming-"));
    repo = path.join(root, "repo");
    await fs.mkdir(repo);
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.name", "OpenClaw Test");
    await git(repo, "config", "user.email", "openclaw-test@example.invalid");
    await fs.writeFile(path.join(repo, "README.md"), "base\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "initial");
    repo = await fs.realpath(repo);
    stateDir = path.join(root, "state");
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    service = new ManagedWorktreeService({ env });
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("uses readable defaults and numbers colliding inferred names", async () => {
    const fallback = await service.create({ repoRoot: repo, baseRef: "HEAD" });
    await service.create({ repoRoot: repo, name: "release-planning", baseRef: "HEAD" });
    const second = await service.create({
      repoRoot: repo,
      suggestedName: "release-planning",
      baseRef: "HEAD",
    });

    expect(fallback.name).toMatch(
      /^[a-z]+-(?:barnacle|claw|crab|crayfish|krill|langoustine|lobster|prawn|shrimp|shell)$/,
    );
    expect(second.name).toBe("release-planning-2");
  });

  it("numbers inferred names around unmanaged Git and filesystem collisions", async () => {
    const anchor = await service.create({ repoRoot: repo, name: "anchor", baseRef: "HEAD" });
    await git(repo, "branch", "openclaw/release-planning");
    await fs.mkdir(path.join(path.dirname(anchor.path), "release-planning-2"));

    const created = await service.create({
      repoRoot: repo,
      suggestedName: "release-planning",
      baseRef: "HEAD",
    });

    expect(created.name).toBe("release-planning-3");
  });

  it("reuses concurrent inferred names for the same owner", async () => {
    const owner = {
      repoRoot: repo,
      baseRef: "HEAD",
      ownerKind: "session" as const,
      ownerId: "agent:main:session-1",
    };
    const created = await Promise.all([
      service.create({ ...owner, suggestedName: "first-session-title" }),
      service.create({ ...owner, suggestedName: "second-session-title" }),
    ]);

    expect(created[0]?.id).toBe(created[1]?.id);
    expect(created[0]?.name).toMatch(/^(?:first|second)-session-title$/);
    expect(
      (await service.list()).filter((record) => record.ownerId === owner.ownerId),
    ).toHaveLength(1);
  });

  it.each(["clean", "dirty"] as const)(
    "rejects a changed base when reusing a %s card worktree and preserves its contents",
    async (state) => {
      const baseRef = await git(repo, "rev-parse", "HEAD");
      const request = {
        repoRoot: repo,
        name: "card-worktree",
        baseRef,
        ownerKind: "workboard" as const,
        ownerId: "card-1",
      };
      const created = await service.create(request);
      await fs.writeFile(path.join(repo, "README.md"), "new base\n");
      await git(repo, "commit", "-am", "advance source");
      const requestedBase = await git(repo, "rev-parse", "HEAD");
      if (state === "dirty") {
        await fs.writeFile(path.join(created.path, "README.md"), "local changes\n");
        await fs.writeFile(path.join(created.path, "draft.txt"), "unfinished work\n");
      }

      await expect(service.create({ ...request, baseRef: requestedBase })).rejects.toThrow(
        `already uses base ref ${baseRef}; requested ${requestedBase}`,
      );

      expect(await git(created.path, "rev-parse", "HEAD")).toBe(baseRef);
      expect(await git(created.path, "branch", "--show-current")).toBe(created.branch);
      expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe(
        state === "dirty" ? "local changes\n" : "base\n",
      );
      if (state === "dirty") {
        expect(await fs.readFile(path.join(created.path, "draft.txt"), "utf8")).toBe(
          "unfinished work\n",
        );
      }
      expect(await service.listRegistryRecords()).toEqual([created]);
      await expect(service.createWithOutcome(request)).resolves.toEqual({
        record: created,
        materialized: false,
      });
      await expect(service.createWithOutcome({ ...request, baseRef: undefined })).resolves.toEqual({
        record: created,
        materialized: false,
      });
    },
  );

  it("numbers a generated name colliding with the owner's removed record", async () => {
    const owner = {
      repoRoot: repo,
      baseRef: "HEAD",
      ownerKind: "session" as const,
      ownerId: "agent:main:main",
    };
    const first = await service.create({ ...owner, suggestedName: "same-title" });
    await service.remove({ id: first.id, reason: "session-reset" });

    const successor = await service.create({ ...owner, suggestedName: "same-title" });

    expect(successor.id).not.toBe(first.id);
    expect(successor.name).toBe("same-title-2");
    expect((await service.list()).find((record) => record.id === first.id)?.removedAt).toEqual(
      expect.any(Number),
    );
  });

  it("serializes overlapping numeric suffix families", async () => {
    await service.create({ repoRoot: repo, name: "task", baseRef: "HEAD" });

    const created = await Promise.all([
      service.create({ repoRoot: repo, suggestedName: "task", baseRef: "HEAD" }),
      service.create({ repoRoot: repo, suggestedName: "task-2", baseRef: "HEAD" }),
    ]);
    const names = created.map((record) => record.name);

    expect(new Set(names).size).toBe(2);
    expect(names).toContain("task-2");
    expect(names.every((name) => /^task-(?:2-2|3|2)$/.test(name))).toBe(true);
  });

  async function addRegisteredWorktree(
    target: string,
    kind: "committed" | "unborn",
  ): Promise<void> {
    const branch = `orphan-reconcile-${branchOrdinal++}`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (kind === "unborn") {
      await git(repo, "worktree", "add", "--orphan", "-b", branch, target);
    } else {
      await git(repo, "worktree", "add", "-b", branch, target, "HEAD");
    }
    await fs.mkdir(path.join(target, "payload"), { recursive: true });
    await fs.writeFile(path.join(target, "payload", "keep.txt"), `${kind}\n`);
  }

  async function expectRegisteredWorktreePreserved(
    target: string,
    kind: "committed" | "unborn",
  ): Promise<void> {
    const result = await service.gc();

    expect(result.orphansDeleted).toBe(0);
    await expect(fs.readFile(path.join(target, "payload", "keep.txt"), "utf8")).resolves.toBe(
      `${kind}\n`,
    );
    const canonicalTarget = await fs.realpath(target);
    const listed = await listGitWorktrees(repo);
    await expect(
      Promise.all(listed.map(async (entry) => await fs.realpath(entry.path))),
    ).resolves.toContain(canonicalTarget);
  }

  it("preserves an unborn worktree directly under the worktrees root", async () => {
    const target = path.join(stateDir, "worktrees", "direct-unborn");
    await addRegisteredWorktree(target, "unborn");

    await expectRegisteredWorktreePreserved(target, "unborn");
  });

  it("preserves unreadable checkout metadata without blocking later cleanup", async () => {
    let now = Date.now();
    service = new ManagedWorktreeService({ env, now: () => now });
    const expired = await service.create({ repoRoot: repo, name: "expired-snapshot" });
    await service.remove({ id: expired.id, reason: "retention" });
    now += SNAPSHOT_RETENTION_MS + 1;

    const fingerprint = path.join(stateDir, "worktrees", "fingerprint");
    const target = path.join(fingerprint, "a-broken-checkout");
    const debris = path.join(fingerprint, "z-plain-debris");
    await fs.mkdir(path.join(target, "payload"), { recursive: true });
    await fs.writeFile(path.join(target, ".git"), "gitdir: /missing/openclaw-worktree-control\n");
    await fs.writeFile(path.join(target, "payload", "keep.txt"), "uncertain\n");
    await fs.mkdir(debris, { recursive: true });
    await fs.writeFile(path.join(debris, "remove.txt"), "debris\n");

    const result = await service.gc();

    expect(result.orphansDeleted).toBe(1);
    expect(result.snapshotsPruned).toBe(1);
    await expect(fs.readFile(path.join(target, "payload", "keep.txt"), "utf8")).resolves.toBe(
      "uncertain\n",
    );
    await expect(fs.stat(debris)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await service.listRegistryRecords()).some((record) => record.id === expired.id)).toBe(
      false,
    );
  });

  it.skipIf(process.platform === "win32")(
    "canonicalizes a symlinked state root before matching registered paths",
    async () => {
      const realStateDir = path.join(root, "real-state");
      const linkedStateDir = path.join(root, "linked-state");
      await fs.mkdir(realStateDir);
      await fs.symlink(realStateDir, linkedStateDir, "dir");
      env = { ...process.env, OPENCLAW_STATE_DIR: linkedStateDir };
      service = new ManagedWorktreeService({ env });
      const target = path.join(realStateDir, "worktrees", "fingerprint", "nested-via-symlink");
      await addRegisteredWorktree(target, "committed");

      await expectRegisteredWorktreePreserved(target, "committed");
    },
  );
});
