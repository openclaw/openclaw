import fs from "node:fs/promises";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { WORKTREE_MUTATION_LEASE_SCOPE } from "./capacity-contract.js";
import { lockState } from "./git-lock.js";
import * as worktreeGit from "./git.js";
import { insertRegistryWorktreeProvisionedChunk } from "./provisioned-snapshot.test-support.js";
import {
  getRegistryWorktreeProvisionedChunk,
  readLiveRegistryWorktreeByOwner,
  readLiveRegistryWorktreeIds,
  readRegistryWorktree,
  readRegistryWorktrees,
  readSessionWorktreeBinding,
} from "./registry-read.js";
import {
  getRegistryWorktreeProvisionedPaths,
  getRegistryWorktreeProvisionedState,
  insertRegistryWorktree,
  updateRegistryWorktree,
} from "./registry.js";
import { getRegistryWorktree, listRegistryWorktrees } from "./registry.test-support.js";
import { resolveWorktreeForPath } from "./run-lease.js";
import { ManagedWorktreeService } from "./service.js";
import { makeWorktreeRecord, useManagedWorktreeTestRepository } from "./service.test-support.js";
import { useWorktreeStateRoots } from "./state-fixture.test-support.js";
import type { ManagedWorktreeRecord } from "./types.js";
import { interceptWorktreeWorkerOperation } from "./worker-operation.test-support.js";

const writerGate = vi.hoisted(() => ({ buffer: undefined as SharedArrayBuffer | undefined }));
vi.mock("../../infra/worker-cpu.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/worker-cpu.js")>();
  const preload = `
      import { DatabaseSync } from 'node:sqlite';
      import { workerData } from 'node:worker_threads';
      const prepare = DatabaseSync.prototype.prepare;
      DatabaseSync.prototype.prepare = function(sql) {
        const statement = prepare.call(this, sql);
        if (workerData.testWorktreeWriteGate && /^update "worktrees" /i.test(sql.trim())) {
          for (const method of ["all", "get", "iterate", "run"]) {
            const execute = statement[method].bind(statement);
            statement[method] = (...args) => {
              const gate = new Int32Array(workerData.testWorktreeWriteGate);
              if (Atomics.load(gate, 0) === 1) {
                Atomics.store(gate, 1, 1);
                Atomics.notify(gate, 1);
                while (Atomics.load(gate, 0) === 1) Atomics.wait(gate, 0, 1);
              }
              return execute(...args);
            };
          }
        }
        return statement;
      };
    `;
  return {
    ...actual,
    createCpuTrackedWorker(
      filename: string | URL,
      options: ConstructorParameters<typeof Worker>[1],
    ) {
      return actual.createCpuTrackedWorker(filename, {
        ...options,
        execArgv: [
          ...(options?.execArgv ?? []),
          "--import",
          `data:text/javascript,${encodeURIComponent(preload)}`,
        ],
        workerData: { ...options?.workerData, testWorktreeWriteGate: writerGate.buffer },
      });
    },
  };
});

const tempDirs = useWorktreeStateRoots(() => {
  writerGate.buffer = undefined;
});
const initializeRepository = useManagedWorktreeTestRepository();
function recordFixture(
  root: string,
  id: string,
  overrides: Partial<ManagedWorktreeRecord> = {},
): ManagedWorktreeRecord {
  return makeWorktreeRecord(path.join(root, "repo"), id, {
    branch: `openclaw/${id}`,
    ownerKind: "manual",
    ...overrides,
    id,
    name: id,
    path: path.join(root, id),
  });
}
function expectRecent(value: number | undefined, since: number) {
  expect(value).toBeGreaterThanOrEqual(since);
  expect(value).toBeLessThanOrEqual(Date.now());
}

