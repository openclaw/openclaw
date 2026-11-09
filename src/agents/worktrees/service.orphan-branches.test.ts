import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { withWorktreeAllocationLease } from "./allocation.js";
import { reservePendingWorktree } from "./pending-slots.js";
import { updateRegistryWorktree } from "./registry.js";
import { resolveRepository } from "./repository-paths.js";
import { ManagedWorktreeService } from "./service.js";
import {
  git,
  makeWorktreeRecord,
  materializeManagedWorktreeFixture,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";

describe("managed orphan branch cleanup", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  const temps = useStateDatabaseTempDirs();
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let service: ManagedWorktreeService;
  let repoFingerprint: string;
  beforeEach(async () => {
    const root = temps.make("openclaw-orphan-branches-");
    repo = await initializeRepository(root);
    repoFingerprint = (await resolveRepository(repo)).fingerprint;
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    service = new ManagedWorktreeService({
      env,
      getConfig: () => ({ worktreeAcceleration: false }),
    });
  });
  const materialize = (name: string, ownerKind: "manual" | "session" = "manual") =>
    materializeManagedWorktreeFixture({
      env,
      repoRoot: repo,
      repoFingerprint,
      stateDir: env.OPENCLAW_STATE_DIR!,
      name,
      ownerKind,
      now: Date.now(),
    });
  const prune = (dryRun = false) => service.pruneOrphanBranches({ repoRoot: repo, dryRun });

  it("deletes only unowned managed branches, previews safely and reports retryable failures", async () => {
    const attached = await materialize("attached");
    const detached = await materialize("detached");
    await git(repo, "worktree", "remove", detached.path);
    const recovery = await materialize("recovery");
    await service.remove({ id: recovery.id, reason: "archive" });
    await git(repo, "branch", recovery.branch);
    const pending = makeWorktreeRecord(repo, "pending", {
      path: path.join(env.OPENCLAW_STATE_DIR!, "pending"),
      branch: "openclaw/pending",
    });
    await withWorktreeAllocationLease({ env, id: pending.id }, (guard) =>
      reservePendingWorktree(env, pending, guard.workerAuthority),
    );
    for (const branch of [pending.branch, "openclaw/orphan", "openclaw/locked", "fix/unmanaged"]) {
      await git(repo, "branch", branch);
    }
    const unknown = "refs/openclaw/removals/unregistered";
    await git(repo, "update-ref", unknown, "HEAD");
    expect((await prune()).branches.every((branch) => branch.outcome === "preserved")).toBe(true);
    await git(repo, "update-ref", "-d", unknown);
    vi.stubEnv("GIT_DIR", "/missing-inherited-repository");
    let preview;
    try {
      preview = await prune(true);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(
      preview.branches
        .filter((branch) => branch.outcome === "would-delete")
        .map((branch) => branch.branch),
    ).toEqual(["openclaw/locked", "openclaw/orphan"]);
    expect(await git(repo, "rev-parse", "openclaw/orphan")).toBeTruthy();
    const lock = path.join(repo, ".git/refs/heads/openclaw/locked.lock");
    await fs.writeFile(lock, "", { flag: "wx" });
    try {
      expect((await prune()).branches).toEqual(
        expect.arrayContaining([
          { branch: "openclaw/orphan", outcome: "failed", reason: expect.stringContaining("lock") },
          { branch: "openclaw/locked", outcome: "failed", reason: expect.stringContaining("lock") },
        ]),
      );
    } finally {
      await fs.unlink(lock);
    }
    expect((await prune()).branches).toContainEqual({
      branch: "openclaw/locked",
      outcome: "deleted",
    });
    expect(
      (await git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads")).split("\n"),
    ).toEqual([
      "fix/unmanaged",
      "main",
      attached.branch,
      detached.branch,
      pending.branch,
      recovery.branch,
    ]);
  });

  it("keeps refs bounded through removal and recovery expiry churn", async () => {
    const refs = () => git(repo, "for-each-ref", "--format=%(refname)");
    const before = await refs();
    for (let index = 0; index < 3; index++) {
      const record = await materialize(`churn-${index}`);
      await service.remove({ id: record.id, reason: "archive" });
      expect(await git(repo, "branch", "--list", record.branch)).toBe("");
      await updateRegistryWorktree(env, record.id, {
        removedAt: Date.now() - 31 * 24 * 60 * 60 * 1000 - 1,
      });
    }
    expect((await refs()).split("\n").length).toBe(before.split("\n").length + 3);
    expect((await service.gc()).snapshotsPruned).toBe(3);
    expect(await refs()).toBe(before);
  });

  it("retains recovery ownership while an orphan's checkout files survive", async () => {
    const record = await materialize("missing-gitdir", "session");
    const gitdir = await git(record.path, "rev-parse", "--absolute-git-dir");
    await fs.rm(gitdir, { recursive: true });
    await fs.writeFile(path.join(record.path, "unique.txt"), "unrecovered work\n");
    await updateRegistryWorktree(env, record.id, { lastActiveAt: 1 });
    expect((await service.gc({ readOwnerState: () => "retired" })).orphansRetired).toBe(1);
    await updateRegistryWorktree(env, record.id, {
      removedAt: Date.now() - 31 * 24 * 60 * 60 * 1000 - 1,
    });
    const expired = await service.gc();
    expect(expired.snapshotsPruned).toBe(0);
    expect(expired.issues).toContainEqual(
      expect.objectContaining({ reason: expect.stringContaining("checkout files remain") }),
    );
    expect((await prune()).branches).toContainEqual(
      expect.objectContaining({ branch: record.branch, outcome: "preserved" }),
    );
    expect(await fs.readFile(path.join(record.path, "unique.txt"), "utf8")).toBe(
      "unrecovered work\n",
    );
    expect(await git(repo, "branch", "--list", record.branch)).toBe(record.branch);
  });
});
