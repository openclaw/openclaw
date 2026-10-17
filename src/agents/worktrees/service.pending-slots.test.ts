import fs from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import * as backoff from "../../infra/backoff.js";
import * as gitExec from "../../infra/git-exec.js";
import * as gitWorker from "../../infra/git-worker.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import * as stateLease from "../../state/openclaw-state-lease.js";
import { WORKTREE_CREATE_LEASE_SCOPE, WORKTREE_MUTATION_LEASE_SCOPE } from "./capacity-contract.js";
import {
  WorktreeCapacityContentionError,
  WORKTREE_CAPACITY_RESERVATION_SCOPE,
} from "./capacity.js";
import { requireGit } from "./git.js";
import { readPendingWorktrees } from "./pending-slots.js";
import * as registry from "./registry.js";
import { captureWorktreeRunEndContext } from "./run-end-lifecycle.js";
import { createWithWorktreeAllocation } from "./service-preparation.js";
import {
  expectFile,
  expectMissing,
  writeFile,
  atGate,
  useServiceFixture,
} from "./service-scenarios.test-support.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";
import type { ManagedWorktreeRecord } from "./types.js";

describe("managed worktree pending slots", () => {
  const config = { worktreeMaxCount: 2, worktreeAcceleration: false };
  beforeEach(() => {
    config.worktreeMaxCount = 2;
  });
  const f = useServiceFixture(useManagedWorktreeTestRepository(), {
    prefix: "openclaw-worktree-pending-",
    getConfig: () => config,
    resetDatabase: false,
  });

  function holdMaterialization(failure?: Error, partial = false) {
    const entered = [createDeferred<string>(), createDeferred<string>()];
    const waiting = [...entered];
    const release = createDeferred();
    const operations: Promise<unknown>[] = [];
    const execute = gitExec.executeGitCommand;
    const injection = vi
      .spyOn(gitExec, "executeGitCommand")
      .mockImplementation(async (cwd, args, options) => {
        if (args[0] === "read-tree" && args.includes("-u") && (!failure || waiting.length === 2)) {
          if (partial) {
            await writeFile(cwd, "partial.txt", "uncertain native output\n");
          }
          waiting.shift()?.resolve(cwd);
          await release.promise;
          if (failure) {
            throw failure;
          }
        }
        return await execute(cwd, args, options);
      });
    function track<T>(operation: Promise<T>) {
      operations.push(operation);
      return operation;
    }
    return {
      release,
      track,
      create: (...args: Parameters<typeof f.create>) => track(f.create(...args)),
      restore: () => injection.mockRestore(),
      async close() {
        release.resolve();
        await Promise.allSettled(operations);
      },
      wait: (work: Promise<unknown>, signal: AbortSignal, index = 0) =>
        atGate(entered[index]!.promise, work, "Checkout did not materialize", signal),
    };
  }

  const registryIds = async () => (await f.service.listRegistryRecords()).map(({ id }) => id);
  const ownerParams = (ownerId: string) => ({ ownerKind: "session" as const, ownerId });
  async function expectPublished(record: ManagedWorktreeRecord) {
    expect(await readPendingWorktrees(f.env)).toEqual([]);
    expect(await f.service.listRegistryRecords()).toEqual([record]);
    await expectFile(record.path, "README.md", "base\n");
  }

  function observePendingWait(id: string) {
    const waiting = createDeferred();
    const acquire = stateLease.withOpenClawStateLeaseAsync;
    vi.spyOn(stateLease, "withOpenClawStateLeaseAsync").mockImplementation(
      (options, context, run) => {
        if (options.scope === WORKTREE_MUTATION_LEASE_SCOPE && options.key === id) {
          waiting.resolve();
        }
        return acquire(options, context, run);
      },
    );
    return waiting.promise;
  }

  async function holdLease(scope: string, key: string) {
    const entered = createDeferred();
    const release = createDeferred();
    const holder = stateLease.withOpenClawStateLeaseAsync(
      { scope, key, leaseMs: 60_000, waitMs: 0 },
      captureWorktreeRunEndContext(f.env),
      async () => {
        entered.resolve();
        await release.promise;
      },
    );
    await awaitGateBeforeSettlement(entered.promise, holder, "Holder did not acquire its lease");
    return async () => {
      release.resolve();
      await holder;
    };
  }

  const withCapacityLease = async () =>
    (await holdLease(WORKTREE_CREATE_LEASE_SCOPE, "capacity"))();

  function markPendingOwnerDead(record: ManagedWorktreeRecord) {
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<Pick<DB, "state_leases">>(db)
            .updateTable("state_leases")
            .set({
              payload_json: JSON.stringify({
                state: "pending",
                record,
                owner: { pid: 2147483647, host: hostname(), startedAt: null },
              }),
            })
            .where("scope", "=", "core:managed-worktrees:pending-slots")
            .where("lease_key", "=", record.id),
        );
      },
      { env: f.env },
    );
  }

  it("keeps one contention budget when creation retries after another holder settles", async () => {
    const releaseFirst = await holdLease(WORKTREE_CAPACITY_RESERVATION_SCOPE, "first");
    const releaseSecond = await holdLease(WORKTREE_CAPACITY_RESERVATION_SCOPE, "second");
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const run = vi
      .fn()
      .mockRejectedValueOnce(new WorktreeCapacityContentionError("disk reserved", "first"))
      .mockRejectedValue(new WorktreeCapacityContentionError("disk reserved", "second"));
    vi.spyOn(backoff, "sleepWithAbort")
      .mockImplementationOnce(async () => {
        clock += 29 * 60_000;
        await releaseFirst();
      })
      .mockImplementationOnce(async () => {
        clock += 60_001;
      });
    try {
      await expect(
        createWithWorktreeAllocation({ env: f.env }, run, async () => {}),
      ).rejects.toThrow(/timed out.*openclaw worktrees gc/);
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      await releaseFirst();
      await releaseSecond();
    }
  });

  it("publishes after 30 minutes of contention and two minutes of preparation", async () => {
    const release = await holdLease(WORKTREE_CREATE_LEASE_SCOPE, "capacity");
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.spyOn(backoff, "sleepWithAbort").mockImplementationOnce(async () => {
      clock += 30 * 60_000;
      await release();
    });
    const execute = gitExec.executeGitCommand;
    vi.spyOn(gitExec, "executeGitCommand").mockImplementation(async (cwd, args, options) => {
      const result = await execute(cwd, args, options);
      if (args[0] === "read-tree" && args.includes("-u")) {
        clock += 2 * 60_000;
      }
      return result;
    });
    try {
      const created = await f.create("slow-preparation");
      expect(clock).toBe((30 + 2) * 60_000);
      await expectPublished(created);
    } finally {
      await release();
    }
  });

  it("keeps Git dependency inspection outside capacity admission", async () => {
    const run = gitWorker.runGitWorkerOperation;
    vi.spyOn(gitWorker, "runGitWorkerOperation").mockImplementation(async (operation, options) => {
      if (operation.type === "worktree.eviction-source") {
        await withCapacityLease();
      }
      return run(operation, options);
    });
    await expectPublished(await f.create("source-inspection"));
  });

  it("keeps Git name discovery outside capacity admission", async ({ signal }) => {
    const entered = createDeferred();
    const release = createDeferred();
    const execute = gitExec.executeGitCommand;
    vi.spyOn(gitExec, "executeGitCommand").mockImplementation(async (cwd, args, options) => {
      if (args[0] === "show-ref" || args[0] === "for-each-ref") {
        entered.resolve();
        await release.promise;
      }
      return execute(cwd, args, options);
    });
    const creating = f.create("name-discovery");
    try {
      await atGate(entered.promise, creating, "Git name discovery did not start", signal);
      await withCapacityLease();
    } finally {
      release.resolve();
      await Promise.allSettled([creating]);
    }
    await expectPublished(await creating);
  });

  it("overlaps materialization after releasing the allocation lease", async ({ signal }) => {
    const held = holdMaterialization();
    const creating = [held.create("first")];
    try {
      await held.wait(creating[0]!, signal);
      // A zero-wait contender makes the old global lease fail directly, without a timing race.
      await withCapacityLease();
      creating.push(held.create("second"));
      await held.wait(creating[1]!, signal, 1);
      expect(await readPendingWorktrees(f.env)).toHaveLength(2);
      expect(await f.service.listRegistryRecords()).toEqual([]);
    } finally {
      await held.close();
    }
    const records = await Promise.all(creating);
    expect(await readPendingWorktrees(f.env)).toEqual([]);
    expect((await f.service.listRegistryRecords()).map(({ id }) => id).toSorted()).toEqual(
      records.map(({ id }) => id).toSorted(),
    );
    for (const record of records) {
      await expectFile(record.path, "README.md", "base\n");
    }
  });

  it("publishes a reserved checkout while another creator holds allocation", async ({ signal }) => {
    config.worktreeMaxCount = 1;
    const held = holdMaterialization();
    const creating = held.create("publish-reserved");
    let releaseAllocation: (() => Promise<void>) | undefined;
    try {
      await held.wait(creating, signal);
      expect(await readPendingWorktrees(f.env)).toHaveLength(1);
      releaseAllocation = await holdLease(WORKTREE_CREATE_LEASE_SCOPE, "capacity");
      // An occupied allocation lane must not delay the count-neutral pending → live transaction.
      vi.spyOn(backoff, "sleepWithAbort").mockRejectedValue(
        new Error("Publication waited for allocation"),
      );
      held.release.resolve();
      const created = await withinTest(creating, signal);
      await expectPublished(created);
    } finally {
      held.release.resolve();
      await releaseAllocation?.();
      await held.close();
    }
  });

  it("counts pending slots at admission and keeps them out of eviction", async ({ signal }) => {
    config.worktreeMaxCount = 1;
    const held = holdMaterialization();
    const creating = held.create("pending");
    const creates = [creating];
    try {
      const checkoutPath = await held.wait(creating, signal);
      const pending = await readPendingWorktrees(f.env);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.record.path).toBe(checkoutPath);
      const waiting = observePendingWait(pending[0]!.record.id);
      const overflow = held.create("overflow");
      creates.push(overflow);
      await atGate(waiting, overflow, "Cap contender did not wait for the pending slot", signal);
      // A native clone may temporarily replace .git; pending custody still owns the whole path.
      async function collectWhileAbsent(target: string, retained: string) {
        const temporary = path.join(f.stateDir, "materializing-checkout");
        await fs.rename(target, temporary);
        try {
          const collection = await withinTest(held.track(f.service.gc()), signal);
          expect(collection).toMatchObject({ removed: [], orphansDeleted: 0, orphansRetired: 0 });
          expect((await fs.stat(retained)).isDirectory()).toBe(true);
        } finally {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.rename(temporary, target);
        }
      }
      await collectWhileAbsent(path.join(checkoutPath, ".git"), checkoutPath);
      // Clone replacement can also leave no directory; GC must retain its fingerprint parent.
      await collectWhileAbsent(checkoutPath, path.dirname(checkoutPath));
      expect(await readPendingWorktrees(f.env)).toEqual(pending);
      expect(await requireGit(f.repo, ["branch", "--list", "openclaw/overflow"])).toBe("");
    } finally {
      await held.close();
    }
    const [first, overflow] = await Promise.all(creates);
    const records = await f.service.listRegistryRecords();
    expect(records.filter(({ removedAt }) => removedAt === undefined).map(({ id }) => id)).toEqual([
      overflow!.id,
    ]);
    expect(records.filter(({ removedAt }) => removedAt !== undefined).map(({ id }) => id)).toEqual([
      first!.id,
    ]);
    expect(await readPendingWorktrees(f.env)).toEqual([]);
  });

  it.for(["name", "owner"] as const)(
    "deduplicates a pending %s before a second materialization",
    async (collision, { signal }) => {
      const held = holdMaterialization();
      const owner = ownerParams("agent:main:first");
      const creating = held.create("first", owner);
      const operations: Promise<unknown>[] = [creating];
      const contender = {
        ownerKind: "session" as const,
        ownerId: collision === "name" ? "agent:main:second" : owner.ownerId,
      };
      try {
        await held.wait(creating, signal);
        const pending = await readPendingWorktrees(f.env);
        expect(pending).toHaveLength(1);
        const waiting =
          collision === "owner" ? observePendingWait(pending[0]!.record.id) : undefined;
        const duplicate = held.create(collision === "name" ? "first" : "second", contender);
        operations.push(duplicate);
        if (waiting) {
          await atGate(waiting, duplicate, "Owner did not wait for pending checkout", signal);
        } else {
          await expect(withinTest(duplicate, signal)).rejects.toThrow(/pending|already|in use/i);
        }
        expect(await readPendingWorktrees(f.env)).toEqual(pending);
      } finally {
        await held.close();
      }
      const first = await creating;
      if (collision === "owner") {
        expect(await operations[1]).toEqual(first);
        expect(await requireGit(f.repo, ["branch", "--list", "openclaw/second"])).toBe("");
      }
      expect(await registryIds()).toEqual([first.id]);
      expect(await readPendingWorktrees(f.env)).toEqual([]);
    },
  );

  it("lets a queued owner retry after the original creation rolls back", async ({ signal }) => {
    const waiting = createDeferred();
    const retrySettled = createDeferred();
    const failure = new Error("synthetic first materialization failure");
    const held = holdMaterialization(failure);
    const acquire = stateLease.withOpenClawStateLeaseAsync;
    let firstMutation = true;
    let pendingId: string | undefined;
    vi.spyOn(stateLease, "withOpenClawStateLeaseAsync").mockImplementation(
      (options, context, run) => {
        const initial = options.scope === WORKTREE_MUTATION_LEASE_SCOPE && firstMutation;
        if (initial) {
          firstMutation = false;
        }
        if (options.scope === WORKTREE_MUTATION_LEASE_SCOPE && options.key === pendingId) {
          waiting.resolve();
        }
        const operation = acquire(options, context, run);
        // Let the queued owner enter after custody ends, before any outer rollback can repair it.
        return initial
          ? operation.catch(async (error: unknown) => {
              await retrySettled.promise;
              throw error;
            })
          : operation;
      },
    );
    const params = ownerParams("agent:main:retry-owner");
    const first = held.create("retry-owner", params);
    try {
      await held.wait(first, signal);
      const pending = await readPendingWorktrees(f.env);
      expect(pending).toHaveLength(1);
      pendingId = pending[0]!.record.id;
      const retry = held.create("retry-owner", params);
      void retry.then(
        () => retrySettled.resolve(),
        () => retrySettled.resolve(),
      );
      await atGate(waiting.promise, retry, "Retry did not wait for the pending checkout", signal);
      held.release.resolve();
      await expect(withinTest(first, signal)).rejects.toThrow(failure.message);
      const created = await withinTest(retry, signal);
      expect(created.id).not.toBe(pendingId);
      await expectPublished(created);
    } finally {
      retrySettled.resolve();
      await held.close();
    }
  });

  it.for(["owner", "capacity"] as const)(
    "recovers a creator that dies while a %s contender waits for custody",
    async (contention, { signal }) => {
      config.worktreeMaxCount = 1;
      const failure = new CommandProcessCleanupError();
      const held = holdMaterialization(failure, true);
      const owner = ownerParams("agent:main:crashed");
      const crashed = held.create("crashed", owner);
      try {
        await held.wait(crashed, signal);
        const [pending] = await readPendingWorktrees(f.env);
        expect(pending).toBeDefined();
        const record = pending!.record;
        const waiting = observePendingWait(record.id);
        const retry = held.create(undefined, {
          suggestedName: "crashed",
          ...owner,
          ownerId: contention === "owner" ? owner.ownerId : "agent:main:replacement",
        });
        await atGate(waiting, retry, "Contender did not wait for checkout custody", signal);
        markPendingOwnerDead(record);
        held.release.resolve();
        await expect(withinTest(crashed, signal)).rejects.toThrow(failure.message);
        const replacement = await withinTest(retry, signal);
        expect(replacement.name).toBe("crashed-2");
        await expectFile(replacement.path, "README.md", "base\n");
        await expectFile(record.path, "partial.txt", "uncertain native output\n");
        expect(await readPendingWorktrees(f.env)).toEqual([{ record, state: "recovering" }]);
        expect(await registryIds()).toEqual([replacement.id]);
      } finally {
        await held.close();
      }
    },
  );

  it("rolls back the slot and registration after publication fails", async () => {
    config.worktreeMaxCount = 1;
    const failure = new Error("synthetic publication failure");
    let failedPath: string | undefined;
    const injection = vi
      .spyOn(registry, "insertRegistryWorktree")
      .mockImplementationOnce(async (_env, record) => {
        failedPath = record.path;
        throw failure;
      });
    await expect(f.create("retry")).rejects.toThrow(failure.message);
    injection.mockRestore();
    expect(await readPendingWorktrees(f.env)).toEqual([]);
    expect(await f.service.listRegistryRecords()).toEqual([]);
    expect(failedPath).toBeDefined();
    await expectMissing(failedPath!);
    expect(await requireGit(f.repo, ["branch", "--list", "openclaw/retry"])).toBe("");
    const retry = await f.create("retry");
    await expectFile(retry.path, "README.md", "base\n");
  });

  it("reclaims a crashed owner's slot while retaining an uncertain worker checkout for recovery", async () => {
    config.worktreeMaxCount = 1;
    const failure = new SqliteWorkerError("unknown materialization", "outcome-unknown");
    const materialization = holdMaterialization(failure, true);
    materialization.release.resolve();
    await expect(f.create("crashed")).rejects.toThrow(failure.message);
    materialization.restore();
    const pending = await readPendingWorktrees(f.env);
    expect(pending).toHaveLength(1);
    const record = pending[0]!.record;
    await expectFile(record.path, "partial.txt", "uncertain native output\n");
    markPendingOwnerDead(record);
    const recovered = await f.service.gc();
    expect(recovered).toMatchObject({
      removed: [],
      outcome: "partial",
      eligibleCount: 0,
      deferredCount: 0,
      failedCount: 1,
      orphansDeleted: 0,
      orphansRetired: 0,
      issues: [expect.objectContaining({ stage: "orphans", outcome: "failed", id: record.id })],
    });
    expect(recovered.retiredCheckoutPaths).toContain(record.path);
    expect(await readPendingWorktrees(f.env)).toEqual([
      expect.objectContaining({ record, state: "recovering" }),
    ]);
    await expectFile(record.path, "partial.txt", "uncertain native output\n");
    const replacement = await f.create("replacement");
    await expectFile(replacement.path, "README.md", "base\n");
    expect(await registryIds()).toEqual([replacement.id]);
    await expectFile(record.path, "partial.txt", "uncertain native output\n");
  });
});