async function serviceFixture() {
  const root = tempDirs.make("worktree-registry-publication-");
  const repoRoot = await initializeRepository(root);
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  const service = new ManagedWorktreeService({
    env,
    getConfig: () => ({ worktreeAcceleration: false }),
  });
  const params = {
    repoRoot,
    name: "publication",
    baseRef: "HEAD",
    ownerKind: "session" as const,
    ownerId: "registry-owner",
  };
  return { env, service, params };
}

function holdPublication(type: "worktrees.insert" | "worktrees.update", afterCommit = false) {
  const entered = createDeferred();
  const release = createDeferred();
  let writes = 0;
  const transport = interceptWorktreeWorkerOperation(
    (execute) => async (command, executeOptions) => {
      if (command.type !== type) {
        return execute(command, executeOptions);
      }
      writes += 1;
      if (afterCommit) {
        await execute(command, executeOptions);
      }
      entered.resolve();
      await release.promise;
      if (afterCommit) {
        throw new Error("Synthetic lost registry reply after native commit");
      }
      return execute(command, executeOptions);
    },
  );
  return {
    entered: entered.promise,
    release: () => release.resolve(),
    writes: () => writes,
    restore: () => transport.mockRestore(),
  };
}

async function withPublication(
  existing: ManagedWorktreeRecord | undefined,
  service: ManagedWorktreeService,
  pending: Promise<ManagedWorktreeRecord>,
  publication: ReturnType<typeof holdPublication>,
  verify: () => Promise<void>,
) {
  try {
    await awaitGateBeforeSettlement(
      publication.entered,
      pending,
      "Registry publication never queued",
    );
    await verify();
  } finally {
    publication.release();
    await pending.catch(() => {});
    publication.restore();
    if (existing) {
      await service.release(existing.id);
    }
  }
}

it("serves committed worktree rows while a background write is blocked", async ({ signal }) => {
  const root = tempDirs.make("worktree-reader-writer-isolation-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  const gate = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
  writerGate.buffer = gate.buffer;
  const record = recordFixture(root, "independent-read", {
    ownerKind: "session",
    ownerId: "agent:main:reader",
  });
  await insertRegistryWorktree(env, record);
  const context = captureOpenClawStateWorkerContext({ env });
  Atomics.store(gate, 0, 1);
  const write = updateRegistryWorktree(env, record.id, { lastActiveAt: 2 });
  void write.catch(() => {});
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        Promise.resolve(Atomics.waitAsync(gate, 1, 0).value),
        write,
        "Writer never reached SQL",
      ),
      signal,
    );
    for (const read of [
      () => readRegistryWorktree(context, record.id),
      () => readLiveRegistryWorktreeByOwner(context, "session", record.ownerId!),
    ]) {
      expect(await withinTest(read(), signal)).toEqual(record);
    }
    expect(await withinTest(readRegistryWorktrees(env), signal)).toEqual([record]);
  } finally {
    Atomics.store(gate, 0, 0);
    Atomics.notify(gate, 0);
    await write;
  }
  expect(await readRegistryWorktree(context, record.id)).toEqual({ ...record, lastActiveAt: 2 });
});

