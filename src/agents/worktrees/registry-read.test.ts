import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { WORKTREE_CREATE_LEASE_SCOPE } from "./capacity-contract.js";
import { lockState } from "./git-lock.js";
import * as worktreeGit from "./git.js";
import { insertRegistryWorktreeProvisionedChunk } from "./provisioned-snapshot.test-support.js";
import {
  getRegistryWorktreeProvisionedChunk,
  readLiveRegistryWorktreeByOwner,
  readLiveRegistryWorktreeIds,
  readRegistryWorktrees,
} from "./registry-read.js";
import {
  getRegistryWorktree,
  getRegistryWorktreeProvisionedPaths,
  getRegistryWorktreeProvisionedState,
  insertRegistryWorktree,
  listRegistryWorktrees,
  updateRegistryWorktree,
} from "./registry.js";
import { resolveWorktreeForPath } from "./run-lease.js";
import { ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";
import type { ManagedWorktreeRecord } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const initializeRepository = useManagedWorktreeTestRepository();

async function serviceFixture() {
  const root = tempDirs.make("worktree-registry-publication-");
  const repoRoot = await initializeRepository(root);
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  const now = vi.fn(() => 1_700_000_000_000);
  const service = new ManagedWorktreeService({
    env,
    now,
    getConfig: () => ({ worktreeAcceleration: false }),
  });
  const params = {
    repoRoot,
    name: "publication",
    baseRef: "HEAD",
    ownerKind: "session" as const,
    ownerId: "registry-owner",
  };
  return { env, now, service, params };
}

function holdPublication(type: "worktrees.insert" | "worktrees.update", afterCommit = false) {
  const entered = createDeferred();
  const release = createDeferred();
  const run = stateWorker.runOpenClawStateWorkerOperation;
  let writes = 0;
  const transport = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementation((context, operation, options) =>
      run(
        context,
        (scope) =>
          operation({
            execute: async (command, executeOptions) => {
              if (command.type !== type) {
                return scope.execute(command, executeOptions);
              }
              writes += 1;
              if (afterCommit) {
                await scope.execute(command, executeOptions);
              }
              entered.resolve();
              await release.promise;
              if (afterCommit) {
                throw new Error("Synthetic lost registry reply after native commit");
              }
              return scope.execute(command, executeOptions);
            },
          }),
        options,
      ),
    );
  return {
    entered: entered.promise,
    release: () => release.resolve(),
    writes: () => writes,
    restore: () => transport.mockRestore(),
  };
}

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("managed worktree registry worker reads", () => {
  it("retains the original store across missing-checkout retirement", async () => {
    const originalRoot = tempDirs.make("worktree-original-store-");
    const replacementRoot = tempDirs.make("worktree-replacement-store-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: originalRoot };
    const replacementEnv = { ...env, OPENCLAW_STATE_DIR: replacementRoot };
    const record: ManagedWorktreeRecord = {
      id: "shared-backup-row",
      name: "shared-backup-row",
      repoFingerprint: "0123456789abcdef",
      repoRoot: path.join(originalRoot, "repo"),
      path: path.join(originalRoot, "shared-backup-row"),
      branch: "openclaw/shared-backup-row",
      baseRef: "HEAD",
      ownerKind: "manual",
      createdAt: 1,
      lastActiveAt: 1,
    };
    await insertRegistryWorktree(env, record);
    await insertRegistryWorktree(replacementEnv, record);
    const entered = createDeferred();
    const release = createDeferred();
    const exists = worktreeGit.worktreePathExists;
    const probe = vi.spyOn(worktreeGit, "worktreePathExists").mockImplementation(async (target) => {
      const present = await exists(target);
      if (target === record.path) {
        entered.resolve();
        await release.promise;
      }
      return present;
    });
    const pending = new ManagedWorktreeService({ env }).list();
    try {
      await awaitGateBeforeSettlement(entered.promise, pending, "Checkout probe never started");
      env.OPENCLAW_STATE_DIR = replacementRoot;
      release.resolve();
      await expect(pending).rejects.toThrow("Worktree settlement database changed");
    } finally {
      release.resolve();
      await pending.catch(() => {});
      probe.mockRestore();
      env.OPENCLAW_STATE_DIR = originalRoot;
    }
    expect(await readRegistryWorktrees(env)).toEqual([record]);
    expect(await readRegistryWorktrees(replacementEnv)).toEqual([record]);
  });

  it("reads registry records without retiring a temporarily unavailable worktree", async () => {
    const root = tempDirs.make("worktree-registry-unavailable-");
    const repo = await initializeRepository(root);
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    const now = 1_700_000_000_000;
    const service = new ManagedWorktreeService({
      env,
      now: () => now,
      getConfig: () => ({ worktreeAcceleration: false }),
    });
    const created = await service.create({
      repoRoot: repo,
      name: "read-only-list",
      baseRef: "HEAD",
    });
    await fs.rm(created.path, { recursive: true, force: true });
    expect(await service.listRegistryRecords()).toEqual([created]);
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
    expect(await service.list()).toEqual([]);
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBe(now);
  });

  it("creates, resolves, lists, and publishes activity without caller-thread registry SQL", async () => {
    const { env, now, service, params } = await serviceFixture();
    await service.listRegistryRecords();
    const { db } = openOpenClawStateDatabase({ env });
    const sql = observeHostDataSql();
    // Synchronous lock primitives retain state_leases SQL; registry rows belong to the worker.
    const registryQueries = () =>
      sql.queries.filter((query) => /\b(?:from|into|update)\s+"?worktrees\b/i.test(query));
    try {
      db.prepare("SELECT id FROM worktrees").all();
      expect(registryQueries().length).toBeGreaterThan(0);
      sql.queries.length = 0;
      const record = await service.create(params);
      const bound = await resolveWorktreeForPath({
        env,
        sessionEntry: { worktree: { id: record.id } },
        candidatePaths: [],
      });
      expect(bound?.record).toEqual(record);
      const selected = await resolveWorktreeForPath({
        env,
        candidatePaths: [path.join(record.path, "README.md")],
      });
      expect(selected?.record).toEqual(record);
      expect(await service.list()).toEqual([record]);
      now.mockReturnValue(record.lastActiveAt + 1);
      expect(await service.acquire(record.id)).toMatchObject({
        id: record.id,
        lastActiveAt: now(),
      });
      await service.release(record.id);
      expect(registryQueries()).toEqual([]);
    } finally {
      sql.restore();
    }
  });

  it.each(["create", "activity"] as const)(
    "awaits %s acknowledgement and never replays its committed lost reply",
    async (kind) => {
      const { env, now, service, params } = await serviceFixture();
      const existing = kind === "activity" ? await service.create(params) : undefined;
      now.mockReturnValue(now() + 1);
      const publication = holdPublication(existing ? "worktrees.update" : "worktrees.insert", true);
      let settled = false;
      const pending = (existing ? service.acquire(existing.id) : service.create(params)).finally(
        () => {
          settled = true;
        },
      );
      try {
        await awaitGateBeforeSettlement(
          publication.entered,
          pending,
          "Registry publication never reached the worker",
        );
        const id = listRegistryWorktrees(env)[0]!.id;
        expect(settled).toBe(false);
        expect(getRegistryWorktree(env, id)).toMatchObject({ id, lastActiveAt: now() });
        publication.release();
        expect(await pending).toMatchObject({ id, lastActiveAt: now() });
        expect(publication.writes()).toBe(1);
        expect(await service.listRegistryRecords()).toHaveLength(1);
      } finally {
        publication.release();
        await pending.catch(() => {});
        publication.restore();
        if (existing) {
          await service.release(existing.id);
        }
      }
    },
  );

  it.each(["replacement", "retained lock", "allocation lease", "caller"] as const)(
    "preserves registry and checkout on refused publication (%s)",
    async (kind) => {
      const { env, now, service, params } = await serviceFixture();
      const existing =
        kind === "replacement" || kind === "retained lock"
          ? await service.create(params)
          : undefined;
      if (existing && kind === "retained lock") {
        await service.acquire(existing.id);
      }
      now.mockReturnValue(now() + 1);
      let current = true;
      const publication = holdPublication(existing ? "worktrees.update" : "worktrees.insert");
      const pending = existing
        ? service.acquire(existing.id)
        : service.create({
            ...params,
            commitGuard: () => {
              if (!current) {
                throw new Error("Synthetic caller authority revoked");
              }
            },
          });
      try {
        await awaitGateBeforeSettlement(
          publication.entered,
          pending,
          "Registry publication never queued",
        );
        const { db } = openOpenClawStateDatabase({ env });
        if (existing) {
          db.prepare("UPDATE worktrees SET branch = ? WHERE id = ?").run(
            "replacement-branch",
            existing.id,
          );
        } else if (kind === "allocation lease") {
          db.prepare("UPDATE state_leases SET owner = ? WHERE scope = ?").run(
            "replacement-owner",
            WORKTREE_CREATE_LEASE_SCOPE,
          );
        } else {
          current = false;
        }
        publication.release();
        await expect(pending).rejects.toThrow(/changed|lease|revoked/i);
        if (existing) {
          expect(getRegistryWorktree(env, existing.id)).toMatchObject({
            branch: "replacement-branch",
            lastActiveAt: existing.lastActiveAt,
          });
          expect(await fs.readFile(path.join(existing.path, "README.md"), "utf8")).toBe("base\n");
          expect(await lockState(existing)).toEqual(
            kind === "retained lock" ? { kind: "live", pid: process.pid } : { kind: "none" },
          );
        } else {
          expect(await service.listRegistryRecords()).toEqual([]);
        }
      } finally {
        publication.release();
        await pending.catch(() => {});
        publication.restore();
        if (existing) {
          await service.release(existing.id);
        }
      }
    },
  );

  it("reads captured registry records and provisioned snapshots without host SQL or checkout reconciliation", async () => {
    const stateDir = tempDirs.make("worktree-registry-worker-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const service = new ManagedWorktreeService({ env });
    requireNodeSqlite();
    const sql = observeMainThreadSql();
    sql.calibrate();

    expect(await getRegistryWorktreeProvisionedPaths(env, "missing")).toBeUndefined();
    expect(await getRegistryWorktreeProvisionedState(env, "missing")).toBeUndefined();
    expect(
      await getRegistryWorktreeProvisionedChunk(env, {
        worktreeId: "missing",
        path: "synthetic.bin",
        chunkIndex: 0,
      }),
    ).toBeUndefined();
    expect(await service.listRegistryRecords()).toEqual([]);
    expect(await readLiveRegistryWorktreeIds(env)).toEqual([]);
    expect((await fs.stat(path.join(stateDir, "state", "openclaw.sqlite"))).isFile()).toBe(true);
    sql.expectIdle();

    const older: ManagedWorktreeRecord = {
      id: "older",
      name: "older",
      repoFingerprint: "0123456789abcdef",
      repoRoot: path.join(stateDir, "missing-repo"),
      path: path.join(stateDir, "missing-checkouts", "older"),
      branch: "openclaw/older",
      baseRef: "HEAD",
      ownerKind: "session",
      ownerId: "agent:main:task",
      createdAt: 10,
      lastActiveAt: 30,
      runEndCleanup: { outcome: "retained-dirty", at: 30 },
    };
    const removed: ManagedWorktreeRecord = {
      ...older,
      id: "a-removed",
      name: "a-removed",
      path: path.join(stateDir, "missing-checkouts", "a-removed"),
      createdAt: 20,
      removedAt: 40,
      snapshotRef: "refs/openclaw/snapshots/a-removed",
      runEndCleanup: { outcome: "removed-lossless", at: 40 },
    };
    const newer: ManagedWorktreeRecord = {
      ...older,
      id: "z-newer",
      name: "z-newer",
      path: path.join(stateDir, "missing-checkouts", "z-newer"),
      createdAt: 20,
      runEndCleanup: { outcome: "failed", at: 30, reason: "synthetic cleanup failure" },
    };
    await insertRegistryWorktree(env, newer, { provisionedPaths: ["legacy.local"] });
    await insertRegistryWorktree(env, older);
    await insertRegistryWorktree(env, removed);
    const provisionedState = [{ path: "synthetic.bin", mode: 0o600, chunks: 2 }];
    await updateRegistryWorktree(env, older.id, { provisionedState });
    const chunks = [Uint8Array.from([0, 255, 10]), Uint8Array.from([127, 0, 1])];
    for (const [chunkIndex, data] of chunks.entries()) {
      await insertRegistryWorktreeProvisionedChunk(env, {
        worktreeId: older.id,
        path: "synthetic.bin",
        chunkIndex,
        data,
      });
    }
    openOpenClawStateDatabase({ env })
      .db.prepare("UPDATE worktrees SET provisioned_paths_json = ? WHERE id = ?")
      .run("{malformed", removed.id);
    await closeOpenClawStateDatabaseAsync();
    sql.clear();

    const pending = service.listRegistryRecords();
    env.OPENCLAW_STATE_DIR = path.join(stateDir, "unused-state");
    expect(await pending).toEqual([removed, newer, older]);
    await closeOpenClawStateDatabaseAsync();
    sql.expectIdle();

    env.OPENCLAW_STATE_DIR = stateDir;
    const listOptions = { liveOnly: true };
    const liveRecords = readRegistryWorktrees(env, listOptions);
    listOptions.liveOnly = false;
    env.OPENCLAW_STATE_DIR = path.join(stateDir, "unused-state");
    expect(await liveRecords).toEqual([newer, older]);
    sql.expectIdle();

    env.OPENCLAW_STATE_DIR = stateDir;
    const snapshotReads = Promise.all([
      getRegistryWorktreeProvisionedPaths(env, older.id),
      getRegistryWorktreeProvisionedState(env, older.id),
    ]);
    env.OPENCLAW_STATE_DIR = path.join(stateDir, "unused-state");
    expect(await snapshotReads).toEqual([["synthetic.bin"], provisionedState]);
    env.OPENCLAW_STATE_DIR = stateDir;
    const selectedChunk = { worktreeId: older.id, path: "synthetic.bin", chunkIndex: 0 };
    const firstChunk = getRegistryWorktreeProvisionedChunk(env, selectedChunk);
    selectedChunk.path = "different.bin";
    selectedChunk.chunkIndex = 1;
    env.OPENCLAW_STATE_DIR = path.join(stateDir, "unused-state");
    expect(Array.from((await firstChunk)!)).toEqual(Array.from(chunks[0]!));
    env.OPENCLAW_STATE_DIR = stateDir;
    expect(
      Array.from(
        (await getRegistryWorktreeProvisionedChunk(env, {
          worktreeId: older.id,
          path: "synthetic.bin",
          chunkIndex: 1,
        }))!,
      ),
    ).toEqual(Array.from(chunks[1]!));
    expect(
      await getRegistryWorktreeProvisionedChunk(env, {
        worktreeId: older.id,
        path: "synthetic.bin",
        chunkIndex: 2,
      }),
    ).toBeUndefined();
    expect(await getRegistryWorktreeProvisionedPaths(env, newer.id)).toEqual(["legacy.local"]);
    expect(await getRegistryWorktreeProvisionedState(env, newer.id)).toBeUndefined();
    expect(await getRegistryWorktreeProvisionedPaths(env, removed.id)).toBeUndefined();
    expect(await getRegistryWorktreeProvisionedState(env, removed.id)).toBeUndefined();
    await closeOpenClawStateDatabaseAsync();
    sql.expectIdle();
    await expect(fs.stat(path.join(stateDir, "unused-state"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const liveIds = readLiveRegistryWorktreeIds(env);
    env.OPENCLAW_STATE_DIR = path.join(stateDir, "unused-state");
    expect((await liveIds).toSorted()).toEqual([older.id, newer.id]);
    sql.expectIdle();

    env.OPENCLAW_STATE_DIR = stateDir;
    const context = captureOpenClawStateWorkerContext({ env });
    const owned = readLiveRegistryWorktreeByOwner(context, "session", older.ownerId!);
    env.OPENCLAW_STATE_DIR = path.join(stateDir, "unused-state");
    expect(await owned).toEqual(newer);
    expect(
      await readLiveRegistryWorktreeByOwner(context, "manual", older.ownerId!),
    ).toBeUndefined();
    sql.expectIdle();

    env.OPENCLAW_STATE_DIR = stateDir;
    await updateRegistryWorktree(env, older.id, { removedAt: 50 });
    await updateRegistryWorktree(env, removed.id, { removedAt: undefined });
    sql.clear();
    expect((await readLiveRegistryWorktreeIds(env)).toSorted()).toEqual([removed.id, newer.id]);
    sql.expectIdle();
  });
});
