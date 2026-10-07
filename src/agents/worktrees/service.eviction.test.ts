import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { StatementSync } from "node:sqlite";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import * as gitExec from "../../infra/git-exec.js";
import * as gitWorker from "../../infra/git-worker.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import * as admissions from "../../infra/sqlite-worker-operation-admission.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { observeMainThreadReads } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withWorktreeAllocationLease } from "./allocation.js";
import * as checkout from "./checkout.js";
import * as eviction from "./eviction.js";
import { requireGit } from "./git.js";
import { getRegistryWorktree } from "./registry.js";
import { worktreeRunLeaseScope } from "./run-lease-owner.js";
import * as runLease from "./run-lease.js";
import { acquireWorktreeRunLease } from "./run-lease.js";
import { testing as runLeaseTesting } from "./run-lease.test-support.js";
import { ManagedWorktreeService } from "./service.js";
import {
  materializeManagedWorktreeFixtures,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";
import * as snapshotHost from "./snapshot-host.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    runLeaseTesting.resetForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

describe("managed worktree cap eviction", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  let root: string;
  let repoRoot: string;
  let env: NodeJS.ProcessEnv;
  let service: ManagedWorktreeService;
  const config = { worktreeMaxCount: 1, worktreeAcceleration: false };

  beforeEach(async () => {
    config.worktreeMaxCount = 1;
    root = tempDirs.make("openclaw-worktree-eviction-");
    repoRoot = await initializeRepository(root);
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    service = new ManagedWorktreeService({ env, getConfig: () => config });
  });

  it.each(["claim", "snapshot"] as const)(
    "retains uncertain %s custody after caller cancellation",
    async (stage) => {
      const record = await service.create({ repoRoot, name: "uncertain", baseRef: "HEAD" });
      const primary = new SqliteWorkerError(
        "synthetic unknown operation settlement",
        "outcome-unknown",
      );
      const cancellation = new AbortController();
      const claim = runLease.claimWorktreeRemoval;
      let unsettled = false;
      const claimSpy = vi
        .spyOn(runLease, "claimWorktreeRemoval")
        .mockImplementation(async (...args) => {
          await claim(...args);
          if (stage === "claim") {
            unsettled = true;
            cancellation.abort(new Error("caller canceled after the claim"));
          }
        });
      const releaseSpy = vi.spyOn(runLease, "abortWorktreeRemoval");
      const snapshotSpy =
        stage === "snapshot"
          ? vi
              .spyOn(snapshotHost, "captureManagedWorktreeSnapshot")
              .mockImplementation(async () => {
                cancellation.abort(new Error("caller canceled during the uncertain snapshot"));
                throw primary;
              })
          : undefined;
      try {
        const failure: unknown = await withWorktreeAllocationLease(
          { env, signal: cancellation.signal },
          (guard) =>
            eviction.evictManagedWorktree({
              env,
              record,
              reason: "idle-age",
              now: Date.now,
              getConfig: () => config,
              guard: {
                ...guard,
                commitGuard: () => {
                  if (unsettled) {
                    throw primary;
                  }
                  guard.commitGuard();
                },
              },
            }),
        ).catch((error: unknown) => error);
        expect(failure).toMatchObject({ code: "outcome-unknown" });
        expect(collectNestedErrorCandidates(failure)).toEqual(expect.arrayContaining([primary]));
        expect(releaseSpy).not.toHaveBeenCalled();
        await expect(acquireWorktreeRunLease(record.id, { env })).rejects.toThrow(/remov/);
        expect(getRegistryWorktree(env, record.id)?.removedAt).toBeUndefined();
        expect(await fs.readFile(path.join(record.path, "README.md"), "utf8")).toBe("base\n");
      } finally {
        claimSpy.mockRestore();
        releaseSpy.mockRestore();
        snapshotSpy?.mockRestore();
      }
    },
  );

  it("settles an admitted purge before releasing custody after caller cancellation", async () => {
    const record = await service.create({
      repoRoot,
      name: "cancel-after-admission",
      baseRef: "HEAD",
    });
    const cancellation = new AbortController();
    const execute = gitWorker.runGitWorkerOperation;
    const dispatch = vi
      .spyOn(gitWorker, "runGitWorkerOperation")
      .mockImplementation((command, options) =>
        execute(command, {
          ...options,
          onEffect: async (effect, context) => {
            const result = await options?.onEffect?.(effect, context);
            if (
              command.type === "worktree.eviction-purge" &&
              effect.type === "worktree.eviction-admit"
            ) {
              cancellation.abort(new Error("caller canceled after purge admission"));
            }
            return result;
          },
        }),
      );
    try {
      await expect(
        withWorktreeAllocationLease({ env, signal: cancellation.signal }, (guard) =>
          eviction.evictManagedWorktree({
            env,
            record,
            reason: "idle-age",
            now: Date.now,
            getConfig: () => config,
            guard,
          }),
        ),
      ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED" });
      expect(cancellation.signal.aborted).toBe(true);
      expect(getRegistryWorktree(env, record.id)?.removedAt).toEqual(expect.any(Number));
      await expect(fs.stat(record.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        openOpenClawStateDatabase({ env })
          .db.prepare("SELECT lease_key FROM state_leases WHERE scope = ?")
          .all(worktreeRunLeaseScope(record.id)),
      ).toEqual([]);
    } finally {
      dispatch.mockRestore();
    }
  });

  it("refuses a new dependency claim when any earlier eviction claim was lost", async () => {
    const [victim, earlier, next] = await materializeManagedWorktreeFixtures({
      env,
      repoRoot,
      stateDir: env.OPENCLAW_STATE_DIR!,
      names: ["batch-victim", "batch-earlier", "batch-next"],
      now: 1,
    });
    const token = "synthetic-eviction-batch";
    await withWorktreeAllocationLease({ env }, async (guard) => {
      const claim = (worktreeId: string) =>
        runLease.claimWorktreeRemoval(env, {
          worktreeId,
          token,
          workerAuthority: guard.workerAuthority,
        });
      await claim(victim!.id);
      await claim(earlier!.id);
      try {
        await runLease.abortWorktreeRemoval(env, earlier!.id, token);
        await expect(
          runLease.claimWorktreeRemoval(env, {
            worktreeId: next!.id,
            token,
            workerAuthority: {
              ...guard.workerAuthority,
              predicates: [{ kind: "removal-claims", ids: [victim!.id, earlier!.id], token }],
            },
          }),
        ).rejects.toThrow("Worktree removal claim changed");
        expect(
          openOpenClawStateDatabase({ env })
            .db.prepare("SELECT lease_key FROM state_leases WHERE scope = ?")
            .all(worktreeRunLeaseScope(next!.id)),
        ).toEqual([]);
      } finally {
        await runLease.abortWorktreeRemoval(env, victim!.id, token);
      }
    });
  });

  it("keeps a managed source live until its ignored provisioning is safe from eviction", async () => {
    await fs.writeFile(path.join(repoRoot, ".gitignore"), "settings.local\n");
    await fs.writeFile(path.join(repoRoot, ".worktreeinclude"), "settings.local\n");
    await requireGit(repoRoot, ["add", ".gitignore", ".worktreeinclude"]);
    await requireGit(repoRoot, ["commit", "-m", "synthetic provisioning"]);
    await fs.writeFile(path.join(repoRoot, "settings.local"), "source baseline\n");
    const first = await service.create({ repoRoot, name: "source", baseRef: "HEAD" });
    await fs.writeFile(path.join(first.path, "settings.local"), "unique synthetic source bytes\n");
    await fs.writeFile(path.join(first.path, "README.md"), "unsaved source edit\n");
    const original = getRegistryWorktree(env, first.id);
    await expect(
      service.create({ repoRoot: first.path, name: "copy", baseRef: "HEAD" }),
    ).rejects.toThrow(/cap 1.*live owners/);
    expect(getRegistryWorktree(env, first.id)).toEqual(original);
    expect(await fs.readFile(path.join(first.path, "README.md"), "utf8")).toBe(
      "unsaved source edit\n",
    );
    expect(await fs.readFile(path.join(first.path, "settings.local"), "utf8")).toBe(
      "unique synthetic source bytes\n",
    );
    config.worktreeMaxCount = 2;
    const copied = await service.create({ repoRoot: first.path, name: "copy", baseRef: "HEAD" });
    expect(await fs.readFile(path.join(copied.path, "settings.local"), "utf8")).toBe(
      "unique synthetic source bytes\n",
    );
    expect(getRegistryWorktree(env, first.id)).toEqual(original);
  });

  it("drains more than one eviction batch after the configured cap drops", async () => {
    config.worktreeMaxCount = 16;
    await materializeManagedWorktreeFixtures({
      env,
      repoRoot,
      stateDir: env.OPENCLAW_STATE_DIR!,
      names: Array.from({ length: 9 }, (_, index) => `debt-${index}`),
      now: 1,
    });
    config.worktreeMaxCount = 1;
    const created = await service.create({ repoRoot, name: "after-cap-drop", baseRef: "HEAD" });
    const records = await service.listRegistryRecords();
    expect(
      records.filter((record) => record.removedAt === undefined).map((record) => record.id),
    ).toEqual([created.id]);
    expect(records.filter((record) => record.removedAt !== undefined)).toHaveLength(9);
    expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
  });

  it("ranks shared heads once per repository when creating at the fleet cap", async () => {
    config.worktreeMaxCount = 17;
    const records = await materializeManagedWorktreeFixtures({
      env,
      repoRoot,
      stateDir: env.OPENCLAW_STATE_DIR!,
      names: Array.from({ length: 17 }, (_, index) => `rank-${String(index).padStart(2, "0")}`),
      now: 1,
    });
    await requireGit(repoRoot, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);
    await requireGit(records.at(-1)!.path, ["checkout", "--detach", "HEAD"]);
    const checkoutPaths = new Set(records.map((record) => record.path));
    const text = vi.spyOn(gitExec, "executeGitCommand");
    const bytes = vi.spyOn(gitExec, "executeGitCommandBytes");
    const buffered = vi.spyOn(gitExec, "executeGitCommandBuffered");
    try {
      const started = performance.now();
      const created = await service.create({ repoRoot, name: "at-cap", baseRef: "HEAD" });
      const elapsedMs = performance.now() - started;
      const cleanup = [...text.mock.calls, ...bytes.mock.calls, ...buffered.mock.calls].filter(
        (call) => call[2]?.operation === "worktree.cleanup",
      );
      const headProbes = cleanup.filter(
        ([cwd, args]) =>
          checkoutPaths.has(cwd) && args[0] === "rev-parse" && args.includes("HEAD^{commit}"),
      ).length;
      const defaultLookups = cleanup.filter(([, args]) =>
        args.includes("refs/remotes/origin/HEAD^{commit}"),
      ).length;
      const ancestryChecks = cleanup.filter(
        ([, args]) => args[0] === "merge-base" && args.includes("--is-ancestor"),
      ).length;
      console.log(
        JSON.stringify({
          records: records.length,
          cleanupGitCommands: cleanup.length,
          headProbes,
          defaultLookups,
          ancestryChecks,
          elapsedMs,
          rssBytes: process.memoryUsage().rss,
        }),
      );
      const inventory = await service.listRegistryRecords();
      expect(
        inventory
          .filter((record) => record.removedAt === undefined)
          .map((record) => record.id)
          .toSorted(),
      ).toEqual([...records.slice(1).map((record) => record.id), created.id].toSorted());
      expect(
        inventory.filter((record) => record.removedAt !== undefined).map((record) => record.id),
      ).toEqual([records[0]!.id]);
      await expect(fs.stat(records[0]!.path)).rejects.toMatchObject({ code: "ENOENT" });
      for (const record of [...records.slice(1), created]) {
        expect(await fs.readFile(path.join(record.path, "README.md"), "utf8")).toBe("base\n");
      }
      // One repository inventory/default, one shared-head classification, and fresh purge checks.
      expect(cleanup.length).toBeLessThanOrEqual(5);
      expect(headProbes).toBe(0);
      expect(defaultLookups).toBeLessThanOrEqual(1);
      expect(ancestryChecks).toBeLessThanOrEqual(1);
    } finally {
      text.mockRestore();
      bytes.mockRestore();
      buffered.mockRestore();
    }
  });

  it("uses the current runtime cap when no configuration getter is injected", async () => {
    const first = await service.create({ repoRoot, name: "first", baseRef: "HEAD" });
    const runtimeService = new ManagedWorktreeService({ env });
    try {
      setRuntimeConfigSnapshot({ worktreeMaxCount: 1 });
      const second = await runtimeService.create({ repoRoot, name: "second", baseRef: "HEAD" });
      expect(getRegistryWorktree(env, first.id)?.removedAt).toEqual(expect.any(Number));
      setRuntimeConfigSnapshot({ worktreeMaxCount: 2 });
      const third = await runtimeService.create({ repoRoot, name: "third", baseRef: "HEAD" });
      expect(
        (await runtimeService.listRegistryRecords())
          .filter((record) => record.removedAt === undefined)
          .map((record) => record.id)
          .toSorted(),
      ).toEqual([second.id, third.id].toSorted());
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it.each(["cleanup", "admission"] as const)(
    "counts failed victims toward %s batch boundaries and continues to later victims",
    async (entrypoint) => {
      config.worktreeMaxCount = entrypoint === "cleanup" ? 8 : 9;
      const records = await materializeManagedWorktreeFixtures({
        env,
        repoRoot,
        stateDir: env.OPENCLAW_STATE_DIR!,
        names: Array.from({ length: 9 }, (_, index) => `victim-${index}`),
        now: 1,
      });
      const attempted: string[] = [];
      const boundaries: number[] = [];
      const remove = eviction.evictManagedWorktree;
      const failures = vi.spyOn(eviction, "evictManagedWorktree").mockImplementation((params) => {
        attempted.push(params.record.id);
        if (params.record.id !== records[8]!.id) {
          return Promise.reject(new Error("synthetic checkout deletion failure"));
        }
        return remove(params);
      });
      try {
        if (entrypoint === "cleanup") {
          const result = await service.gc({
            checkpoint: async () => {
              if (attempted.length > 0) {
                boundaries.push(attempted.length);
              }
            },
          });
          expect(boundaries[0]).toBeGreaterThan(0);
          expect(boundaries[0]).toBeLessThanOrEqual(8);
          expect(result).toMatchObject({
            removed: [records[8]!.id],
            issueCount: 8,
            limitsSatisfied: true,
          });
        } else {
          const created = await service.create({
            repoRoot,
            name: "after-failures",
            baseRef: "HEAD",
          });
          const inventory = await service.listRegistryRecords();
          expect(
            inventory
              .filter((record) => record.removedAt === undefined)
              .map((record) => record.id)
              .toSorted(),
          ).toEqual([...records.slice(0, 8).map((record) => record.id), created.id].toSorted());
          expect(getRegistryWorktree(env, records[8]!.id)?.removedAt).toEqual(expect.any(Number));
          expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
        }
        expect(attempted).toEqual(records.map((record) => record.id));
      } finally {
        failures.mockRestore();
      }
    },
  );

  it("keeps a retained exact source and its live ancestor when restoration needs another slot", async () => {
    config.worktreeMaxCount = 2;
    const outer = await service.create({ repoRoot, name: "outer", baseRef: "HEAD" });
    const nested = new ManagedWorktreeService({
      env,
      getConfig: () => ({ ...config, worktreeRoot: path.join(outer.path, "children") }),
    });
    const child = await nested.create({ repoRoot, name: "retained-child", baseRef: "HEAD" });
    const head = await requireGit(child.path, ["rev-parse", "HEAD"]);
    await requireGit(child.path, ["checkout", "--detach", "HEAD"]);
    await fs.writeFile(path.join(child.path, "unsaved.txt"), "retained child bytes\n");
    const indexPath = path.resolve(
      child.path,
      await requireGit(child.path, ["rev-parse", "--git-path", "index"]),
    );
    const retired = await nested.remove({
      id: child.id,
      reason: "nested exact fixture",
      exactState: {
        ownerKind: child.ownerKind,
        ownerId: child.ownerId,
        createdAt: child.createdAt,
        lastActiveAt: child.lastActiveAt,
        head,
        branchHead: head,
        indexSha256: createHash("sha256")
          .update(await fs.readFile(indexPath))
          .digest("hex"),
      },
    });
    const original = getRegistryWorktree(env, outer.id);
    config.worktreeMaxCount = 1;
    await expect(nested.restore({ id: child.id })).rejects.toThrow(/cap 1.*live owners/);
    expect(getRegistryWorktree(env, outer.id)).toEqual(original);
    expect(getRegistryWorktree(env, child.id)?.removedAt).toEqual(expect.any(Number));
    expect(await fs.readFile(path.join(retired.recoveryPath!, "unsaved.txt"), "utf8")).toBe(
      "retained child bytes\n",
    );
    config.worktreeMaxCount = 2;
    const restored = await nested.restore({ id: child.id });
    expect(await fs.readFile(path.join(restored.path, "unsaved.txt"), "utf8")).toBe(
      "retained child bytes\n",
    );
    expect(getRegistryWorktree(env, outer.id)).toEqual(original);
  });

  it("holds one global cap across concurrent creates from different repositories and service instances", async () => {
    const otherRepo = await initializeRepository(path.join(root, "other"));
    const otherService = new ManagedWorktreeService({ env, getConfig: () => config });
    const created = await Promise.all([
      service.create({ repoRoot, name: "first", baseRef: "HEAD" }),
      otherService.create({ repoRoot: otherRepo, name: "second", baseRef: "HEAD" }),
    ]);
    const records = await service.listRegistryRecords();
    const active = records.filter((record) => record.removedAt === undefined);
    expect(active).toHaveLength(1);
    expect(records.filter((record) => record.removedAt !== undefined)).toHaveLength(1);
    expect(created.map((record) => record.id).toSorted()).toEqual(
      records.map((record) => record.id).toSorted(),
    );
    expect(await fs.readFile(path.join(active[0]!.path, "README.md"), "utf8")).toBe("base\n");
    const retired = records.find((record) => record.removedAt !== undefined)!;
    await expect(fs.stat(retired.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("snapshots dirty data before purging and restores it while preserving the cap", async () => {
    const dirty = await service.create({ repoRoot, name: "dirty", baseRef: "HEAD" });
    await fs.writeFile(path.join(dirty.path, "README.md"), "unsaved tracked edit\n");
    await fs.writeFile(path.join(dirty.path, "untracked.txt"), "unsaved new file\n");
    const reads = observeMainThreadReads();
    const worktreeReads: string[] = [];
    let grants = 0;
    const createAdmission = admissions.createSqliteWorkerOperationAdmission;
    const admission = vi
      .spyOn(admissions, "createSqliteWorkerOperationAdmission")
      .mockImplementation((handler, ...options) =>
        createAdmission(
          (request, grant) => {
            grants += 1;
            reads.clear();
            try {
              return handler(request, grant);
            } finally {
              for (const call of reads.calls) {
                for (const [index, statement] of call.mock.contexts.entries()) {
                  if (
                    statement instanceof StatementSync &&
                    (/\bworktrees\b/u.test(statement.sourceSQL) ||
                      (/\bstate_leases\b/u.test(statement.sourceSQL) &&
                        call.mock.calls[index]?.some(
                          (value) =>
                            typeof value === "string" &&
                            value.includes(worktreeRunLeaseScope(dirty.id)),
                        )))
                  ) {
                    worktreeReads.push(statement.sourceSQL);
                  }
                }
              }
            }
          },
          ...options,
        ),
      );
    const replacement = await (async () => {
      try {
        const created = await service.create({ repoRoot, name: "replacement", baseRef: "HEAD" });
        expect(grants).toBeGreaterThan(0);
        expect(worktreeReads).toEqual([]);
        return created;
      } finally {
        admission.mockRestore();
        reads.restore();
      }
    })();
    const archived = getRegistryWorktree(env, dirty.id)!;
    expect(archived.removedAt).toEqual(expect.any(Number));
    expect(archived.snapshotRef).toMatch(/^refs\/openclaw\/snapshots\//);
    await expect(fs.stat(dirty.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await requireGit(repoRoot, ["show", `${archived.snapshotRef}:untracked.txt`])).toBe(
      "unsaved new file",
    );

    const branchHead = await requireGit(repoRoot, ["rev-parse", `refs/heads/${dirty.branch}`]);
    const materialize = vi
      .spyOn(checkout, "materializeManagedWorktree")
      .mockRejectedValueOnce(new Error("synthetic restore checkout failure"));
    try {
      await expect(service.restore({ id: dirty.id })).rejects.toThrow(
        "synthetic restore checkout failure",
      );
    } finally {
      materialize.mockRestore();
    }
    expect(await requireGit(repoRoot, ["rev-parse", `refs/heads/${dirty.branch}`])).toBe(
      branchHead,
    );
    await expect(fs.stat(dirty.path)).rejects.toMatchObject({ code: "ENOENT" });
    const restored = await service.restore({ id: dirty.id });
    expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe(
      "unsaved tracked edit\n",
    );
    expect(await fs.readFile(path.join(restored.path, "untracked.txt"), "utf8")).toBe(
      "unsaved new file\n",
    );
    expect(getRegistryWorktree(env, replacement.id)?.removedAt).toEqual(expect.any(Number));
    expect(
      (await service.listRegistryRecords())
        .filter((record) => record.removedAt === undefined)
        .map((record) => record.id),
    ).toEqual([dirty.id]);
  });

  it("refuses an advanced retained branch before evicting unrelated data", async () => {
    const archived = await service.create({ repoRoot, name: "retained", baseRef: "HEAD" });
    const live = await service.create({ repoRoot, name: "live", baseRef: "HEAD" });
    await fs.writeFile(path.join(live.path, "README.md"), "unrelated unsaved data\n");
    const liveBefore = getRegistryWorktree(env, live.id);
    const branch = `refs/heads/${archived.branch}`;
    const parent = await requireGit(repoRoot, ["rev-parse", branch]);
    const advanced = await requireGit(repoRoot, [
      "commit-tree",
      `${parent}^{tree}`,
      "-p",
      parent,
      "-m",
      "synthetic retained branch advance",
    ]);
    await requireGit(repoRoot, ["update-ref", branch, advanced, parent]);
    await expect(service.restore({ id: archived.id })).rejects.toThrow("Recorded branch moved");
    expect(await requireGit(repoRoot, ["rev-parse", branch])).toBe(advanced);
    expect(getRegistryWorktree(env, live.id)).toEqual(liveBefore);
    expect(await fs.readFile(path.join(live.path, "README.md"), "utf8")).toBe(
      "unrelated unsaved data\n",
    );
  });

  it("purges a nested repository even when a lossless snapshot is unavailable", async () => {
    const nested = await service.create({ repoRoot, name: "nested", baseRef: "HEAD" });
    const inner = path.join(nested.path, "inner");
    await fs.mkdir(inner);
    await requireGit(inner, ["init", "-b", "main"]);
    await fs.writeFile(path.join(inner, "unsaved.txt"), "unrecoverable nested data\n");

    const replacement = await service.create({ repoRoot, name: "replacement", baseRef: "HEAD" });
    expect(getRegistryWorktree(env, nested.id)).toMatchObject({ removedAt: expect.any(Number) });
    expect(getRegistryWorktree(env, nested.id)?.snapshotRef).toBeUndefined();
    await expect(fs.stat(nested.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await service.listRegistryRecords())
        .filter((record) => record.removedAt === undefined)
        .map((record) => record.id),
    ).toEqual([replacement.id]);
  });

  it.each([
    ["missing snapshot", "restore"],
    ["missing repository", "restore"],
    ["occupied destination", "restore"],
    ["missing snapshot", "same-name create"],
  ] as const)("preserves the full fleet when %s prevents %s", async (failure, entrypoint) => {
    const archived = await service.create({ repoRoot, name: "archived", baseRef: "HEAD" });
    const removed = await service.remove({ id: archived.id, reason: "fixture" });
    const live = await service.create({ repoRoot, name: "live", baseRef: "HEAD" });
    await fs.writeFile(path.join(live.path, "README.md"), "unrelated unsaved data\n");
    const liveBefore = getRegistryWorktree(env, live.id);
    if (failure === "missing snapshot") {
      await requireGit(repoRoot, ["update-ref", "-d", removed.snapshotRef!]);
    } else if (failure === "missing repository") {
      await fs.rename(repoRoot, path.join(root, "unavailable-repository"));
    } else {
      await fs.mkdir(archived.path, { recursive: true });
      await fs.writeFile(path.join(archived.path, "occupied"), "preserve destination\n");
    }
    const restore =
      entrypoint === "restore"
        ? service.restore({ id: archived.id })
        : service.create({ repoRoot, name: archived.name, baseRef: "HEAD" });
    await expect(restore).rejects.toThrow(
      failure === "missing repository"
        ? /source repository no longer exists/
        : failure === "occupied destination"
          ? /occupied/
          : /rev-parse|single revision|snapshot/,
    );
    expect(getRegistryWorktree(env, live.id)).toEqual(liveBefore);
    expect(await fs.readFile(path.join(live.path, "README.md"), "utf8")).toBe(
      "unrelated unsaved data\n",
    );
    expect(
      (await service.listRegistryRecords())
        .filter((record) => record.removedAt === undefined)
        .map((record) => record.id),
    ).toEqual([live.id]);
  });

  it.each(["retained", "fallback"] as const)(
    "admits a validated exact-state %s restore once",
    async (kind) => {
      const archived = await service.create({ repoRoot, name: "exact", baseRef: "HEAD" });
      const head = await requireGit(archived.path, ["rev-parse", "HEAD"]);
      await requireGit(archived.path, ["checkout", "--detach", "HEAD"]);
      const indexPath = path.resolve(
        archived.path,
        await requireGit(archived.path, ["rev-parse", "--git-path", "index"]),
      );
      const removed = await service.remove({
        id: archived.id,
        reason: "exact fixture",
        exactState: {
          ownerKind: archived.ownerKind,
          ownerId: archived.ownerId,
          createdAt: archived.createdAt,
          lastActiveAt: archived.lastActiveAt,
          head,
          branchHead: head,
          indexSha256: createHash("sha256")
            .update(await fs.readFile(indexPath))
            .digest("hex"),
        },
      });
      if (kind === "fallback") {
        await requireGit(repoRoot, ["worktree", "remove", "--force", "--", removed.recoveryPath!]);
      }
      const live = await service.create({ repoRoot, name: "live", baseRef: "HEAD" });
      await fs.writeFile(path.join(live.path, "README.md"), "unrelated unsaved data\n");
      const liveBefore = getRegistryWorktree(env, live.id);
      await fs.mkdir(archived.path, { recursive: true });
      await fs.writeFile(path.join(archived.path, "occupied"), "preserve destination\n");
      await expect(service.restore({ id: archived.id })).rejects.toThrow(/occupied|identity/);
      expect(getRegistryWorktree(env, live.id)).toEqual(liveBefore);
      expect(await fs.readFile(path.join(live.path, "README.md"), "utf8")).toBe(
        "unrelated unsaved data\n",
      );
      await fs.rm(archived.path, { recursive: true });

      const restored = await service.restore({ id: archived.id });
      expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe("base\n");
      expect(getRegistryWorktree(env, live.id)?.removedAt).toEqual(expect.any(Number));
      expect(await service.restore({ id: archived.id })).toEqual(restored);
      expect(
        (await service.listRegistryRecords())
          .filter((record) => record.removedAt === undefined)
          .map((record) => record.id),
      ).toEqual([archived.id]);
    },
  );

  it("refuses a create at the cap when the remaining checkout has a live owner", async () => {
    const active = await service.create({
      repoRoot,
      name: "active",
      baseRef: "HEAD",
      ownerKind: "session",
      ownerId: "agent:main:active",
    });
    const lease = await acquireWorktreeRunLease(active.id, { env });
    try {
      await expect(service.create({ repoRoot, name: "refused", baseRef: "HEAD" })).rejects.toThrow(
        /cap 1.*session:agent:main:active.*worktreeMaxCount/,
      );
      expect(getRegistryWorktree(env, active.id)?.removedAt).toBeUndefined();
      expect(await fs.readFile(path.join(active.path, "README.md"), "utf8")).toBe("base\n");
      expect(await requireGit(repoRoot, ["branch", "--list", "openclaw/refused"])).toBe("");
      expect(await service.listRegistryRecords()).toHaveLength(1);
    } finally {
      await lease.release();
    }
  });
});