it("retains the original store across missing-checkout retirement", async () => {
  const originalRoot = tempDirs.make("worktree-original-store-");
  const replacementRoot = tempDirs.make("worktree-replacement-store-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: originalRoot };
  const replacementEnv = { ...env, OPENCLAW_STATE_DIR: replacementRoot };
  const record = recordFixture(originalRoot, "shared-backup-row");
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
  const { env, service, params } = await serviceFixture();
  const started = Date.now();
  const created = await service.create({
    repoRoot: params.repoRoot,
    name: "read-only-list",
    baseRef: "HEAD",
  });
  await fs.rm(created.path, { recursive: true, force: true });
  expect(await service.listRegistryRecords()).toEqual([created]);
  expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
  expect(await service.list()).toEqual([]);
  expectRecent(getRegistryWorktree(env, created.id)?.removedAt, started);
});

it("creates, resolves, lists, and publishes activity without caller-thread registry SQL", async () => {
  const { env, service, params } = await serviceFixture();
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
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
    for (const selection of [
      { sessionEntry: { worktree: { id: record.id } }, candidatePaths: [] },
      { candidatePaths: [path.join(record.path, "README.md")] },
    ]) {
      expect((await resolveWorktreeForPath(selection))?.record).toEqual(record);
    }
    expect(await service.list()).toEqual([record]);
    expect(registryQueries()).toEqual([]);
    await updateRegistryWorktree(env, record.id, { lastActiveAt: Date.now() - 60_000 });
    sql.queries.length = 0;
    const activityStarted = Date.now();
    const acquired = await service.acquire(record.id);
    expect(acquired.id).toBe(record.id);
    expectRecent(acquired.lastActiveAt, activityStarted);
    expect(
      await readRegistryWorktree(captureOpenClawStateWorkerContext({ env }), record.id),
    ).toEqual(acquired);
    await service.release(record.id);
    expect(registryQueries()).toEqual([]);
  } finally {
    sql.restore();
  }
});

it.each(["create", "activity"] as const)(
  "awaits %s acknowledgement and never replays its committed lost reply",
  async (kind) => {
    const { env, service, params } = await serviceFixture();
    const existing = kind === "activity" ? await service.create(params) : undefined;
    if (existing) {
      await updateRegistryWorktree(env, existing.id, { lastActiveAt: Date.now() - 60_000 });
    }
    const publicationStarted = Date.now();
    const publication = holdPublication(existing ? "worktrees.update" : "worktrees.insert", true);
    let settled = false;
    const pending = (existing ? service.acquire(existing.id) : service.create(params)).finally(
      () => {
        settled = true;
      },
    );
    await withPublication(existing, service, pending, publication, async () => {
      expect(settled).toBe(false);
      const published = listRegistryWorktrees(env)[0]!;
      expectRecent(published.lastActiveAt, publicationStarted);
      publication.release();
      expect(await pending).toEqual(published);
      expect(publication.writes()).toBe(1);
      expect(await service.listRegistryRecords()).toHaveLength(1);
    });
  },
);

