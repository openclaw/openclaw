import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerOperationSettlement } from "../../infra/sqlite-worker-operation-settlement.js";
import * as pidAlive from "../../shared/pid-alive.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import * as gitLock from "./git-lock.js";
import { lockState } from "./git-lock.js";
import * as registryRead from "./registry-read.js";
import { claimWorktreeRemovalRow, releaseWorktreeRunLeaseRow } from "./registry.js";
import { getRegistryWorktree } from "./registry.test-support.js";
import { prepareWorktreeRunEndClose } from "./run-end-lifecycle.js";
import { releaseWorktreeRunLeaseRowAsync } from "./run-lease-store.js";
import * as runLeaseStore from "./run-lease-store.js";
import { admitWorktreeRunLeaseInDatabase } from "./run-lease-store.kernel.js";
import {
  abortWorktreeRemoval,
  acquireWorktreeRunLease,
  claimWorktreeRemoval,
  hasLiveWorktreeRunLease,
  resolveWorktreeForPath,
} from "./run-lease.js";
import { testing as runLeaseTesting } from "./run-lease.test-support.js";
import { ManagedWorktreeService } from "./service.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}

async function initializeRepository(root: string): Promise<string> {
  const repo = path.join(root, "repo");
  await fs.mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "OpenClaw Test");
  await git(repo, "config", "user.email", "openclaw-test@example.invalid");
  await fs.writeFile(path.join(repo, "README.md"), "base\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  return await fs.realpath(repo);
}

