import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
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
import { git } from "./git-fixture.test-support.js";
import * as gitLock from "./git-lock.js";
import { lockState } from "./git-lock.js";
import * as registryRead from "./registry-read.js";
import { claimWorktreeRemovalRow, releaseWorktreeRunLeaseRow } from "./registry.js";
import { prepareWorktreeRunEndClose } from "./run-end-lifecycle.js";
import { releaseWorktreeRunLeaseRowAsync } from "./run-lease-store.js";
import * as runLeaseStore from "./run-lease-store.js";
import { admitWorktreeRunLeaseInDatabase } from "./run-lease-store.kernel.js";
import {
  abortWorktreeRemoval,
  acquireWorktreeRunLease,
  claimWorktreeRemoval,
  resolveWorktreeForPath,
} from "./run-lease.js";
import { hasLiveWorktreeRunLease, testing as runLeaseTesting } from "./run-lease.test-support.js";
import { ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";
import type { ManagedWorktreeRecord } from "./types.js";

describe("worktree run lease", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  const caseTempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(async () => {
      vi.useRealTimers();
      await closeOpenClawStateDatabaseAsync();
      vi.restoreAllMocks();
      resetConfigRuntimeState();
      runLeaseTesting.resetForTest();
      vi.unstubAllEnvs();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let service: ManagedWorktreeService;
  let created: ManagedWorktreeRecord;

  beforeEach(async () => {
    root = await fs.realpath(caseTempDirs.make("openclaw-run-lease-"));
    repo = await initializeRepository(root);
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "openclaw-state") };
    vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
    setRuntimeConfigSnapshot({}, {});
    service = new ManagedWorktreeService({ env });
    created = await service.create({
      repoRoot: repo,
      name: "run-lease-session",
      baseRef: "HEAD",
      ownerKind: "session",
      ownerId: "agent:main:run-lease",
    });
  });

  const acquire = (options: Parameters<typeof acquireWorktreeRunLease>[1] = {}) =>
    acquireWorktreeRunLease(created.id, { env, ...options });
  const live = () => hasLiveWorktreeRunLease(env, created.id);
  const lock = () => lockState(created);
  const claim = (token = "remover") => claimWorktreeRemoval(env, { worktreeId: created.id, token });
  async function expectCustody(retained: boolean) {
    expect(live()).toBe(retained);
    expect(await lock()).toEqual(retained ? { kind: "live", pid: process.pid } : { kind: "none" });
  }
  function failUnlockWhile(failing: () => boolean) {
    const unlock = gitLock.unlockWorktree;
    vi.spyOn(gitLock, "unlockWorktree").mockImplementation(async (record) => {
      if (failing()) {
        throw new Error("simulated git unlock failure");
      }
      await unlock(record);
    });
  }
  async function withoutHostSql<T>(run: () => Promise<T>): Promise<T> {
    const sql = observeMainThreadSql();
    try {
      const result = await run();
      sql.expectIdle();
      return result;
    } finally {
      sql.restore();
    }
  }
  function seedRunLease(token: string, pid: number, startTime: number) {
    runOpenClawStateWriteTransaction(
      ({ db }) =>
        admitWorktreeRunLeaseInDatabase(db, {
          worktreeId: created.id,
          token,
          pid,
          startTime,
          now: 1,
        }),
      { env },
    );
  }

  it("shares concurrent runs with SQL-free admission and refcounted Git custody", async () => {
    let parent: Awaited<ReturnType<typeof acquireWorktreeRunLease>> | undefined;
    let child: typeof parent;
    try {
      [parent, child] = await withoutHostSql(() => Promise.all([acquire(), acquire()]));
      await expectCustody(true);
      await withoutHostSql(() => parent!.release());
      await expectCustody(true);

      await child.release();
      await expectCustody(false);
    } finally {
      await Promise.all([parent?.release(), child?.release()]);
    }
  });

  it("rejects admission when the linked Git admin directory is missing", async () => {
    const knownFile = path.join(created.path, "README.md");
    const gitAdminDir = await git(created.path, "rev-parse", "--absolute-git-dir");
    const displacedGitAdminDir = path.join(root, "git-admin-aside");
    await fs.rename(gitAdminDir, displacedGitAdminDir);

    try {
      const acquisition = acquire();
      await expect(acquisition).rejects.toThrow(
        `managed worktree is unusable because its Git removal guard could not be acquired: ${created.path}`,
      );
      await expect(acquisition).rejects.toMatchObject({ cause: expect.any(Error) });
      expect(live()).toBe(false);
      expect(await fs.readFile(knownFile, "utf8")).toBe("base\n");
    } finally {
      await fs.rename(displacedGitAdminDir, gitAdminDir);
    }

    const lease = await acquire();
    await lease.release();
    expect(live()).toBe(false);
  });

  it.each([
    { settlement: "completed", guard: "live" },
    { settlement: "unknown", guard: "live" },
    { settlement: "completed", guard: "pending unlock" },
  ] as const)(
    "settles a lost admission reply with $settlement native outcome and a $guard Git guard",
    async ({ settlement, guard }) => {
      const incumbent = await acquire();
      let failUnlock = true;
      if (guard === "pending unlock") {
        failUnlockWhile(() => failUnlock);
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
      const acquisition = acquire();
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
          const recovered = await acquisition;
          expect(recovered).toMatchObject({ id: created.id, token: admittedToken });
          expect(tokens()).toEqual([...incumbentTokens, admittedToken].toSorted());
          expect(await lock()).toEqual({ kind: "live", pid: process.pid });
          await runLeaseTesting.drainPendingCleanupsForTest();
          expect(tokens()).toEqual([...incumbentTokens, admittedToken].toSorted());
          expect(await lock()).toEqual({ kind: "live", pid: process.pid });
          await recovered.release();
        }
        const remaining =
          settlement === "unknown"
            ? [...incumbentTokens, admittedToken].toSorted()
            : incumbentTokens;
        expect(tokens()).toEqual(remaining);
        expect(await lock()).toEqual(
          guard === "live" ? { kind: "live", pid: process.pid } : { kind: "none" },
        );
        await runLeaseTesting.drainPendingCleanupsForTest();
        expect(tokens()).toEqual(remaining);
        expect(await lock()).toEqual(
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
    const running = await acquire();
    await expect(acquire({ exclusive: true })).rejects.toThrow("in use");
    await running.release();
    const publication = await acquire({ exclusive: true });
    await expect(acquire()).rejects.toThrow("in use");
    await expect(acquire({ exclusive: true })).rejects.toThrow("in use");
    await expect(claim("remove-during-publication")).rejects.toThrow();
    await publication.release();
    const nextRun = await acquire();
    await nextRun.release();
    expect(live()).toBe(false);
  });

  it("acquires a Git guard after a previous acquisition failed to read the registry", async () => {
    vi.spyOn(registryRead, "readRegistryWorktree").mockImplementationOnce(async () => {
      throw new Error("simulated registry read failure");
    });

    await expect(acquire()).rejects.toThrow("simulated registry read failure");
    expect(live()).toBe(false);

    const lease = await acquire();
    expect(await lock()).toEqual({ kind: "live", pid: process.pid });
    await lease.release();
    expect(await lock()).toEqual({ kind: "none" });
  });

  it("retains the selected nested-workspace identity through lease admission", async () => {
    const nested = path.join(created.path, "workspace");
    await fs.mkdir(nested);

    const selected = await resolveWorktreeForPath({ candidatePaths: [nested] });
    expect(selected?.record.id).toBe(created.id);

    const lease = await acquire({ source: selected });
    await expect(claim()).rejects.toThrow("worktree is busy");
    await lease.release();

    openOpenClawStateDatabase({ env })
      .db.prepare("UPDATE worktrees SET branch = ? WHERE id = ?")
      .run("replacement-branch", created.id);
    await expect(acquire({ source: selected })).rejects.toThrow(/changed/);
    await expectCustody(false);
  });

  it("prunes a dead owner lease so removal can proceed", async () => {
    seedRunLease("dead-owner", 2_147_483_647, 4242);
    expect(live()).toBe(false);
    await expect(claim()).resolves.toBeUndefined();
  });

  it("prunes a reused pid whose start time no longer matches", async () => {
    seedRunLease("reused-pid", process.pid, 111);
    const processStart = vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockReturnValue(222);

    expect(live()).toBe(false);
    processStart.mockRestore();

    const lease = await acquire();
    expect(lease.token).not.toBe("reused-pid");
    expect(live()).toBe(true);
    await lease.release();
    expect(live()).toBe(false);
  });

  it("recovers admission when the remover died before finalizing the removal", async () => {
    await claimWorktreeRemovalRow(env, {
      worktreeId: created.id,
      token: "remover",
      pid: 2_147_483_647,
      startTime: null,
      now: 1,
    });

    const lease = await acquire();
    expect(lease.token).toBeTruthy();
    await lease.release();
  });

  it("recovers a transient release failure within a single release call", async () => {
    const lease = await acquire();

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
    await expectCustody(false);
  });

  it.each(["retryable", "unknown"] as const)(
    "retains %s release custody during lifecycle cleanup",
    async (kind) => {
      const lease = await acquire();
      const unknown = kind === "unknown";
      const failure = unknown
        ? new SqliteWorkerError("Synthetic release settlement was lost", "outcome-unknown")
        : new Error("simulated state database failure");
      let fail = true;
      const releaseRow = vi
        .spyOn(runLeaseStore, "releaseWorktreeRunLeaseRowAsync")
        .mockImplementation(async (rowEnv, id, token) => {
          if (fail) {
            throw failure;
          }
          releaseWorktreeRunLeaseRow(rowEnv, id, token);
        });
      try {
        vi.useFakeTimers({ toFake: ["setTimeout"] });
        const rejected = expect(lease.release()).rejects;
        const release = unknown
          ? rejected.toBe(failure)
          : rejected.toThrow("cleanup did not settle");
        await vi.advanceTimersByTimeAsync(75);
        await release;
        vi.useRealTimers();
        if (unknown) {
          await runLeaseTesting.drainPendingCleanupsForTest();
          await expect(lease.release()).rejects.toBe(failure);
          expect(releaseRow).toHaveBeenCalledOnce();
        } else {
          await expect(claim()).rejects.toThrow("worktree is busy");
        }
        await expectCustody(true);
        vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
        const closing = prepareWorktreeRunEndClose();
        closing.beginClose();
        await expect(closing.drain()).rejects.toThrow("cleanup remains unsettled");
        if (!unknown) {
          expect(openOpenClawStateDatabase({ env }).db.isOpen).toBe(true);
          fail = false;
          await runLeaseTesting.drainPendingCleanupsForTest();
          await expectCustody(false);
          const successor = prepareWorktreeRunEndClose();
          await expect(claim()).resolves.toBeUndefined();
          successor.beginClose();
          await successor.drain();
        }
      } finally {
        // An uncertain release must never be replayed by fixture teardown.
        if (unknown) {
          runLeaseTesting.resetForTest();
        }
      }
    },
  );

  it.each(["unlock", "registry read"])(
    "retains the Git guard when %s fails, releasing it on a lifecycle retry",
    async (failure) => {
      const lease = await acquire();

      let fail = true;
      if (failure === "unlock") {
        failUnlockWhile(() => fail);
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
      expect(live()).toBe(false);
      expect(await lock()).toEqual({ kind: "live", pid: process.pid });

      fail = false;
      await runLeaseTesting.drainPendingCleanupsForTest();
      expect(await lock()).toEqual({ kind: "none" });
    },
  );

  it("does not let a failed cleanup unlock a newer holder generation", async () => {
    const first = await acquire();

    let failUnlock = true;
    failUnlockWhile(() => failUnlock);

    await expect(first.release()).rejects.toThrow("cleanup did not settle");
    expect(await lock()).toEqual({ kind: "live", pid: process.pid });

    const second = await acquire();
    failUnlock = false;
    await runLeaseTesting.drainPendingCleanupsForTest();
    expect(await lock()).toEqual({ kind: "live", pid: process.pid });

    await second.release();
    expect(await lock()).toEqual({ kind: "none" });
  });

  it("fails closed when a session's authoritative worktree binding is removed", async () => {
    await service.remove({
      id: created.id,
      reason: "manual-delete",
      allowSnapshotLoss: true,
    });

    await expect(
      resolveWorktreeForPath({
        sessionEntry: { worktree: { id: created.id } },
        candidatePaths: [],
      }),
    ).rejects.toThrow("managed worktree was removed");
  });

  it("does not let a superseded remover clear a newer removal claim", async () => {
    await claimWorktreeRemovalRow(env, {
      worktreeId: created.id,
      token: "remover-a",
      pid: 2_147_483_647,
      startTime: null,
      now: 1,
    });
    await claim("remover-b");

    await abortWorktreeRemoval(env, created.id, "remover-a");
    await expect(acquire()).rejects.toThrow(`managed worktree was removed: ${created.path}`);
  });
});
