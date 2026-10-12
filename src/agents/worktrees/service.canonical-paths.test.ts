import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import * as allocation from "./allocation.js";
import * as worktreeGit from "./git.js";
import { listGitWorktrees } from "./git.js";
import { getRegistryWorktree } from "./registry.test-support.js";
import { IDLE_GC_MS, ManagedWorktreeService, SNAPSHOT_RETENTION_MS } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

describe("ManagedWorktreeService canonical paths", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  let root: string;
  let repo: string;
  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  let service: ManagedWorktreeService;

  async function cloneRepository(name: string, originUrl?: string): Promise<string> {
    const target = path.join(root, name);
    await execFileAsync("git", ["clone", "--no-hardlinks", repo, target]);
    await git(
      target,
      "remote",
      "set-url",
      "origin",
      originUrl ?? (await git(repo, "config", "--get", "remote.origin.url")),
    );
    return await fs.realpath(target);
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "openclaw-worktree-canonical-paths-"),
    );
    repo = await initializeRepository(root);
    stateDir = path.join(root, "state");
    await fs.mkdir(stateDir, { recursive: true });
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    service = new ManagedWorktreeService({ env });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("preserves an absent origin but does not report failed origin reads as absence", async () => {
    await git(repo, "remote", "remove", "origin");
    expect(await service.resolveRepositoryIdentity(repo)).toMatchObject({ originUrl: "" });
    const original = worktreeGit.runGit;
    vi.spyOn(worktreeGit, "runGit").mockImplementation(async (cwd, args, options) => {
      const result = await original(cwd, args, options);
      return args.join(" ") === "config --get remote.origin.url"
        ? { ...result, code: 128, stderr: "synthetic repository read failure" }
        : result;
    });
    await expect(service.resolveRepositoryIdentity(repo)).rejects.toThrow(
      "synthetic repository read failure",
    );
  });

  it("repairs the live repository before snapshotting and a queued restore", async ({ signal }) => {
    const canonicalLiveRepo = await cloneRepository("live-normal");
    const liveIdentity = await service.resolveRepositoryIdentity(canonicalLiveRepo);
    const staleIdentity = await service.resolveRepositoryIdentity(repo);
    const created = await service.create({
      repoRoot: canonicalLiveRepo,
      name: "repository-rebind-normal",
      baseRef: "HEAD",
      ownerKind: "session",
      ownerId: "agent:main:normal",
    });
    await fs.writeFile(path.join(created.path, "README.md"), "normal tracked change\n");
    await fs.writeFile(path.join(created.path, "untracked.txt"), "normal untracked change\n");
    const staleHead = await git(repo, "rev-parse", "HEAD");
    const snapshotRef = `refs/openclaw/snapshots/${created.id}`;
    await git(repo, "branch", created.branch, staleHead);
    await git(repo, "update-ref", snapshotRef, staleHead);
    openOpenClawStateDatabase({ env })
      .db.prepare("UPDATE worktrees SET repo_root = ?, repo_fingerprint = ? WHERE id = ?")
      .run(staleIdentity.repoRoot, staleIdentity.fingerprint, created.id);

    const queued = createDeferred();
    const release = createDeferred();
    const allocate = allocation.withWorktreeAllocationLease;
    const admission = vi
      .spyOn(allocation, "withWorktreeAllocationLease")
      .mockImplementationOnce(async (params, run) => {
        queued.resolve();
        await release.promise;
        return await allocate(params, run);
      });
    const restoring = service.restore({ id: created.id });
    try {
      await withinTest(
        awaitGateBeforeSettlement(queued.promise, restoring, "restore never reached allocation"),
        signal,
      );
      const removed = await service.remove({
        id: created.id,
        reason: "repository-rebind",
      });

      expect(removed).toEqual({ removed: true, snapshotRef });
      expect(getRegistryWorktree(env, created.id)).toMatchObject({
        repoRoot: liveIdentity.repoRoot,
        repoFingerprint: liveIdentity.fingerprint,
        path: created.path,
        branch: created.branch,
        baseRef: created.baseRef,
        ownerKind: "session",
        ownerId: "agent:main:normal",
        snapshotRef,
      });
      expect(await git(canonicalLiveRepo, "show-ref", "--verify", snapshotRef)).not.toBe("");
      expect(await git(canonicalLiveRepo, "branch", "--list", created.branch)).toBe("");
      expect(await git(repo, "rev-parse", snapshotRef)).toBe(staleHead);
      expect(await git(repo, "rev-parse", created.branch)).toBe(staleHead);
      // The repaired record no longer depends on the stale repository's continued availability.
      await fs.rename(repo, path.join(root, "stale-repository"));
    } finally {
      admission.mockRestore();
      release.resolve();
      await Promise.allSettled([restoring]);
    }

    const restored = await restoring;
    expect(restored.repoRoot).toBe(liveIdentity.repoRoot);
    expect(restored.path).toBe(created.path);
    expect(await git(restored.path, "branch", "--show-current")).toBe(created.branch);
    expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe(
      "normal tracked change\n",
    );
    expect(await fs.readFile(path.join(restored.path, "untracked.txt"), "utf8")).toBe(
      "normal untracked change\n",
    );
  });

  it("rejects a live checkout from a different-origin repository before mutation", async () => {
    const differentOrigin = path.join(root, "different-origin.git");
    await execFileAsync("git", ["clone", "--bare", repo, differentOrigin]);
    const liveRepo = await cloneRepository("live-different-origin", differentOrigin);
    const staleIdentity = await service.resolveRepositoryIdentity(repo);
    const created = await service.create({
      repoRoot: liveRepo,
      name: "repository-rebind-different-origin",
      baseRef: "HEAD",
      ownerKind: "session",
      ownerId: "agent:main:different-origin",
    });
    await fs.writeFile(path.join(created.path, "README.md"), "do not snapshot or remove\n");
    const liveBranch = await git(liveRepo, "rev-parse", created.branch);
    const staleHead = await git(repo, "rev-parse", "HEAD");
    const snapshotRef = `refs/openclaw/snapshots/${created.id}`;
    await git(repo, "branch", created.branch, staleHead);
    await git(repo, "update-ref", snapshotRef, staleHead);
    openOpenClawStateDatabase({ env })
      .db.prepare("UPDATE worktrees SET repo_root = ?, repo_fingerprint = ? WHERE id = ?")
      .run(staleIdentity.repoRoot, staleIdentity.fingerprint, created.id);
    const registered = getRegistryWorktree(env, created.id);

    await expect(service.remove({ id: created.id, reason: "different-origin" })).rejects.toThrow(
      "origin",
    );

    expect(getRegistryWorktree(env, created.id)).toEqual(registered);
    expect(registered).toMatchObject({
      repoRoot: staleIdentity.repoRoot,
      repoFingerprint: staleIdentity.fingerprint,
      path: created.path,
      ownerId: "agent:main:different-origin",
    });
    expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe(
      "do not snapshot or remove\n",
    );
    expect(await git(liveRepo, "rev-parse", created.branch)).toBe(liveBranch);
    await expect(git(liveRepo, "show-ref", "--verify", snapshotRef)).rejects.toThrow();
    expect(await git(repo, "rev-parse", created.branch)).toBe(staleHead);
    expect(await git(repo, "rev-parse", snapshotRef)).toBe(staleHead);
  });

  it("repairs the live repository before lossless cleanup releases its Git lock", async () => {
    const liveRepo = await cloneRepository("live-lossless");
    const liveIdentity = await service.resolveRepositoryIdentity(liveRepo);
    const staleIdentity = await service.resolveRepositoryIdentity(repo);
    const created = await service.create({
      repoRoot: liveIdentity.repoRoot,
      name: "repository-rebind-lossless",
      baseRef: "HEAD",
      ownerKind: "workboard",
      ownerId: "card-repository-rebind",
    });
    await service.acquire(created.id);
    openOpenClawStateDatabase({ env })
      .db.prepare("UPDATE worktrees SET repo_root = ?, repo_fingerprint = ? WHERE id = ?")
      .run(staleIdentity.repoRoot, staleIdentity.fingerprint, created.id);

    await expect(service.removeIfLossless(created.id)).resolves.toBe(true);

    expect(getRegistryWorktree(env, created.id)).toMatchObject({
      repoRoot: liveIdentity.repoRoot,
      repoFingerprint: liveIdentity.fingerprint,
      removedAt: expect.any(Number),
      runEndCleanup: { outcome: "removed-lossless" },
    });
    await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")(
    "canonicalizes managed paths minted below a symlinked state directory",
    async () => {
      const realStateDir = await fs.mkdtemp(path.join(root, "real-state-"));
      const linkedStateDir = path.join(root, "linked-state");
      await fs.symlink(realStateDir, linkedStateDir, "dir");
      const linkedStateService = new ManagedWorktreeService({
        env: { ...process.env, OPENCLAW_STATE_DIR: linkedStateDir },
      });

      const created = await linkedStateService.create({
        repoRoot: repo,
        name: "canonical-state",
        baseRef: "HEAD",
      });
      const expectedPath = path.join(
        await fs.realpath(realStateDir),
        "worktrees",
        created.repoFingerprint,
        "canonical-state",
      );
      expect(created.path).toBe(expectedPath);

      await linkedStateService.acquire(created.id);
      await expect(linkedStateService.removeIfLossless(created.id)).resolves.toBe(true);
      await expect(fs.stat(expectedPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});

describe("configured managed worktree root", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  let root: string;
  let repo: string;
  let stateDir: string;
  let worktreeRoot: string | undefined;
  let now: number;
  let service: ManagedWorktreeService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worktree-root-"));
    repo = await initializeRepository(root);
    stateDir = path.join(root, "state");
    worktreeRoot = undefined;
    now = Date.now();
    service = new ManagedWorktreeService({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      now: () => now,
      getConfig: () => ({ worktreeRoot }),
    });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reuses, snapshots, and restores recorded paths when the new root is unavailable", async () => {
    const manual = await service.create({ repoRoot: repo, name: "manual", baseRef: "HEAD" });
    const owner = {
      repoRoot: repo,
      baseRef: "HEAD",
      ownerKind: "session" as const,
      ownerId: "owner",
    };
    const session = await service.create({ ...owner, name: "session" });
    await fs.writeFile(path.join(manual.path, "README.md"), "preserved edit\n");
    await fs.writeFile(path.join(manual.path, "untracked.txt"), "preserved untracked\n");
    worktreeRoot = path.join(root, "unavailable-root");
    await fs.writeFile(worktreeRoot, "a file is not a worktree directory\n");

    expect((await service.create({ repoRoot: repo, name: "manual", baseRef: "HEAD" })).id).toBe(
      manual.id,
    );
    expect((await service.create({ ...owner, name: "another-title" })).id).toBe(session.id);
    await service.remove({ id: manual.id, reason: "root-change" });
    const restoredByName = await service.create({
      repoRoot: repo,
      name: "manual",
      baseRef: "HEAD",
    });
    expect(restoredByName.id).toBe(manual.id);
    expect(restoredByName.path).toBe(manual.path);
    await service.remove({ id: manual.id, reason: "root-change-again" });
    const restoredById = await service.restore({ id: manual.id });
    expect(restoredById.path).toBe(manual.path);
    expect(await fs.readFile(path.join(manual.path, "README.md"), "utf8")).toBe("preserved edit\n");
    expect(await fs.readFile(path.join(manual.path, "untracked.txt"), "utf8")).toBe(
      "preserved untracked\n",
    );
  });

  it("cleans registered work across roots and preserves unregistered custom-root contents", async () => {
    const owner = {
      repoRoot: repo,
      baseRef: "HEAD",
      ownerKind: "session" as const,
      ownerId: "old-owner",
    };
    const original = await service.create({ ...owner, name: "same-title" });
    await service.remove({ id: original.id, reason: "before-root-change" });
    worktreeRoot = path.join(root, "custom");
    const successor = await service.create({ ...owner, suggestedName: "same-title" });
    expect(successor.name).toBe("same-title-2");
    expect(successor.path).toBe(path.join(worktreeRoot, successor.repoFingerprint, successor.name));
    const restored = await service.restore({ id: original.id });
    const unrelated = path.join(
      worktreeRoot,
      successor.repoFingerprint,
      "unregistered",
      "keep.txt",
    );
    await fs.mkdir(path.dirname(unrelated), { recursive: true });
    await fs.writeFile(unrelated, "unrelated data\n");
    now = Math.max(restored.lastActiveAt, successor.lastActiveAt) + IDLE_GC_MS + 1;

    const result = await service.gc();
    expect(result.removed.toSorted()).toEqual([original.id, successor.id].toSorted());
    expect(result.orphansDeleted).toBe(0);
    expect(await fs.readFile(unrelated, "utf8")).toBe("unrelated data\n");
    expect((await service.list()).every((record) => record.snapshotRef && record.removedAt)).toBe(
      true,
    );
    expect((await service.restore({ id: original.id })).path).toBe(original.path);
  });

  it.each(["deep", "symlink"])(
    "preserves %s custom-root contents during GC, including after a root change",
    async (kind) => {
      const nestedRoot = path.join(
        stateDir,
        "worktrees",
        "custom",
        ...(kind === "deep" ? ["deeper"] : []),
      );
      await fs.mkdir(nestedRoot, { recursive: true });
      worktreeRoot = nestedRoot;
      if (kind === "symlink") {
        worktreeRoot = path.join(root, "linked-nested-root");
        await fs.symlink(
          nestedRoot,
          worktreeRoot,
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      const unrelated = path.join(nestedRoot, "unregistered", "keep.txt");
      await fs.mkdir(path.dirname(unrelated));
      await fs.writeFile(unrelated, "unrelated data\n");
      expect((await service.gc()).orphansDeleted).toBe(0);
      expect(await fs.readFile(unrelated, "utf8")).toBe("unrelated data\n");

      const record = await service.create({ repoRoot: repo, name: "nested", baseRef: "HEAD" });
      expect(record.path).toBe(path.join(nestedRoot, record.repoFingerprint, record.name));
      await fs.writeFile(path.join(record.path, "README.md"), "unsnapshotted edit\n");
      for (const nextRoot of [worktreeRoot, path.join(root, "next-root")]) {
        worktreeRoot = nextRoot;
        expect((await service.gc()).orphansDeleted).toBe(0);
        expect(await fs.readFile(path.join(record.path, "README.md"), "utf8")).toBe(
          "unsnapshotted edit\n",
        );
        expect(await fs.readFile(unrelated, "utf8")).toBe("unrelated data\n");
        expect(
          (await service.list()).find((entry) => entry.id === record.id)?.removedAt,
        ).toBeUndefined();
      }
    },
  );
});

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

  it.each([
    { ownerKind: "workboard", state: "clean", rejectsChangedBase: true },
    { ownerKind: "workboard", state: "dirty", rejectsChangedBase: true },
    { ownerKind: "session", state: "dirty", rejectsChangedBase: false },
    { ownerKind: "manual", state: "dirty", rejectsChangedBase: false },
    { ownerKind: undefined, state: "dirty", rejectsChangedBase: false },
  ] as const)(
    "preserves a $state checkout when ownerKind=$ownerKind requests another base",
    async ({ ownerKind, state, rejectsChangedBase }) => {
      const baseRef = await git(repo, "rev-parse", "HEAD");
      const request = {
        repoRoot: repo,
        name: "owned-worktree",
        baseRef,
        ownerKind,
        ownerId: "owner-1",
      };
      const created = await service.create(request);
      const retained = { record: created, materialized: false };
      if (!rejectsChangedBase) {
        await expect(service.createWithOutcome({ ...request, baseRef: "main" })).resolves.toEqual(
          retained,
        );
      }
      await fs.writeFile(path.join(repo, "README.md"), "new base\n");
      await git(repo, "commit", "-am", "advance source");
      const requestedBase = await git(repo, "rev-parse", "HEAD");
      if (state === "dirty") {
        await fs.writeFile(path.join(created.path, "README.md"), "local changes\n");
        await fs.writeFile(path.join(created.path, "draft.txt"), "unfinished work\n");
      }

      const reuse = service.createWithOutcome({ ...request, baseRef: requestedBase });
      if (rejectsChangedBase) {
        await expect(reuse).rejects.toThrow(
          `already uses base ref ${baseRef}; requested ${requestedBase}`,
        );
      } else {
        await expect(reuse).resolves.toEqual(retained);
      }

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
      await expect(service.createWithOutcome(request)).resolves.toEqual(retained);
      await expect(service.createWithOutcome({ ...request, baseRef: undefined })).resolves.toEqual(
        retained,
      );
    },
  );

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
    const expired = await service.create({
      repoRoot: repo,
      name: "expired-snapshot",
      baseRef: "HEAD",
    });
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
