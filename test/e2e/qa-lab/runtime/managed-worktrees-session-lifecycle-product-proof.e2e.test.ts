// QA Lab product proof for the session-owned managed-worktree lifecycle.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { SessionsDeleteResult } from "../../../../packages/gateway-protocol/src/index.js";
import type {
  ManagedWorktreeGcReceipt,
  ManagedWorktreeRecord,
} from "../../../../src/agents/worktrees/types.js";
import {
  git,
  initializeRepository,
  useWorktreeGateway,
} from "./managed-worktrees-product-proof-fixture.js";

type SessionWorktree = { id: string; branch: string; repoRoot: string };
type SessionCreateResult = {
  key: string;
  entry: { spawnedCwd?: string; worktree?: SessionWorktree };
  worktree: { id: string; branch: string; path: string };
};
type SessionListResult = {
  sessions: Array<{
    key: string;
    spawnedCwd?: string;
    worktree?: SessionWorktree;
  }>;
};
type WorktreeListResult = { worktrees: ManagedWorktreeRecord[] };
type GatewayRunResult = { runId?: unknown; status?: unknown };

const fixture = useWorktreeGateway();

it(
  "creates, protects, snapshots, restores, and reports preserved session worktrees",
  { timeout: 240_000 },
  async () => {
    const fixtureRoot = await fixture.tempDir("openclaw-managed-worktree-session-");
    const { baseCommit, repo } = await initializeRepository(fixtureRoot);
    const harness = await fixture.start();
    const { call, waitForRun } = harness;
    const gateway = harness.gateway;
    const createSessionWorktree = (name: string) =>
      gateway.call(
        "sessions.create",
        {
          agentId: "qa",
          worktree: true,
          worktreeName: name,
          worktreeBaseRef: "main",
          cwd: repo,
        },
        { timeoutMs: 30_000 },
      ) as Promise<SessionCreateResult>;
    const listWorktrees = () => gateway.call("worktrees.list", {}) as Promise<WorktreeListResult>;
    const deleteSession = async (session: SessionCreateResult) => {
      const deleted = (await gateway.call("sessions.delete", {
        key: session.key,
      })) as SessionsDeleteResult;
      expect(deleted.deleted).toBe(true);
      expect(deleted).not.toHaveProperty("worktreePreserved");
      await expect(fs.access(session.worktree.path)).rejects.toMatchObject({ code: "ENOENT" });
    };
    const stateDir = path.join(await fs.realpath(harness.gateway.tempRoot), "state");

    const clean = await createSessionWorktree("qa-session-clean");
    expect(clean.worktree).toMatchObject({
      id: expect.any(String),
      branch: "openclaw/qa-session-clean",
      path: expect.any(String),
    });
    expect(clean.entry.worktree).toMatchObject({
      id: clean.worktree.id,
      branch: clean.worktree.branch,
      repoRoot: repo,
    });
    expect(clean.entry.spawnedCwd).toBe(clean.worktree.path);

    const createdList = await listWorktrees();
    const cleanRecord = createdList.worktrees.find((record) => record.id === clean.worktree.id);
    expect(cleanRecord).toMatchObject({
      name: "qa-session-clean",
      repoRoot: repo,
      branch: clean.worktree.branch,
      ownerKind: "session",
      ownerId: clean.key,
    });
    expect(await fs.realpath(clean.worktree.path)).toBe(
      path.join(stateDir, "worktrees", cleanRecord?.repoFingerprint ?? "", "qa-session-clean"),
    );
    expect(await git(repo, "rev-parse", `refs/heads/${clean.worktree.branch}`)).toBe(baseCommit);

    const sessions = await call<SessionListResult>("sessions.list", { agentId: "qa" });
    expect(sessions.sessions).toContainEqual(
      expect.objectContaining({
        key: clean.key,
        spawnedCwd: clean.worktree.path,
        worktree: expect.objectContaining({
          id: clean.worktree.id,
          branch: clean.worktree.branch,
          repoRoot: repo,
        }),
      }),
    );

    const started = await call<GatewayRunResult>(
      "chat.send",
      {
        sessionKey: clean.key,
        message: "Session worktree QA. Reply exactly `SESSION_WORKTREE_OK`.",
        deliver: false,
        idempotencyKey: randomUUID(),
      },
      30_000,
    );
    expect(started).toMatchObject({ runId: expect.any(String), status: "started" });
    await waitForRun(started.runId);

    let gc = (await gateway.call("worktrees.gc", {})) as ManagedWorktreeGcReceipt;
    expect(gc).toMatchObject({ jobId: expect.any(String), state: "queued" });
    const jobId = gc.jobId;
    await expect
      .poll(
        async () => {
          gc = (await gateway.call("worktrees.gc", { jobId })) as ManagedWorktreeGcReceipt;
          return gc.state === "completed" || gc.state === "failed";
        },
        { timeout: 30_000, interval: 2_000 },
      )
      .toBe(true);
    expect(gc).toMatchObject({
      jobId,
      state: "completed",
      outcome: "completed",
      error: null,
      removed: expect.not.arrayContaining([clean.worktree.id]),
      orphansDeleted: expect.any(Number),
      snapshotsPruned: expect.any(Number),
    });
    const retained = (await listWorktrees()).worktrees.find(
      (record) => record.id === clean.worktree.id,
    );
    expect(retained).toMatchObject({ id: clean.worktree.id, ownerId: clean.key });
    expect(retained).not.toHaveProperty("removedAt");
    await expect(fs.readFile(path.join(clean.worktree.path, "README.md"), "utf8")).resolves.toBe(
      "base\n",
    );

    await deleteSession(clean);
    const cleanSnapshotRef = `refs/openclaw/snapshots/${clean.worktree.id}`;
    await expect(git(repo, "show-ref", "--verify", cleanSnapshotRef)).resolves.toContain(
      cleanSnapshotRef,
    );
    expect((await listWorktrees()).worktrees).toContainEqual(
      expect.objectContaining({
        id: clean.worktree.id,
        snapshotRef: cleanSnapshotRef,
        removedAt: expect.any(Number),
      }),
    );

    const dirty = await createSessionWorktree("qa-session-dirty");
    const dirtyFile = path.join(dirty.worktree.path, "untracked-note.txt");
    await fs.writeFile(dirtyFile, "restore this note\n");
    await deleteSession(dirty);
    const dirtySnapshotRef = `refs/openclaw/snapshots/${dirty.worktree.id}`;
    const dirtySnapshotCommit = await git(repo, "rev-parse", dirtySnapshotRef);

    const restored = await call<ManagedWorktreeRecord>("worktrees.restore", {
      id: dirty.worktree.id,
    });
    expect(restored).toMatchObject({
      id: dirty.worktree.id,
      branch: dirty.worktree.branch,
      path: dirty.worktree.path,
    });
    await expect(fs.readFile(dirtyFile, "utf8")).resolves.toBe("restore this note\n");
    expect((await git(restored.path, "status", "--porcelain")).split("\n")).toContain(
      "?? untracked-note.txt",
    );
    expect((await git(repo, "log", "--format=%H", restored.branch)).split("\n")).not.toContain(
      dirtySnapshotCommit,
    );

    const locked = await createSessionWorktree("qa-session-locked");
    await git(repo, "worktree", "lock", locked.worktree.path);
    const lockedDeleted = await call<SessionsDeleteResult>("sessions.delete", { key: locked.key });
    expect(lockedDeleted).toEqual(
      expect.objectContaining({
        deleted: true,
        worktreePreserved: {
          id: locked.worktree.id,
          branch: locked.worktree.branch,
          path: locked.worktree.path,
          reason: "foreign-lock",
        },
      }),
    );
    await fs.access(locked.worktree.path);
  },
);
