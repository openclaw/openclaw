import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as backoff from "../../infra/backoff.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { directorySizeBytes } from "./capacity.js";
import * as checkoutGit from "./checkout-git-config.js";
import * as worktreeGit from "./git.js";
import * as registryRead from "./registry-read.js";
import * as registry from "./registry.js";
import { getRegistryWorktree } from "./registry.js";
import * as runLease from "./run-lease.js";
import { IDLE_GC_MS, ManagedWorktreeService } from "./service.js";
import {
  materializeManagedWorktreeFixture,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";
import type { ManagedWorktreeRecord } from "./types.js";

const execFileAsync = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();

describe("GC pressure removal reconciliation", () => {
  const temporary = useAutoCleanupTempDirTracker(afterEach);
  const initializeRepository = useManagedWorktreeTestRepository();
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let now: number;
  let service: ManagedWorktreeService;

  beforeEach(async () => {
    root = await fs.realpath(temporary.make("openclaw-gc-pressure-"));
    repo = await initializeRepository(root);
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    now = 1_700_000_000_000;
    service = new ManagedWorktreeService({ env, now: () => now });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  });

  async function materialize(
    name: string,
    options: { repoRoot?: string; ownerKind?: ManagedWorktreeRecord["ownerKind"] } = {},
  ) {
    return await materializeManagedWorktreeFixture({
      env,
      name,
      now,
      repoRoot: options.repoRoot ?? repo,
      stateDir: env.OPENCLAW_STATE_DIR!,
      ownerKind: options.ownerKind ?? "session",
      ownerId: `agent:main:${name}`,
    });
  }

  async function pair(stage: "idle" | "limits" = "limits") {
    const oldest = await materialize("oldest");
    await fs.writeFile(path.join(oldest.path, "README.md"), "recover oldest edits\n");
    now += stage === "idle" ? IDLE_GC_MS + 1 : 1;
    const newest = await materialize("newest");
    await fs.writeFile(path.join(newest.path, "README.md"), "keep newest edits\n");
    return { oldest, newest };
  }

  async function limits(kind: "count" | "size", records: ManagedWorktreeRecord[]) {
    if (kind === "count") {
      return { maxCount: 1 };
    }
    const sizes = await Promise.all(records.map((record) => directorySizeBytes(record.path)));
    // Either single checkout fits; together they exceed the measured cap.
    return { maxTotalSizeBytes: Math.max(...sizes) };
  }

  function interceptRemoval(
    run: (
      original: checkoutGit.WorktreeGitPolicy["run"],
      ...args: Parameters<checkoutGit.WorktreeGitPolicy["run"]>
    ) => ReturnType<checkoutGit.WorktreeGitPolicy["run"]>,
  ) {
    const original = checkoutGit.withWorktreeGitConfig;
    vi.spyOn(checkoutGit, "withWorktreeGitConfig").mockImplementation(
      async (cwd, sourceOnly, guard, operation) =>
        await original(
          cwd,
          sourceOnly,
          guard,
          async (policy) =>
            await operation({
              ...policy,
              run: (...args) => run(policy.run, ...args),
            }),
        ),
    );
  }

  for (const stage of ["idle", "limits"] as const) {
    for (const kind of ["count", "size"] as const) {
      it.each(["guard", "git-exit", "claim-rollback"] as const)(
        `stops ${kind} pressure eviction after unresolved ${stage} %s failure`,
        async (failure) => {
          const { oldest, newest } = await pair(stage);
          const cap = await limits(kind, [oldest, newest]);
          let deleted = false;
          interceptRemoval(async (run, cwd, args, options) => {
            const result = await run(cwd, args, options);
            if (args[0] === "worktree" && args[1] === "remove" && args.at(-1) === oldest.path) {
              expect(result.code).toBe(0);
              deleted = true;
              if (failure !== "guard") {
                return { ...result, code: 1, stderr: "injected Git removal failure" };
              }
            }
            return result;
          });
          if (failure === "claim-rollback") {
            vi.spyOn(runLease, "abortWorktreeRemoval").mockImplementation(() => {
              throw new Error("injected claim rollback failure");
            });
          }

          const result = await service.gc({
            limits: cap,
            shouldProtectOwner: (_kind, owner) => owner === oldest.ownerId && deleted,
          });

          expect(deleted).toBe(true);
          expect(result.removed).toEqual([]);
          expect(result.limitsSatisfied).toBeNull();
          expect(result.outcome).toBe("partial");
          expect(result.issues).toContainEqual(
            expect.objectContaining({ id: oldest.id, stage, outcome: "failed" }),
          );
          await expect(fs.stat(oldest.path)).rejects.toMatchObject({ code: "ENOENT" });
          expect(getRegistryWorktree(env, oldest.id)?.removedAt).toBeUndefined();
          expect(getRegistryWorktree(env, newest.id)?.removedAt).toBeUndefined();
          expect(await fs.readFile(path.join(newest.path, "README.md"), "utf8")).toBe(
            "keep newest edits\n",
          );
          const snapshot = getRegistryWorktree(env, oldest.id)!.snapshotRef!;
          expect(await git(repo, "show", `${snapshot}:README.md`)).toBe("recover oldest edits");
          expect(await git(repo, "rev-parse", `refs/openclaw/removals/${oldest.id}`)).toBe(
            await git(repo, "rev-parse", snapshot),
          );
          if (failure === "claim-rollback") {
            expect(result.issues[0]?.reason).toContain("injected claim rollback failure");
            expect(result.issues[0]?.reason).toContain("injected Git removal failure");
          }
        },
      );
    }
  }

  it.each(["count", "size"] as const)(
    "defers %s pressure eviction for a pending claim on a later candidate",
    async (kind) => {
      const { oldest, newest } = await pair();
      const cap = await limits(kind, [oldest, newest]);
      const token = "competing-remover";
      runLease.claimWorktreeRemoval(env, { worktreeId: newest.id, token });
      try {
        const result = await service.gc({ limits: cap });
        expect(result).toMatchObject({ removed: [], outcome: "deferred", limitsSatisfied: null });
        expect(result.issues).toContainEqual(
          expect.objectContaining({ stage: "limits", outcome: "deferred" }),
        );
        expect(await fs.readFile(path.join(oldest.path, "README.md"), "utf8")).toBe(
          "recover oldest edits\n",
        );
        expect(await fs.readFile(path.join(newest.path, "README.md"), "utf8")).toBe(
          "keep newest edits\n",
        );
      } finally {
        runLease.abortWorktreeRemoval(env, newest.id, token);
      }
      // Settling the competing claim permits the next pass to remove exactly one.
      const settled = await service.gc({ limits: cap });
      expect(settled).toMatchObject({ removed: [oldest.id], limitsSatisfied: true });
      const restored = await service.restore({ id: oldest.id });
      expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe(
        "recover oldest edits\n",
      );
    },
  );

  it.each([
    { kind: "count", failure: false, retire: false },
    { kind: "size", failure: false, retire: false },
    { kind: "count", failure: true, retire: false },
    { kind: "size", failure: true, retire: false },
    { kind: "count", failure: true, retire: true },
    { kind: "size", failure: true, retire: true },
  ] as const)(
    "rechecks $kind pressure after queued removal acquires authority (failure=$failure, retire=$retire)",
    async ({ kind, failure, retire }) => {
      const { oldest, newest } = await pair();
      const cap = await limits(kind, [oldest, newest]);
      const deleting = createDeferred();
      const resume = createDeferred();
      const queued = createDeferred();
      interceptRemoval(async (run, cwd, args, options) => {
        if (args[0] === "worktree" && args[1] === "remove" && args.at(-1) === newest.path) {
          deleting.resolve();
          await resume.promise;
          const result = await run(cwd, args, options);
          expect(result.code).toBe(0);
          return failure ? { ...result, code: 1, stderr: "competing removal failed" } : result;
        }
        return await run(cwd, args, options);
      });
      let competingFailed = false;
      let reconciled = false;
      let concurrentGc: ReturnType<typeof service.gc> | undefined;
      const retired = createDeferred();
      const retireMissing = registry.retireMissingRegistryWorktree;
      vi.spyOn(registry, "retireMissingRegistryWorktree").mockImplementation((...args) => {
        const result = retireMissing(...args);
        if (args[1].id === newest.id) {
          retired.resolve();
        }
        return result;
      });
      const readInventory = registryRead.readRegistryWorktrees;
      vi.spyOn(registryRead, "readRegistryWorktrees").mockImplementation(async (state) => {
        if (retire && competingFailed && !reconciled) {
          reconciled = true;
          // A real second GC retires the now-missing checkout outside the allocation lease.
          // Its retirement must also remove that row's cached size/count pressure.
          concurrentGc = service.gc({ limits: {} });
          await Promise.race([
            retired.promise,
            concurrentGc.then(() => {
              throw new Error("Concurrent GC did not retire the missing checkout");
            }),
          ]);
        }
        return await readInventory(state);
      });
      const competing = service
        .remove({ id: newest.id, reason: "concurrent-cleanup" })
        .catch((error: unknown) => {
          competingFailed = true;
          return error;
        });
      let collection: ReturnType<typeof service.gc> | undefined;
      try {
        await Promise.race([
          deleting.promise,
          competing.then(() => {
            throw new Error("Removal never reached Git");
          }),
        ]);
        // Observe the real allocation lease wait without a timer or polling loop.
        vi.spyOn(backoff, "sleepWithAbort").mockImplementation(async () => {
          queued.resolve();
          if (reconciled && collection) {
            await collection;
          } else {
            await competing;
          }
        });
        collection = service.gc({ limits: cap });
        await Promise.race([
          queued.promise,
          collection.then(() => {
            throw new Error("GC did not queue for removal authority");
          }),
        ]);
        resume.resolve();
        const removal = await competing;
        const result = await collection;
        expect(result.removed).toEqual([]);
        expect(result.limitsSatisfied).toBe(failure && !retire ? null : true);
        expect(getRegistryWorktree(env, oldest.id)?.removedAt).toBeUndefined();
        if (failure) {
          expect(removal).toBeInstanceOf(Error);
          if (retire) {
            expect(reconciled).toBe(true);
            expect(getRegistryWorktree(env, newest.id)?.removedAt).toBeDefined();
          } else {
            expect(result.outcome).toBe("partial");
            expect(getRegistryWorktree(env, newest.id)?.removedAt).toBeUndefined();
          }
          await expect(fs.stat(newest.path)).rejects.toMatchObject({ code: "ENOENT" });
          expect(await git(repo, "show", `refs/openclaw/removals/${newest.id}:README.md`)).toBe(
            "keep newest edits",
          );
        } else {
          expect(removal).not.toBeInstanceOf(Error);
          expect(getRegistryWorktree(env, newest.id)?.removedAt).toBeDefined();
        }
        expect(await fs.readFile(path.join(oldest.path, "README.md"), "utf8")).toBe(
          "recover oldest edits\n",
        );
      } finally {
        resume.resolve();
        await Promise.allSettled([competing, collection, concurrentGc]);
      }
    },
  );

  it.each(["count", "size"] as const)(
    "observes a %s removal claim arriving during reconciliation probes",
    async (kind) => {
      const { oldest, newest } = await pair();
      const cap = await limits(kind, [oldest, newest]);
      const token = "claim-during-probe";
      const realRun = worktreeGit.runGit;
      let claimed = false;
      vi.spyOn(worktreeGit, "runGit").mockImplementation(async (cwd, args, options) => {
        const result = await realRun(cwd, args, options);
        if (
          !claimed &&
          (args[0] === "for-each-ref" ||
            (args[0] === "show-ref" && args.at(-1) === `refs/openclaw/removals/${newest.id}`))
        ) {
          claimed = true;
          runLease.claimWorktreeRemoval(env, { worktreeId: newest.id, token });
        }
        return result;
      });
      try {
        const result = await service.gc({ limits: cap });
        expect(claimed).toBe(true);
        expect(result).toMatchObject({ removed: [], outcome: "deferred", limitsSatisfied: null });
        expect(await fs.readFile(path.join(oldest.path, "README.md"), "utf8")).toBe(
          "recover oldest edits\n",
        );
        expect(await fs.readFile(path.join(newest.path, "README.md"), "utf8")).toBe(
          "keep newest edits\n",
        );
      } finally {
        runLease.abortWorktreeRemoval(env, newest.id, token);
      }
    },
  );

  it.each(["count", "size"] as const)(
    "refreshes %s totals after final reconciliation probes",
    async (kind) => {
      const oldest = await materialize("oldest");
      const cap = await limits(kind, [oldest]);
      const realRun = worktreeGit.runGit;
      let concurrent: ManagedWorktreeRecord | undefined;
      vi.spyOn(worktreeGit, "runGit").mockImplementation(async (cwd, args, options) => {
        const result = await realRun(cwd, args, options);
        if (
          !concurrent &&
          (args[0] === "for-each-ref" ||
            (args[0] === "show-ref" && args.at(-1) === `refs/openclaw/removals/${oldest.id}`))
        ) {
          concurrent = await materialize("created-during-reconciliation");
        }
        return result;
      });
      const result = await service.gc({ limits: cap });
      expect(concurrent).toBeDefined();
      expect(result.removed).toEqual([]);
      expect(result.limitsSatisfied).toBe(kind === "count" ? false : null);
      expect(result.issues).toContainEqual(
        expect.objectContaining({ id: concurrent!.id, stage: "limits", outcome: "deferred" }),
      );
      expect(await fs.readFile(path.join(oldest.path, "README.md"), "utf8")).toBe("base\n");
      expect(await fs.readFile(path.join(concurrent!.path, "README.md"), "utf8")).toBe("base\n");
    },
  );

  it.each(["records", "claims"] as const)(
    "reports unknown compliance when reconciliation %s cannot be read",
    async (source) => {
      const record = await materialize("retained-on-read-failure");
      const failure = new Error("injected reconciliation read failure");
      if (source === "records") {
        // The first inventory succeeds; the separate reconciliation read fails.
        const read = registryRead.readRegistryWorktrees;
        vi.spyOn(registryRead, "readRegistryWorktrees")
          .mockImplementationOnce(read)
          .mockRejectedValueOnce(failure);
      } else {
        vi.spyOn(registry, "findPendingWorktreeRemoval").mockImplementationOnce(() => {
          throw failure;
        });
      }
      const result = await service.gc({ limits: { maxCount: 1, maxTotalSizeBytes: 1024 ** 3 } });
      expect(result).toMatchObject({ removed: [], outcome: "partial", limitsSatisfied: null });
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          stage: "limits",
          outcome: "failed",
          reason: expect.stringContaining(failure.message),
        }),
      );
      expect(getRegistryWorktree(env, record.id)?.removedAt).toBeUndefined();
      expect(await fs.readFile(path.join(record.path, "README.md"), "utf8")).toBe("base\n");
    },
  );

  it.each(["count", "size"] as const)(
    "holds removal authority across final %s reconciliation in multiple repositories",
    async (kind) => {
      const first = await materialize("manual-first", { ownerKind: "manual" });
      const otherRepo = await initializeRepository(path.join(root, "other"));
      const second = await materialize("manual-second", {
        ownerKind: "manual",
        repoRoot: otherRepo,
      });
      const cap = await limits(kind, [first, second]);
      const queued = createDeferred();
      const resume = createDeferred();
      let deleted = false;
      interceptRemoval(async (run, cwd, args, options) => {
        const result = await run(cwd, args, options);
        if (args[0] === "worktree" && args[1] === "remove" && args.at(-1) === first.path) {
          expect(result.code).toBe(0);
          deleted = true;
          return { ...result, code: 1, stderr: "competing finalization failed" };
        }
        return result;
      });
      vi.spyOn(backoff, "sleepWithAbort").mockImplementation(async () => {
        queued.resolve();
        await resume.promise;
      });
      let competing: Promise<unknown> | undefined;
      const realRun = worktreeGit.runGit;
      vi.spyOn(worktreeGit, "runGit").mockImplementation(async (cwd, args, options) => {
        const result = await realRun(cwd, args, options);
        if (!competing && cwd === otherRepo && args[0] === "for-each-ref") {
          competing = service
            .remove({ id: first.id, reason: "concurrent-final-report" })
            .catch((error: unknown) => error);
          // The broken implementation finishes the deletion here. The fixed
          // implementation queues it until the reporting snapshot is complete.
          await Promise.race([competing, queued.promise]);
        }
        return result;
      });
      try {
        const result = await service.gc({ limits: cap });
        expect(competing).toBeDefined();
        expect(result).toMatchObject({ removed: [], limitsSatisfied: false });
        expect(deleted).toBe(false);
        expect(await fs.readFile(path.join(first.path, "README.md"), "utf8")).toBe("base\n");
        expect(await fs.readFile(path.join(second.path, "README.md"), "utf8")).toBe("base\n");
      } finally {
        resume.resolve();
        if (competing) {
          expect(await competing).toBeInstanceOf(Error);
        }
      }
      expect(deleted).toBe(true);
      expect(getRegistryWorktree(env, first.id)?.removedAt).toBeUndefined();
      expect(await git(repo, "show", `refs/openclaw/removals/${first.id}:README.md`)).toBe("base");
    },
  );

  it.each(["count", "size"] as const)(
    "continues %s eviction past an ordinary protected owner",
    async (kind) => {
      const { oldest, newest } = await pair();
      const result = await service.gc({
        limits: await limits(kind, [oldest, newest]),
        shouldProtectOwner: (_kind, owner) => owner === oldest.ownerId,
      });
      expect(result).toMatchObject({
        removed: [newest.id],
        protectedCount: 1,
        limitsSatisfied: true,
      });
      expect(await fs.readFile(path.join(oldest.path, "README.md"), "utf8")).toBe(
        "recover oldest edits\n",
      );
    },
  );
});