it.each(["replacement", "retained lock", "checkout lease", "caller"] as const)(
  "preserves registry and checkout on refused publication (%s)",
  async (kind) => {
    const { env, service, params } = await serviceFixture();
    let existing =
      kind === "replacement" || kind === "retained lock" ? await service.create(params) : undefined;
    if (existing && kind === "retained lock") {
      existing = await service.acquire(existing.id);
    }
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
    await withPublication(existing, service, pending, publication, async () => {
      const { db } = openOpenClawStateDatabase({ env });
      if (existing) {
        db.prepare("UPDATE worktrees SET branch = ? WHERE id = ?").run(
          "replacement-branch",
          existing.id,
        );
      } else if (kind === "checkout lease") {
        db.prepare("UPDATE state_leases SET owner = ? WHERE scope = ?").run(
          "replacement-owner",
          WORKTREE_MUTATION_LEASE_SCOPE,
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
    });
  },
);

it("reads captured registry records and provisioned snapshots without host SQL or checkout reconciliation", async () => {
  const stateDir = tempDirs.make("worktree-registry-worker-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const service = new ManagedWorktreeService({ env });
  const snapshot = (id: string) =>
    Promise.all([
      getRegistryWorktreeProvisionedPaths(env, id),
      getRegistryWorktreeProvisionedState(env, id),
    ]);
  const chunk = (worktreeId: string, chunkIndex: number) =>
    getRegistryWorktreeProvisionedChunk(env, { worktreeId, path: "synthetic.bin", chunkIndex });
  requireNodeSqlite();
  const sql = observeMainThreadSql();
  sql.calibrate();
  const unusedState = path.join(stateDir, "unused-state");
  async function expectCaptured(pending: Promise<unknown>, expected: unknown, mutate = () => {}) {
    mutate();
    env.OPENCLAW_STATE_DIR = unusedState;
    expect(await pending).toEqual(expected);
    sql.expectIdle();
    env.OPENCLAW_STATE_DIR = stateDir;
  }

  expect(await snapshot("missing")).toEqual([undefined, undefined]);
  expect(await chunk("missing", 0)).toBeUndefined();
  expect(await service.listRegistryRecords()).toEqual([]);
  expect(await readLiveRegistryWorktreeIds(env)).toEqual([]);
  await expect(fs.stat(path.join(stateDir, "state", "openclaw.sqlite"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  sql.expectIdle();

  const older = recordFixture(stateDir, "older", {
    ownerKind: "session",
    ownerId: "agent:main:task",
    createdAt: 10,
    lastActiveAt: 30,
    runEndCleanup: { outcome: "retained-dirty", at: 30 },
  });
  const removed = recordFixture(stateDir, "a-removed", {
    ...older,
    createdAt: 20,
    removedAt: 40,
    snapshotRef: "refs/openclaw/snapshots/a-removed",
    runEndCleanup: { outcome: "removed-lossless", at: 40 },
  });
  const newer = recordFixture(stateDir, "z-newer", {
    ...older,
    createdAt: 20,
    runEndCleanup: { outcome: "failed", at: 30, reason: "synthetic cleanup failure" },
  });
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

  await expectCaptured(service.listRegistryRecords(), [removed, newer, older]);
  await closeOpenClawStateDatabaseAsync();
  sql.expectIdle();
  const listOptions = { liveOnly: true };
  await expectCaptured(readRegistryWorktrees(env, listOptions), [newer, older], () => {
    listOptions.liveOnly = false;
  });
  await expectCaptured(snapshot(older.id), [["synthetic.bin"], provisionedState]);
  const selectedChunk = { worktreeId: older.id, path: "synthetic.bin", chunkIndex: 0 };
  await expectCaptured(
    getRegistryWorktreeProvisionedChunk(env, selectedChunk).then((data) => Array.from(data!)),
    Array.from(chunks[0]!),
    () => {
      selectedChunk.path = "different.bin";
      selectedChunk.chunkIndex = 1;
    },
  );
  expect(Array.from((await chunk(older.id, 1))!)).toEqual(Array.from(chunks[1]!));
  expect(await chunk(older.id, 2)).toBeUndefined();
  expect(await snapshot(newer.id)).toEqual([["legacy.local"], undefined]);
  expect(await snapshot(removed.id)).toEqual([undefined, undefined]);
  await closeOpenClawStateDatabaseAsync();
  sql.expectIdle();
  await expect(fs.stat(unusedState)).rejects.toMatchObject({ code: "ENOENT" });
  await expectCaptured(
    readLiveRegistryWorktreeIds(env).then((ids) => ids.toSorted()),
    [older.id, newer.id],
  );
  const context = captureOpenClawStateWorkerContext({ env });
  await expectCaptured(readLiveRegistryWorktreeByOwner(context, "session", older.ownerId!), newer);
  env.OPENCLAW_STATE_DIR = unusedState;
  expect(await readLiveRegistryWorktreeByOwner(context, "manual", older.ownerId!)).toBeUndefined();
  for (const [boundId, expected] of [
    [older.id, older],
    [removed.id, newer],
    ["missing", newer],
    [undefined, newer],
  ] as const) {
    expect(await readSessionWorktreeBinding(context, boundId, older.ownerId!)).toEqual(expected);
  }
  sql.expectIdle();

  env.OPENCLAW_STATE_DIR = stateDir;
  await updateRegistryWorktree(env, older.id, { removedAt: 50 });
  await updateRegistryWorktree(env, removed.id, { removedAt: undefined });
  sql.clear();
  expect((await readLiveRegistryWorktreeIds(env)).toSorted()).toEqual([removed.id, newer.id]);
  sql.expectIdle();
});
