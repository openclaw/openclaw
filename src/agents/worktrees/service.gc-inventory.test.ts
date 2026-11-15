import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import * as gitExec from "../../infra/git-exec.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import * as stateDatabase from "../../state/openclaw-state-db.js";
import * as checkoutInspection from "./checkout-inspection.js";
import { requireGit } from "./git.js";
import * as registryReads from "./registry-read.js";
import * as registry from "./registry.js";
import { getRegistryWorktree } from "./registry.test-support.js";
import { resolveRepository } from "./repository-paths.js";
import { ManagedWorktreeService } from "./service.js";
import {
  makeWorktreeRecord,
  materializeManagedWorktreeFixtures,
  seedWorktreeRunLease,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";
import { useWorktreeStateRoots } from "./state-fixture.test-support.js";
import { hasTemplatesAsync } from "./template-registry-async.js";

const git = (cwd: string, ...args: string[]) => requireGit(cwd, args);
const read = (target: string, file: string) => fs.readFile(path.join(target, file), "utf8");
beforeEach(() => {
  setRuntimeConfigSnapshot({});
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
});

describe("worktree GC inventories", () => {
  const tempDirs = useWorktreeStateRoots();

  const initializeRepository = useManagedWorktreeTestRepository();
  async function fixture(names: string[], now = 1) {
    const root = tempDirs.make("openclaw-gc-");
    const repo = await initializeRepository(root);
    const stateDir = path.join(root, "state");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const records = await materializeManagedWorktreeFixtures({
      env,
      stateDir,
      repoRoot: repo,
      now,
      ownerKind: "session",
      names,
    });
    return { root, repo, env, records };
  }

  function isRepositoryMaintenance(args: readonly string[]): boolean {
    return (
      args[0] === "maintenance" ||
      args[0] === "multi-pack-index" ||
      (args[0] === "rev-parse" &&
        ["--git-common-dir", "--show-object-format"].includes(args[1]!)) ||
      (args[0] === "rev-parse" && args[1] === "--git-path" && args[2] === "objects/pack")
    );
  }

  it("bounds cold cleanup inventories and retains dispositions across registry reopen", async () => {
    const now = Date.now();
    const { root, repo, env, records } = await fixture(
      Array.from({ length: 40 }, (_, index) => `checkout-${index}`),
      now,
    );
    const repository = await resolveRepository(repo);
    for (const record of records) {
      await registry.updateRegistryWorktree(env, record.id, {
        repositoryIdentity: {
          repoRoot: repository.repoRoot,
          repoFingerprint: repository.fingerprint,
        },
      });
    }
    for (const record of records.slice(0, 9)) {
      await registry.updateRegistryWorktree(env, record.id, { lastActiveAt: 1 });
    }
    for (const record of records.slice(0, 4)) {
      await fs.mkdir(path.join(record.path, "nested", ".git"), { recursive: true });
    }
    for (const record of records.slice(4, 7)) {
      await git(record.path, "checkout", "--detach");
    }
    await fs.rm(path.join(records[7]!.path, ".git"));
    const missingRepository = path.join(root, "missing-repository");
    await fs.mkdir(missingRepository);
    await fs.writeFile(path.join(missingRepository, ".git"), "gitdir: missing\n");
    await registry.updateRegistryWorktree(env, records[8]!.id, {
      repositoryIdentity: { repoRoot: missingRepository, repoFingerprint: "missing" },
    });
    const text = vi.spyOn(gitExec, "executeGitCommand");
    const bytes = vi.spyOn(gitExec, "executeGitCommandBytes");
    const buffered = vi.spyOn(gitExec, "executeGitCommandBuffered");
    const resetSpawns = () => [text, bytes, buffered].forEach((spy) => spy.mockClear());
    const gitSpawns = [];
    for (let pass = 0; pass < 2; pass++) {
      if (pass > 0) {
        await stateDatabase.closeOpenClawStateDatabaseAsync();
        stateDatabase.closeOpenClawStateDatabaseForTest();
      }
      resetSpawns();
      const result = await new ManagedWorktreeService({ env }).gc();
      gitSpawns.push(
        text.mock.calls.filter(([, args]) => !isRepositoryMaintenance(args)).length +
          bytes.mock.calls.length +
          buffered.mock.calls.length,
      );
      expect(result.removed).toEqual([]);
      for (const record of records) {
        expect(await read(record.path, "README.md")).toBe("base\n");
      }
    }
    expect(gitSpawns[0]).toBeLessThanOrEqual(50);
    // The displaced registry row leaves an attached candidate in repo. Sweep only
    // repository metadata; unchanged protected checkouts still get no inspection.
    expect(
      [...text.mock.calls, ...bytes.mock.calls, ...buffered.mock.calls]
        .filter(([, args]) => !isRepositoryMaintenance(args))
        .map(([cwd, args]) => [cwd, args]),
    ).toEqual([
      [repo, ["for-each-ref", "--format=%(refname)", "refs/heads/openclaw/"]],
      [missingRepository, ["for-each-ref", "--format=%(refname)", "refs/heads/openclaw/"]],
      [
        repo,
        [
          "for-each-ref",
          "--format=%(refname)%09%(symref)",
          "refs/heads/openclaw/",
          "refs/openclaw/snapshots/",
          "refs/openclaw/removals/",
          "refs/openclaw/restores/",
        ],
      ],
      [repo, ["worktree", "list", "--porcelain", "-z"]],
    ]);
    expect(
      records.slice(0, 9).every((record) => getRegistryWorktree(env, record.id)?.gcProtection),
    ).toBe(true);
    // A managed owner revision reopens only that record, even if it is still idle.
    await registry.updateRegistryWorktree(env, records[0]!.id, { lastActiveAt: 2 });
    resetSpawns();
    await new ManagedWorktreeService({ env }).gc();
    const inspectedPaths = [...text.mock.calls, ...bytes.mock.calls, ...buffered.mock.calls]
      .filter(([cwd, args]) => cwd !== missingRepository && !isRepositoryMaintenance(args))
      .map(([cwd]) => cwd);
    expect(inspectedPaths).toContain(records[0]!.path);
    expect(inspectedPaths.every((cwd) => cwd === repo || cwd === records[0]!.path)).toBe(true);
    // External repairs have an explicit retry path without changing configuration.
    await fs.rm(path.join(records[0]!.path, "nested"), { recursive: true });
    const explicit = new ManagedWorktreeService({ env });
    vi.spyOn(explicit, "remove").mockRejectedValueOnce(new Error("transient removal failure"));
    expect((await explicit.gc({ retryDeferred: true })).outcome).toBe("partial");
    expect(getRegistryWorktree(env, records[0]!.id)?.gcProtection).toBeUndefined();
    const retried = await new ManagedWorktreeService({ env }).gc();
    expect(retried.removed).toEqual([records[0]!.id]);
    await registry.updateRegistryWorktree(env, records[1]!.id, { lastActiveAt: 3 });
    const inspect = checkoutInspection.inspectManagedWorktreeCheckout;
    vi.spyOn(checkoutInspection, "inspectManagedWorktreeCheckout").mockImplementation(
      async (...args) => {
        const result = await inspect(...args);
        if (args[0].id === records[1]!.id && args[1] === "nested-repository") {
          await registry.updateRegistryWorktree(env, records[1]!.id, { lastActiveAt: now });
        }
        return result;
      },
    );
    await new ManagedWorktreeService({ env }).gc();
    expect(getRegistryWorktree(env, records[1]!.id)?.gcProtection).toBeUndefined();
  });

  it.each(["inner", ".openclaw/tmp/inner"])(
    "retries nested-repository protection after removing %s",
    async (nestedPath) => {
      const {
        repo: repoRoot,
        env,
        records: [nested, moved],
      } = await fixture(["nested", "moved"]);
      await fs.mkdir(path.join(nested!.path, nestedPath, ".git"), { recursive: true });
      await git(moved!.path, "checkout", "-b", "external-branch");
      await git(repoRoot, "pack-refs", "--all");
      const service = new ManagedWorktreeService({ env });
      const inspections = vi.spyOn(checkoutInspection, "inspectManagedWorktreeCheckout");

      const first = await service.gc();
      expect(first.removed).toEqual([]);
      expect(first.protectionReasons).toEqual({
        "worktree contains a nested repository": 1,
        "branch-moved": 1,
      });
      expect(inspections).toHaveBeenCalled();
      inspections.mockClear();
      // Packing an unrelated branch must not invalidate these unchanged checkout tips.
      await git(repoRoot, "update-ref", "refs/heads/unrelated", "HEAD");
      await git(repoRoot, "pack-refs", "--all");
      expect((await service.gc()).removed).toEqual([]);
      expect(inspections).not.toHaveBeenCalled();

      // External repair changes the checkout fingerprint, not its registry revision.
      await fs.rm(path.join(nested!.path, nestedPath), { recursive: true });
      expect(getRegistryWorktree(env, nested!.id)?.lastActiveAt).toBe(1);
      expect((await service.gc()).removed).toEqual([nested!.id]);
      expect(inspections.mock.calls.length).toBeGreaterThan(0);
      expect(inspections.mock.calls.every(([record]) => record.id === nested!.id)).toBe(true);
      inspections.mockClear();
      await git(moved!.path, "checkout", moved!.branch);
      expect(getRegistryWorktree(env, moved!.id)?.lastActiveAt).toBe(1);
      expect((await service.gc()).removed).toEqual([moved!.id]);
      expect(inspections.mock.calls.length).toBeGreaterThan(0);
      expect(inspections.mock.calls.every(([record]) => record.id === moved!.id)).toBe(true);
    },
  );

  async function addLeasedWorktree(env: NodeJS.ProcessEnv, root: string, id: string) {
    await seedWorktreeRunLease(
      env,
      makeWorktreeRecord(root, id, {
        branch: `openclaw/${id}`,
        ownerId: id,
      }),
    );
  }

  it("protects a sweep of live leases without writer admission or checkout inspection", async () => {
    const root = tempDirs.make("openclaw-gc-leases-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    const count = 16;
    for (let index = 0; index < count; index++) {
      const id = `leased-${index}`;
      await addLeasedWorktree(env, root, id);
    }
    await hasTemplatesAsync(env);
    const writes = vi.spyOn(stateDatabase, "runOpenClawStateWriteTransaction");
    const reads = vi.spyOn(registryReads, "readRegistryWorktrees");
    const cleanupReads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    const inspections = vi.spyOn(checkoutInspection, "inspectManagedWorktreeCheckout");
    // Warm the retained reader before measuring steady-state cleanup.
    await new ManagedWorktreeService({ env }).gc();
    expect(inspections).not.toHaveBeenCalled();
    writes.mockClear();
    reads.mockClear();
    cleanupReads.mockClear();
    inspections.mockClear();
    const result = await new ManagedWorktreeService({ env }).gc();
    const measurements = {
      writes: writes.mock.calls.length,
      registryReads: cleanupReads.mock.calls.filter(
        ([, command]) => command.type === "worktrees.cleanupState",
      ).length,
      maintenanceInventoryReads: reads.mock.calls.length,
      checkoutInspections: inspections.mock.calls.length,
    };
    expect(result.removed).toEqual([]);
    expect(result.protectedCount).toBe(count);
    expect(result.issues.filter((issue) => issue.reason === "run lease is active")).toHaveLength(
      count,
    );
    // This fixture has no Git repository; both repository phases report that failure.
    expect(result.issues).toHaveLength(count + 2);
    expect(result.issues.at(-2)?.stage).toBe("orphans");
    expect(result.issues.at(-1)?.stage).toBe("git-maintenance");
    expect(measurements).toMatchObject({
      writes: 0,
      registryReads: 1,
      maintenanceInventoryReads: 1,
      checkoutInspections: 0,
    });
  });

  it("protects a late lease without loading removed history for cleanup limits", async () => {
    const root = tempDirs.make("openclaw-gc-late-lease-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    await addLeasedWorktree(env, root, "initial");
    await addLeasedWorktree(env, root, "second");
    const removedHistoryAt = Date.now();
    await registry.insertRegistryWorktree(env, {
      ...getRegistryWorktree(env, "initial")!,
      id: "removed-history",
      removedAt: removedHistoryAt,
    });
    const reads = vi.spyOn(registryReads, "readRegistryWorktrees");
    const inspections = vi.spyOn(checkoutInspection, "inspectManagedWorktreeCheckout");
    const readCleanupState = registryReads.readWorktreeCleanupState;
    let publishedLateLease = false;
    vi.spyOn(registryReads, "readWorktreeCleanupState").mockImplementation(async (options) => {
      const state = await readCleanupState(options);
      if (!publishedLateLease) {
        publishedLateLease = true;
        await addLeasedWorktree(env, root, "late");
      }
      return state;
    });
    const result = await new ManagedWorktreeService({
      env,
      getConfig: () => ({ worktreeMaxCount: 1 }),
    }).gc();
    expect(result.removed).toEqual([]);
    expect(result.protectedCount).toBe(3);
    expect(result.protectionReasons).toEqual({ "live-refused": 3 });
    expect(result.limitsSatisfied).toBe(false);
    expect(inspections).not.toHaveBeenCalled();
    const batches = await Promise.all(reads.mock.results.map((readResult) => readResult.value));
    const history = expect.objectContaining({ id: "removed-history" });
    // Only the final repository-maintenance pass needs retained snapshot repositories.
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches.slice(0, -1)) {
      expect(batch).not.toContainEqual(history);
    }
    expect(batches.at(-1)).toContainEqual(history);
    expect(await new ManagedWorktreeService({ env }).listRegistryRecords()).toContainEqual(
      expect.objectContaining({ id: "removed-history", removedAt: removedHistoryAt }),
    );
  });
});
