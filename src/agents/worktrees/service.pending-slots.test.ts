import fs from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as backoff from "../../infra/backoff.js";
import * as gitExec from "../../infra/git-exec.js";
import * as gitWorker from "../../infra/git-worker.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
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
import { expectFile, expectMissing, writeFile, atGate } from "./service-scenarios.test-support.js";
import { ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";
import type { ManagedWorktreeRecord } from "./types.js";

describe("managed worktree pending slots", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(async () => {
      vi.restoreAllMocks();
      await closeOpenClawStateDatabaseAsync();
      cleanup();
    });
  });
  let repoRoot: string;
  let env: NodeJS.ProcessEnv;
  let service: ManagedWorktreeService;
  const createWorktree = (name: string) => service.create({ repoRoot, name, baseRef: "HEAD" });
  const config = { worktreeMaxCount: 2, worktreeAcceleration: false };

  beforeEach(async () => {
    config.worktreeMaxCount = 2;
    const root = tempDirs.make("openclaw-worktree-pending-");
    repoRoot = await initializeRepository(root);
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    service = new ManagedWorktreeService({ env, getConfig: () => config });
  });

  function holdMaterialization() {
    const entered = [createDeferred<string>(), createDeferred<string>()];
    const waiting = [...entered];
    const release = createDeferred();
    const execute = gitExec.executeGitCommand;
    vi.spyOn(gitExec, "executeGitCommand").mockImplementation(async (cwd, args, options) => {
      if (args[0] === "read-tree" && args.includes("-u")) {
        waiting.shift()?.resolve(cwd);
        await release.promise;
      }
      return await execute(cwd, args, options);
    });
    return { entered, release };
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
      captureWorktreeRunEndContext(env),
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
      { env },
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
      await expect(createWithWorktreeAllocation({ env }, run, async () => {})).rejects.toThrow(
        /timed out.*openclaw worktrees gc/,
      );
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
      const created = await createWorktree("slow-preparation");
      expect(clock).toBe((30 + 2) * 60_000);
      expect(await service.listRegistryRecords()).toEqual([created]);
      expect(await readPendingWorktrees(env)).toEqual([]);
      await expectFile(created.path, "README.md", "base\n");
    } finally {
      await release();
    }
  });

  it("keeps Git dependency inspection outside capacity admission", async () => {
    const run = gitWorker.runGitWorkerOperation;
    vi.spyOn(gitWorker, "runGitWorkerOperation").mockImplementation(async (operation, options) => {
      if (operation.type === "worktree.eviction-source") {
        await stateLease.withOpenClawStateLeaseAsync(
          { scope: WORKTREE_CREATE_LEASE_SCOPE, key: "capacity", leaseMs: 60_000, waitMs: 0 },
          captureWorktreeRunEndContext(env),
          async () => {},
        );
      }
      return run(operation, options);
    });
    const created = await createWorktree("source-inspection");
    await expectFile(created.path, "README.md", "base\n");
    expect(await readPendingWorktrees(env)).toEqual([]);
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
    const creating = createWorktree("name-discovery");
    try {
      await atGate(entered.promise, creating, "Git name discovery did not start", signal);
      await stateLease.withOpenClawStateLeaseAsync(
        { scope: WORKTREE_CREATE_LEASE_SCOPE, key: "capacity", leaseMs: 60_000, waitMs: 0 },
        captureWorktreeRunEndContext(env),
        async () => {},
      );
    } finally {
      release.resolve();
      await Promise.allSettled([creating]);
    }
    const created = await creating;
    await expectFile(created.path, "README.md", "base\n");
    expect(await readPendingWorktrees(env)).toEqual([]);
  });

  it("overlaps materialization after releasing the allocation lease", async ({ signal }) => {
    const held = holdMaterialization();
    const creating = [createWorktree("first")];
    try {
      await atGate(
        held.entered[0]!.promise,
        creating[0]!,
        "First checkout did not materialize",
        signal,
      );
      // A zero-wait contender makes the old global lease fail directly, without a timing race.
      await stateLease.withOpenClawStateLeaseAsync(
        { scope: WORKTREE_CREATE_LEASE_SCOPE, key: "capacity", leaseMs: 60_000, waitMs: 0 },
        captureWorktreeRunEndContext(env),
        async () => {},
      );
      creating.push(createWorktree("second"));
      await atGate(
        held.entered[1]!.promise,
        creating[1]!,
        "Second checkout did not materialize",
        signal,
      );
      expect(await readPendingWorktrees(env)).toHaveLength(2);
      expect(await service.listRegistryRecords()).toEqual([]);
    } finally {
      held.release.resolve();
      await Promise.allSettled(creating);
    }
    const records = await Promise.all(creating);
    expect(await readPendingWorktrees(env)).toEqual([]);
    expect((await service.listRegistryRecords()).map(({ id }) => id).toSorted()).toEqual(
      records.map(({ id }) => id).toSorted(),
    );
    for (const record of records) {
      await expectFile(record.path, "README.md", "base\n");
    }
  });

  it("publishes a reserved checkout while another creator holds allocation", async ({ signal }) => {
    config.worktreeMaxCount = 1;
    const held = holdMaterialization();
    const creating = createWorktree("publish-reserved");
    let releaseAllocation: (() => Promise<void>) | undefined;
    try {
      await atGate(held.entered[0]!.promise, creating, "Checkout did not materialize", signal);
      expect(await readPendingWorktrees(env)).toHaveLength(1);
      releaseAllocation = await holdLease(WORKTREE_CREATE_LEASE_SCOPE, "capacity");
      // An occupied allocation lane must not delay the count-neutral pending → live transaction.
      vi.spyOn(backoff, "sleepWithAbort").mockRejectedValue(
        new Error("Publication waited for the unrelated allocation holder"),
      );
      held.release.resolve();
      const created = await withinTest(creating, signal);
      expect(await readPendingWorktrees(env)).toEqual([]);
      expect(await service.listRegistryRecords()).toEqual([created]);
      await expectFile(created.path, "README.md", "base\n");
    } finally {
      held.release.resolve();
      await releaseAllocation?.();
      await Promise.allSettled([creating]);
    }
  });

  it("counts pending slots at admission and keeps them out of eviction", async ({ signal }) => {
    config.worktreeMaxCount = 1;
    const held = holdMaterialization();
    const creating = createWorktree("pending");
    const creates = [creating];
    const operations: Promise<unknown>[] = [creating];
    try {
      const checkoutPath = await atGate(
        held.entered[0]!.promise,
        creating,
        "Checkout did not materialize",
        signal,
      );
      const pending = await readPendingWorktrees(env);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.record.path).toBe(checkoutPath);
      const waiting = observePendingWait(pending[0]!.record.id);
      const overflow = createWorktree("overflow");
      creates.push(overflow);
      operations.push(overflow);
      await atGate(waiting, overflow, "Cap contender did not wait for the pending slot", signal);
      // A native clone may temporarily replace .git; pending custody still owns the whole path.
      const markerPath = path.join(checkoutPath, ".git");
      const marker = await fs.readFile(markerPath);
      await fs.unlink(markerPath);
      try {
        const collecting = service.gc();
        operations.push(collecting);
        const collection = await withinTest(collecting, signal);
        expect(collection.removed).toEqual([]);
        expect(collection.orphansDeleted).toBe(0);
        expect(collection.orphansRetired).toBe(0);
        expect((await fs.stat(checkoutPath)).isDirectory()).toBe(true);
      } finally {
        await fs.writeFile(markerPath, marker);
      }
      // Clone replacement can also leave no directory; GC must retain its fingerprint parent.
      const replacingPath = path.join(env.OPENCLAW_STATE_DIR!, "materializing-checkout");
      await fs.rename(checkoutPath, replacingPath);
      try {
        const collecting = service.gc();
        operations.push(collecting);
        const collection = await withinTest(collecting, signal);
        expect(collection.removed).toEqual([]);
        expect(collection.orphansDeleted).toBe(0);
        expect(collection.orphansRetired).toBe(0);
        expect((await fs.stat(path.dirname(checkoutPath))).isDirectory()).toBe(true);
      } finally {
        await fs.mkdir(path.dirname(checkoutPath), { recursive: true });
        await fs.rename(replacingPath, checkoutPath);
      }
      expect(await readPendingWorktrees(env)).toEqual(pending);
      expect(await requireGit(repoRoot, ["branch", "--list", "openclaw/overflow"])).toBe("");
    } finally {
      held.release.resolve();
      await Promise.allSettled(operations);
    }
    const [first, overflow] = await Promise.all(creates);
    const records = await service.listRegistryRecords();
    expect(records.filter(({ removedAt }) => removedAt === undefined).map(({ id }) => id)).toEqual([
      overflow!.id,
    ]);
    expect(records.filter(({ removedAt }) => removedAt !== undefined).map(({ id }) => id)).toEqual([
      first!.id,
    ]);
    expect(await readPendingWorktrees(env)).toEqual([]);
  });

  it.for(["name", "owner"] as const)(
    "deduplicates a pending %s before a second materialization",
    async (collision, { signal }) => {
      const held = holdMaterialization();
      const owner = { ownerKind: "session" as const, ownerId: "agent:main:first" };
      const creating = service.create({ repoRoot, name: "first", baseRef: "HEAD", ...owner });
      const operations: Promise<unknown>[] = [creating];
      const contender = {
        repoRoot,
        baseRef: "HEAD",
        name: collision === "name" ? "first" : "second",
        ownerKind: "session" as const,
        ownerId: collision === "name" ? "agent:main:second" : owner.ownerId,
      };
      try {
        await atGate(held.entered[0]!.promise, creating, "Checkout did not materialize", signal);
        const pending = await readPendingWorktrees(env);
        expect(pending).toHaveLength(1);
        const waiting =
          collision === "owner" ? observePendingWait(pending[0]!.record.id) : undefined;
        const duplicate = service.create(contender);
        operations.push(duplicate);
        if (waiting) {
          await atGate(
            waiting,
            duplicate,
            "Owner contender did not wait for its pending checkout",
            signal,
          );
        } else {
          await expect(withinTest(duplicate, signal)).rejects.toThrow(/pending|already|in use/i);
        }
        expect(await readPendingWorktrees(env)).toEqual(pending);
      } finally {
        held.release.resolve();
        await Promise.allSettled(operations);
      }
      const first = await creating;
      if (collision === "owner") {
        expect(await operations[1]).toEqual(first);
        expect(await requireGit(repoRoot, ["branch", "--list", "openclaw/second"])).toBe("");
      }
      expect((await service.listRegistryRecords()).map(({ id }) => id)).toEqual([first.id]);
      expect(await readPendingWorktrees(env)).toEqual([]);
    },
  );

  it("lets a queued owner retry after the original creation rolls back", async ({ signal }) => {
    const entered = createDeferred();
    const release = createDeferred();
    const waiting = createDeferred();
    const retrySettled = createDeferred();
    const failure = new Error("synthetic first materialization failure");
    const execute = gitExec.executeGitCommand;
    let failMaterialization = true;
    vi.spyOn(gitExec, "executeGitCommand").mockImplementation(async (cwd, args, options) => {
      if (failMaterialization && args[0] === "read-tree" && args.includes("-u")) {
        failMaterialization = false;
        entered.resolve();
        await release.promise;
        throw failure;
      }
      return await execute(cwd, args, options);
    });
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
    const params = {
      repoRoot,
      name: "retry-owner",
      baseRef: "HEAD",
      ownerKind: "session" as const,
      ownerId: "agent:main:retry-owner",
    };
    const first = service.create(params);
    const operations: Promise<unknown>[] = [first];
    try {
      await atGate(entered.promise, first, "First checkout did not materialize", signal);
      const pending = await readPendingWorktrees(env);
      expect(pending).toHaveLength(1);
      pendingId = pending[0]!.record.id;
      const retry = service.create(params);
      operations.push(retry);
      void retry.then(
        () => retrySettled.resolve(),
        () => retrySettled.resolve(),
      );
      await atGate(waiting.promise, retry, "Retry did not wait for the pending checkout", signal);
      release.resolve();
      await expect(withinTest(first, signal)).rejects.toThrow(failure.message);
      const created = await withinTest(retry, signal);
      expect(created.id).not.toBe(pendingId);
      expect(await readPendingWorktrees(env)).toEqual([]);
      expect((await service.listRegistryRecords()).map(({ id }) => id)).toEqual([created.id]);
      await expectFile(created.path, "README.md", "base\n");
    } finally {
      release.resolve();
      retrySettled.resolve();
      await Promise.allSettled(operations);
    }
  });

  it.for(["owner", "capacity"] as const)(
    "recovers a creator that dies while a %s contender waits for custody",
    async (contention, { signal }) => {
      config.worktreeMaxCount = 1;
      const entered = createDeferred();
      const release = createDeferred();
      const failure = new CommandProcessCleanupError();
      const execute = gitExec.executeGitCommand;
      let firstMaterialization = true;
      vi.spyOn(gitExec, "executeGitCommand").mockImplementation(async (cwd, args, options) => {
        if (firstMaterialization && args[0] === "read-tree" && args.includes("-u")) {
          firstMaterialization = false;
          await writeFile(cwd, "partial.txt", "uncertain native output\n");
          entered.resolve();
          await release.promise;
          throw failure;
        }
        return await execute(cwd, args, options);
      });
      const owner = { ownerKind: "session" as const, ownerId: "agent:main:crashed" };
      const crashed = service.create({ repoRoot, name: "crashed", baseRef: "HEAD", ...owner });
      const operations: Promise<unknown>[] = [crashed];
      try {
        await atGate(entered.promise, crashed, "Checkout did not materialize", signal);
        const [pending] = await readPendingWorktrees(env);
        expect(pending).toBeDefined();
        const record = pending!.record;
        const waiting = observePendingWait(record.id);
        const retry = service.create({
          repoRoot,
          suggestedName: "crashed",
          baseRef: "HEAD",
          ...owner,
          ownerId: contention === "owner" ? owner.ownerId : "agent:main:replacement",
        });
        operations.push(retry);
        await atGate(waiting, retry, "Contender did not wait for checkout custody", signal);
        markPendingOwnerDead(record);
        release.resolve();
        await expect(withinTest(crashed, signal)).rejects.toThrow(failure.message);
        const replacement = await withinTest(retry, signal);
        expect(replacement.name).toBe("crashed-2");
        await expectFile(replacement.path, "README.md", "base\n");
        await expectFile(record.path, "partial.txt", "uncertain native output\n");
        expect(await readPendingWorktrees(env)).toEqual([{ record, state: "recovering" }]);
        expect((await service.listRegistryRecords()).map(({ id }) => id)).toEqual([replacement.id]);
      } finally {
        release.resolve();
        await Promise.allSettled(operations);
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
    await expect(createWorktree("retry")).rejects.toThrow(failure.message);
    injection.mockRestore();
    expect(await readPendingWorktrees(env)).toEqual([]);
    expect(await service.listRegistryRecords()).toEqual([]);
    expect(failedPath).toBeDefined();
    await expectMissing(failedPath!);
    expect(await requireGit(repoRoot, ["branch", "--list", "openclaw/retry"])).toBe("");
    const retry = await createWorktree("retry");
    await expectFile(retry.path, "README.md", "base\n");
  });

  it("reclaims a crashed owner's slot while retaining an uncertain worker checkout for recovery", async () => {
    config.worktreeMaxCount = 1;
    const execute = gitExec.executeGitCommand;
    const failure = new SqliteWorkerError(
      "synthetic unknown materialization outcome",
      "outcome-unknown",
    );
    const materialization = vi
      .spyOn(gitExec, "executeGitCommand")
      .mockImplementation(async (cwd, args, options) => {
        if (args[0] === "read-tree" && args.includes("-u")) {
          await writeFile(cwd, "partial.txt", "uncertain native output\n");
          throw failure;
        }
        return await execute(cwd, args, options);
      });
    await expect(createWorktree("crashed")).rejects.toThrow(failure.message);
    materialization.mockRestore();
    const pending = await readPendingWorktrees(env);
    expect(pending).toHaveLength(1);
    const record = pending[0]!.record;
    await expectFile(record.path, "partial.txt", "uncertain native output\n");
    markPendingOwnerDead(record);
    const recovered = await service.gc();
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
    expect(await readPendingWorktrees(env)).toEqual([
      expect.objectContaining({ record, state: "recovering" }),
    ]);
    await expectFile(record.path, "partial.txt", "uncertain native output\n");
    const replacement = await createWorktree("replacement");
    await expectFile(replacement.path, "README.md", "base\n");
    expect((await service.listRegistryRecords()).map(({ id }) => id)).toEqual([replacement.id]);
    await expectFile(record.path, "partial.txt", "uncertain native output\n");
  });
});