describe("worktree run lease", () => {
  const templateTempDirs = useAutoCleanupTempDirTracker(afterAll);
  const caseTempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(async () => {
      vi.useRealTimers();
      await closeOpenClawStateDatabaseAsync();
      vi.restoreAllMocks();
      runLeaseTesting.resetForTest();
      vi.unstubAllEnvs();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });
  let templateRepo: string;
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let service: ManagedWorktreeService;

  beforeAll(async () => {
    const tempRoot = await fs.realpath(os.tmpdir());
    const templateRoot = templateTempDirs.make("openclaw-run-lease-template-", tempRoot);
    templateRepo = await initializeRepository(templateRoot);
  });

  beforeEach(async () => {
    const tempRoot = await fs.realpath(os.tmpdir());
    root = caseTempDirs.make("openclaw-run-lease-", tempRoot);
    repo = path.join(root, "repo");
    // Each case keeps a private .git directory; only repository construction is shared.
    await fs.cp(templateRepo, repo, { recursive: true });
    repo = await fs.realpath(repo);
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "openclaw-state") };
    service = new ManagedWorktreeService({ env });
  });

  async function createSessionWorktree() {
    const created = await service.create({
      repoRoot: repo,
      name: "run-lease-session",
      baseRef: "HEAD",
      ownerKind: "session",
      ownerId: "agent:main:run-lease",
    });
    return created;
  }

  it("shares one worktree across concurrent runs and refcounts the git lock", async () => {
    const created = await createSessionWorktree();
    let parent: Awaited<ReturnType<typeof acquireWorktreeRunLease>> | undefined;
    let child: typeof parent;
    try {
      const acquisitionSql = observeMainThreadSql();
      try {
        parent = await acquireWorktreeRunLease(created.id, { env });
        child = await acquireWorktreeRunLease(created.id, { env });
        acquisitionSql.expectIdle();
      } finally {
        acquisitionSql.restore();
      }

      const record = getRegistryWorktree(env, created.id);
      expect(record).toBeDefined();
      expect(await lockState(record!)).toEqual({ kind: "live", pid: process.pid });
      expect(hasLiveWorktreeRunLease(env, created.id)).toBe(true);

      const sql = observeMainThreadSql();
      try {
        await parent.release();
        sql.expectIdle();
      } finally {
        sql.restore();
      }
      expect(await lockState(record!)).toEqual({ kind: "live", pid: process.pid });
      expect(hasLiveWorktreeRunLease(env, created.id)).toBe(true);

      await child.release();
      expect(await lockState(record!)).toEqual({ kind: "none" });
      expect(hasLiveWorktreeRunLease(env, created.id)).toBe(false);
    } finally {
      await Promise.all([parent?.release(), child?.release()]);
    }
  });

  it("rejects admission when the linked Git admin directory is missing", async () => {
    const created = await createSessionWorktree();
    const knownFile = path.join(created.path, "README.md");
    const gitAdminDir = await git(created.path, "rev-parse", "--absolute-git-dir");
    const displacedGitAdminDir = path.join(root, "git-admin-aside");
    await fs.rename(gitAdminDir, displacedGitAdminDir);

    try {
      const acquisition = acquireWorktreeRunLease(created.id, { env });
      await expect(acquisition).rejects.toThrow(
        `managed worktree is unusable because its Git removal guard could not be acquired: ${created.path}`,
      );
      await expect(acquisition).rejects.toMatchObject({ cause: expect.any(Error) });
      expect(hasLiveWorktreeRunLease(env, created.id)).toBe(false);
      expect(await fs.readFile(knownFile, "utf8")).toBe("base\n");
    } finally {
      await fs.rename(displacedGitAdminDir, gitAdminDir);
    }

    const lease = await acquireWorktreeRunLease(created.id, { env });
    await lease.release();
    expect(hasLiveWorktreeRunLease(env, created.id)).toBe(false);
  });

  it.each([
    { settlement: "completed", guard: "live" },
    { settlement: "unknown", guard: "live" },
    { settlement: "completed", guard: "pending unlock" },
  ] as const)(
    "settles a lost admission reply with $settlement native outcome and a $guard Git guard",
    async ({ settlement, guard }) => {
      const created = await createSessionWorktree();
      const incumbent = await acquireWorktreeRunLease(created.id, { env });
      const record = getRegistryWorktree(env, created.id)!;
      let failUnlock = true;
      if (guard === "pending unlock") {
        const unlockWorktree = gitLock.unlockWorktree;
        vi.spyOn(gitLock, "unlockWorktree").mockImplementation(async (worktree) => {
          if (failUnlock) {
            throw new Error("Retain the incumbent Git guard");
          }
          await unlockWorktree(worktree);
        });
        await expect(incumbent.release()).rejects.toThrow("cleanup did not settle");
      }
      const accepted = createDeferred<SqliteWorkerOperationSettlement>();
      const reported = createDeferred<SqliteWorkerOperationSettlement>();
      const deliveryFailure = new Error("Run lease admission reply was lost");
      const execute = stateWorker.runOpenClawStateWorkerOperation;
      let admittedToken: string | undefined;
      const delivery = vi
        .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
        .mockImplementation((context, operation, options) => {
          const admission = options?.createAdmission;
          let admitting = false;
          return execute(
            context,
            (scope) =>
              operation({
                execute: async (command, executionOptions) => {
                  admitting = command.type === "worktrees.admitRunLease";
                  if (command.type !== "worktrees.admitRunLease") {
                    return scope.execute(command, executionOptions);
                  }
                  if (!admission) {
                    throw new Error("Expected retained run lease admission");
                  }
                  await scope.execute(command, executionOptions);
                  failUnlock = false;
                  throw deliveryFailure;
                },
              }),
            {
              ...options,
              createAdmission:
                admission &&
                ((retained) =>
                  admission(
                    admitting
                      ? {
                          settled: retained.settled.then((native) => {
                            // Keep the real write; fault only delivery and its settlement evidence.
                            accepted.resolve(native);
                            return reported.promise;
                          }),
                        }
                      : retained,
                  )),
            },
          );
        });
      const acquisition = acquireWorktreeRunLease(created.id, { env });
      const result = acquisition.then(
        (lease) => ({ ok: true as const, lease }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      const { db } = openOpenClawStateDatabase({ env });
      const tokens = () =>
        db
          .prepare("SELECT lease_key FROM state_leases WHERE scope = ? ORDER BY lease_key")
          .all(`worktree-run:${created.id}`)
          .map((row) => row.lease_key);
      const incumbentTokens = guard === "live" ? [incumbent.token] : [];
      try {
        const native = await Promise.race([
          accepted.promise,
          result.then(() => {
            throw new Error("Admission failed before native settlement");
          }),
        ]);
        expect(native.kind).toBe("completed");
        const insertedTokens = tokens().filter((token) => token !== incumbent.token);
        expect(insertedTokens).toHaveLength(1);
        const insertedToken = insertedTokens[0];
        if (typeof insertedToken !== "string") {
          throw new Error("Expected an admitted lease token");
        }
        admittedToken = insertedToken;
        expect(tokens()).toEqual([...incumbentTokens, admittedToken].toSorted());
        reported.resolve(
          settlement === "completed" ? native : { kind: "unknown", error: deliveryFailure },
        );
        if (settlement === "unknown") {
          await expect(result).resolves.toMatchObject({
            ok: false,
            error: { code: "outcome-unknown", cause: deliveryFailure },
          });
        } else {
          await expect(result).resolves.toEqual({ ok: false, error: deliveryFailure });
        }
        const remaining =
          settlement === "unknown"
            ? [...incumbentTokens, admittedToken].toSorted()
            : incumbentTokens;
        expect(tokens()).toEqual(remaining);
        // A failed admission never retained this guard, including its zero-refcount retry state.
        expect(await lockState(record)).toEqual({ kind: "live", pid: process.pid });
        await runLeaseTesting.drainPendingCleanupsForTest();
        expect(tokens()).toEqual(remaining);
        expect(await lockState(record)).toEqual(
          guard === "live" ? { kind: "live", pid: process.pid } : { kind: "none" },
        );
      } finally {
        reported.resolve({ kind: "completed" });
        const outcome = await result;
        delivery.mockRestore();
        if (outcome.ok) {
          await outcome.lease.release();
        }
        if (settlement === "unknown") {
          await incumbent.release().catch(() => {});
          // The real native write settled; discard only this fixture's injected uncertainty.
          runLeaseTesting.resetForTest();
        } else {
          await incumbent.release().catch(() => {});
          if (admittedToken) {
            await releaseWorktreeRunLeaseRowAsync(env, created.id, admittedToken);
          }
          failUnlock = false;
          await runLeaseTesting.drainPendingCleanupsForTest();
        }
      }
    },
  );

  it("excludes runs and publishers for the lifetime of an exclusive publication lease", async () => {
    const created = await createSessionWorktree();
    const running = await acquireWorktreeRunLease(created.id, { env });
    await expect(acquireWorktreeRunLease(created.id, { env, exclusive: true })).rejects.toThrow(
      "in use",
    );
    await running.release();
    const publication = await acquireWorktreeRunLease(created.id, { env, exclusive: true });
    await expect(acquireWorktreeRunLease(created.id, { env })).rejects.toThrow("in use");
    await expect(acquireWorktreeRunLease(created.id, { env, exclusive: true })).rejects.toThrow(
      "in use",
    );
    await expect(
      claimWorktreeRemoval(env, { worktreeId: created.id, token: "remove-during-publication" }),
    ).rejects.toThrow();
    await publication.release();
    const nextRun = await acquireWorktreeRunLease(created.id, { env });
    await nextRun.release();
    expect(hasLiveWorktreeRunLease(env, created.id)).toBe(false);
  });

  it("acquires a Git guard after a previous acquisition failed to read the registry", async () => {
    const created = await createSessionWorktree();
    const record = getRegistryWorktree(env, created.id)!;
    vi.spyOn(registryRead, "readRegistryWorktree").mockImplementationOnce(async () => {
      throw new Error("simulated registry read failure");
    });

    await expect(acquireWorktreeRunLease(created.id, { env })).rejects.toThrow(
      "simulated registry read failure",
    );
    expect(hasLiveWorktreeRunLease(env, created.id)).toBe(false);

    const lease = await acquireWorktreeRunLease(created.id, { env });
    expect(await lockState(record)).toEqual({ kind: "live", pid: process.pid });
    await lease.release();
    expect(await lockState(record)).toEqual({ kind: "none" });
  });

  it("retains the selected nested-workspace identity through lease admission", async () => {
    const created = await createSessionWorktree();
    const nested = path.join(created.path, "workspace");
    await fs.mkdir(nested);

    const selected = await resolveWorktreeForPath({ candidatePaths: [nested], env });
    expect(selected?.record.id).toBe(created.id);

    const lease = await acquireWorktreeRunLease(created.id, { source: selected });
    await expect(
      claimWorktreeRemoval(env, { worktreeId: created.id, token: "remover" }),
    ).rejects.toThrow("worktree is busy");
    await lease.release();

    openOpenClawStateDatabase({ env })
      .db.prepare("UPDATE worktrees SET branch = ? WHERE id = ?")
      .run("replacement-branch", created.id);
    await expect(acquireWorktreeRunLease(created.id, { source: selected })).rejects.toThrow(
      /changed/,
    );
    expect(hasLiveWorktreeRunLease(env, created.id)).toBe(false);
    expect(await lockState(created)).toEqual({ kind: "none" });
  });

  it("prunes a dead owner lease so removal can proceed", async () => {
    const created = await createSessionWorktree();
    runOpenClawStateWriteTransaction(
      ({ db }) =>
        admitWorktreeRunLeaseInDatabase(db, {
          worktreeId: created.id,
          token: "dead-owner",
          pid: 2_147_483_647,
          startTime: 4242,
          now: 1,
        }),
      { env },
    );
    expect(hasLiveWorktreeRunLease(env, created.id)).toBe(false);
    await expect(
      claimWorktreeRemoval(env, { worktreeId: created.id, token: "remover" }),
    ).resolves.toBeUndefined();
  });

  it("prunes a reused pid whose start time no longer matches", async () => {
    const created = await createSessionWorktree();
    runOpenClawStateWriteTransaction(
      ({ db }) =>
        admitWorktreeRunLeaseInDatabase(db, {
          worktreeId: created.id,
          token: "reused-pid",
          pid: process.pid,
          startTime: 111,
          now: 1,
        }),
      { env },
    );
    const processStart = vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockReturnValue(222);

    expect(hasLiveWorktreeRunLease(env, created.id)).toBe(false);
    processStart.mockRestore();

    const lease = await acquireWorktreeRunLease(created.id, { env });
    expect(lease.token).not.toBe("reused-pid");
    expect(hasLiveWorktreeRunLease(env, created.id)).toBe(true);
    await lease.release();
    expect(hasLiveWorktreeRunLease(env, created.id)).toBe(false);
  });

  it("rejects removal while a live lease exists", async () => {
    const created = await createSessionWorktree();
    const lease = await acquireWorktreeRunLease(created.id, { env });

    await expect(
      claimWorktreeRemoval(env, { worktreeId: created.id, token: "remover" }),
    ).rejects.toThrow("worktree is busy");
    await lease.release();
  });

  it("fails admission once a removal claim is held", async () => {
    const created = await createSessionWorktree();
    await claimWorktreeRemoval(env, { worktreeId: created.id, token: "remover" });

    await expect(acquireWorktreeRunLease(created.id, { env })).rejects.toThrow(
      `managed worktree was removed: ${created.path}`,
    );
  });

  it("recovers admission when the remover died before finalizing the removal", async () => {
    const created = await createSessionWorktree();
    await claimWorktreeRemovalRow(env, {
      worktreeId: created.id,
      token: "remover",
      pid: 2_147_483_647,
      startTime: null,
      now: 1,
    });

    const lease = await acquireWorktreeRunLease(created.id, { env });
    expect(lease.token).toBeTruthy();
    await lease.release();
  });

  it("rejects a second live remover until the first releases", async () => {
    const created = await createSessionWorktree();
    await claimWorktreeRemoval(env, { worktreeId: created.id, token: "remover-a" });

    await expect(
      claimWorktreeRemoval(env, { worktreeId: created.id, token: "remover-b" }),
    ).rejects.toThrow("worktree removal is already in progress");

    await abortWorktreeRemoval(env, created.id, "remover-a");
    await expect(
      claimWorktreeRemoval(env, { worktreeId: created.id, token: "remover-b" }),
    ).resolves.toBeUndefined();
  });

  it("recovers a transient release failure within a single release call", async () => {
    const created = await createSessionWorktree();
    const lease = await acquireWorktreeRunLease(created.id, { env });
    const record = getRegistryWorktree(env, created.id)!;

    let attempts = 0;
    vi.spyOn(runLeaseStore, "releaseWorktreeRunLeaseRowAsync").mockImplementation(
      async (rowEnv, id, token) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("simulated state database failure");
        }
        releaseWorktreeRunLeaseRow(rowEnv, id, token);
      },
    );

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const release = lease.release();
    let concurrentReleaseSettled = false;
    const concurrentRelease = lease.release().then(() => {
      concurrentReleaseSettled = true;
    });
    await Promise.resolve();
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(24);
    expect(attempts).toBe(1);
    expect(concurrentReleaseSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await release;
    await concurrentRelease;
    vi.useRealTimers();
    expect(attempts).toBe(2);
    expect(hasLiveWorktreeRunLease(env, created.id)).toBe(false);
    expect(await lockState(record)).toEqual({ kind: "none" });
  });

  it("retains the lease and git guard across sustained delete failures, freeing on a lifecycle retry", async () => {
    const created = await createSessionWorktree();
    const lease = await acquireWorktreeRunLease(created.id, { env });
    const record = getRegistryWorktree(env, created.id)!;

    let fail = true;
    vi.spyOn(runLeaseStore, "releaseWorktreeRunLeaseRowAsync").mockImplementation(
      async (rowEnv, id, token) => {
        if (fail) {
          throw new Error("simulated state database failure");
        }
        releaseWorktreeRunLeaseRow(rowEnv, id, token);
      },
    );

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const release = expect(lease.release()).rejects.toThrow("cleanup did not settle");
    await vi.advanceTimersByTimeAsync(75);
    await release;
    vi.useRealTimers();
    expect(hasLiveWorktreeRunLease(env, created.id)).toBe(true);
    expect(await lockState(record)).toEqual({ kind: "live", pid: process.pid });
    await expect(
      claimWorktreeRemoval(env, { worktreeId: created.id, token: "remover" }),
    ).rejects.toThrow("worktree is busy");

    vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
    const closing = prepareWorktreeRunEndClose();
    closing.beginClose();
    await expect(closing.drain()).rejects.toThrow("cleanup remains unsettled");
    expect(openOpenClawStateDatabase({ env }).db.isOpen).toBe(true);

    fail = false;
    await runLeaseTesting.drainPendingCleanupsForTest();
    expect(hasLiveWorktreeRunLease(env, created.id)).toBe(false);
    expect(await lockState(record)).toEqual({ kind: "none" });
    const successor = prepareWorktreeRunEndClose();
    await expect(
      claimWorktreeRemoval(env, { worktreeId: created.id, token: "remover" }),
    ).resolves.toBeUndefined();
    successor.beginClose();
    await successor.drain();
  });

  it("serializes overlapping same-process acquisitions so the guard holds until the last release", async () => {
    const created = await createSessionWorktree();
    const record = getRegistryWorktree(env, created.id)!;

    const [first, second] = await Promise.all([
      acquireWorktreeRunLease(created.id, { env }),
      acquireWorktreeRunLease(created.id, { env }),
    ]);

    expect(await lockState(record)).toEqual({ kind: "live", pid: process.pid });
    await first.release();
    expect(await lockState(record)).toEqual({ kind: "live", pid: process.pid });
    await second.release();
    expect(await lockState(record)).toEqual({ kind: "none" });
  });

  it("retains an unknown release without replaying it during lifecycle cleanup", async () => {
    const created = await createSessionWorktree();
    const lease = await acquireWorktreeRunLease(created.id, { env });
    const failure = new SqliteWorkerError(
      "Synthetic release settlement was lost",
      "outcome-unknown",
    );
    const releaseRow = vi
      .spyOn(runLeaseStore, "releaseWorktreeRunLeaseRowAsync")
      .mockRejectedValue(failure);
    try {
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      const release = expect(lease.release()).rejects.toBe(failure);
      await vi.advanceTimersByTimeAsync(75);
      await release;
      vi.useRealTimers();
      await runLeaseTesting.drainPendingCleanupsForTest();
      await expect(lease.release()).rejects.toBe(failure);
      expect(releaseRow).toHaveBeenCalledOnce();
      expect(hasLiveWorktreeRunLease(env, created.id)).toBe(true);
      expect(await lockState(created)).toEqual({ kind: "live", pid: process.pid });
      vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
      const closing = prepareWorktreeRunEndClose();
      closing.beginClose();
      await expect(closing.drain()).rejects.toThrow("cleanup remains unsettled");
    } finally {
      // The fault left this synthetic row untouched; teardown must not replay the release.
      runLeaseTesting.resetForTest();
    }
  });

  it.each(["unlock", "registry read"])(
    "retains the Git guard when %s fails, releasing it on a lifecycle retry",
    async (failure) => {
      const created = await createSessionWorktree();
      const lease = await acquireWorktreeRunLease(created.id, { env });
      const record = getRegistryWorktree(env, created.id)!;

      let fail = true;
      if (failure === "unlock") {
        const unlockWorktree = gitLock.unlockWorktree;
        vi.spyOn(gitLock, "unlockWorktree").mockImplementation(async (rec) => {
          if (fail) {
            throw new Error("simulated git unlock failure");
          }
          await unlockWorktree(rec);
        });
      } else {
        const readWorktree = registryRead.readRegistryWorktree;
        vi.spyOn(registryRead, "readRegistryWorktree").mockImplementation(async (...args) => {
          if (fail) {
            throw new Error("simulated registry read failure");
          }
          return readWorktree(...args);
        });
      }

      await expect(lease.release()).rejects.toThrow("cleanup did not settle");
      expect(hasLiveWorktreeRunLease(env, created.id)).toBe(false);
      expect(await lockState(record)).toEqual({ kind: "live", pid: process.pid });

      fail = false;
      await runLeaseTesting.drainPendingCleanupsForTest();
      expect(await lockState(record)).toEqual({ kind: "none" });
    },
  );

  it("does not let a failed cleanup unlock a newer holder generation", async () => {
    const created = await createSessionWorktree();
    const first = await acquireWorktreeRunLease(created.id, { env });
    const record = getRegistryWorktree(env, created.id)!;

    let failUnlock = true;
    const unlockWorktree = gitLock.unlockWorktree;
    vi.spyOn(gitLock, "unlockWorktree").mockImplementation(async (rec) => {
      if (failUnlock) {
        throw new Error("simulated git unlock failure");
      }
      await unlockWorktree(rec);
    });

    await expect(first.release()).rejects.toThrow("cleanup did not settle");
    expect(await lockState(record)).toEqual({ kind: "live", pid: process.pid });

    const second = await acquireWorktreeRunLease(created.id, { env });
    failUnlock = false;
    await runLeaseTesting.drainPendingCleanupsForTest();
    expect(await lockState(record)).toEqual({ kind: "live", pid: process.pid });

    await second.release();
    expect(await lockState(record)).toEqual({ kind: "none" });
  });

  it("fails closed when a session's authoritative worktree binding is removed", async () => {
    const created = await createSessionWorktree();
    await service.remove({
      id: created.id,
      reason: "manual-delete",
      allowSnapshotLoss: true,
    });

    await expect(
      resolveWorktreeForPath({
        sessionEntry: { worktree: { id: created.id } },
        candidatePaths: [],
        env,
      }),
    ).rejects.toThrow("managed worktree was removed");
  });

  it("does not let a superseded remover clear a newer removal claim", async () => {
    const created = await createSessionWorktree();
    await claimWorktreeRemovalRow(env, {
      worktreeId: created.id,
      token: "remover-a",
      pid: 2_147_483_647,
      startTime: null,
      now: 1,
    });
    await claimWorktreeRemoval(env, { worktreeId: created.id, token: "remover-b" });

    await abortWorktreeRemoval(env, created.id, "remover-a");
    await expect(acquireWorktreeRunLease(created.id, { env })).rejects.toThrow(
      "managed worktree was removed",
    );
  });
});
