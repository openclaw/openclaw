import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, symlinkSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import {
  createSqliteSourceFenceAdmission,
  type SqliteSourceFenceOwner,
} from "./sqlite-source-fence-admission.js";
import type { SqliteSourceFenceIdentity } from "./sqlite-source-fence-contract.js";
import {
  FENCE_FIXTURE_ENV,
  type FenceFixtureCommand,
  type FenceFixtureOperations,
} from "./sqlite-source-fence.test-support.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import type { SqliteWorkerStore } from "./sqlite-worker-contract.js";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";
import { observeSqliteWorkerCommittedFacts } from "./sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "./sqlite-worker-operation-settlement.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
const barriers = new Int32Array(new SharedArrayBuffer(128 * Int32Array.BYTES_PER_ELEMENT));
let nextBarrier = 0;
let first: DatabaseSync;
let second: DatabaseSync;
let firstIdentity: SqliteSourceFenceIdentity;
let secondIdentity: SqliteSourceFenceIdentity;
let aliasPath: string;
const brokers: SqliteWorkerBroker[] = [];
type Fixture = {
  broker: SqliteWorkerBroker;
  store: SqliteWorkerStore<FenceFixtureOperations>;
  destination: SqliteSourceFenceIdentity;
  source: SqliteSourceFenceIdentity;
};
let forward: Fixture;
let reverse: Fixture;
let previousEnvironment: ReturnType<typeof getEnvironmentData>;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

function initialize(filename: string): DatabaseSync {
  const db = openNodeSqliteDatabase(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 0;
    CREATE TABLE authority (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL);
    INSERT INTO authority VALUES (1, 1);
    CREATE TABLE requests (id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
    CREATE TABLE lifecycles (id TEXT PRIMARY KEY REFERENCES requests(id));
  `);
  return db;
}

async function openFixture(destination = secondIdentity, source = firstIdentity): Promise<Fixture> {
  const broker = new SqliteWorkerBroker();
  brokers.push(broker);
  const store = await broker.open<FenceFixtureOperations>({
    moduleUrl: new URL("./sqlite-source-fence.test-support.ts", import.meta.url),
    databasePath: destination.physical.canonicalPath,
    input: { destination, source, ...(source === firstIdentity ? { aliasPath } : {}) },
    existingOnly: true,
  });
  if (!store) {
    throw new Error("Fixture durable store was not opened");
  }
  return { broker, store, destination, source };
}

function createIdentity(filename: string): SqliteSourceFenceIdentity {
  return { physical: readDatabasePathIdentitySync(filename), incarnation: randomUUID() };
}

beforeAll(async () => {
  previousEnvironment = getEnvironmentData(FENCE_FIXTURE_ENV);
  setEnvironmentData(FENCE_FIXTURE_ENV, barriers.buffer);
  const root = dirs.make("sqlite-source-fence-");
  const firstPath = path.join(root, "first.sqlite");
  const secondPath = path.join(root, "second.sqlite");
  first = initialize(firstPath);
  second = initialize(secondPath);
  firstIdentity = createIdentity(firstPath);
  secondIdentity = createIdentity(secondPath);
  aliasPath = path.join(root, "first-alias.sqlite");
  symlinkSync(firstPath, aliasPath);
  forward = await openFixture();
  reverse = await openFixture(firstIdentity, secondIdentity);
});

afterAll(async () => {
  for (let index = 0; index < barriers.length; index += 4) {
    Atomics.store(barriers, index + 1, 1);
    Atomics.notify(barriers, index + 1);
  }
  await Promise.allSettled(brokers.map((broker) => broker.close()));
  first?.close();
  second?.close();
  setEnvironmentData(FENCE_FIXTURE_ENV, previousEnvironment);
});

function barrier() {
  const slot = nextBarrier++;
  return {
    slot,
    async reached(stage: number) {
      const offset = slot * 4;
      while (Atomics.load(barriers, offset) < stage) {
        const previous = Atomics.load(barriers, offset);
        await Atomics.waitAsync(barriers, offset, previous).value;
      }
    },
    release() {
      Atomics.store(barriers, slot * 4 + 1, 1);
      Atomics.notify(barriers, slot * 4 + 1);
    },
  };
}

async function pausedPersist(
  id: string,
  signal: AbortSignal,
  phase: "commit" | "validate" | "retry" = "commit",
) {
  const gate = barrier();
  const operation = persist(forward, {
    id,
    barrier: gate.slot,
    ...(phase === "retry" ? { observeRetry: true } : { pause: phase }),
  });
  cleanups.push(async () => {
    gate.release();
    await operation.result.catch(() => {});
  });
  const stage = { retry: 3, commit: 2, validate: 1 }[phase];
  await withinTest(
    awaitGateBeforeSettlement(gate.reached(stage), operation.result, `${phase} gate not reached`),
    signal,
  );
  return { ...operation, release: () => gate.release() };
}

function owner(identity: SqliteSourceFenceIdentity) {
  const controller = new AbortController();
  const retained: Array<{ settled: boolean }> = [];
  const value: SqliteSourceFenceOwner = {
    identity,
    signal: controller.signal,
    assertCurrent: () => controller.signal.throwIfAborted(),
    retain(operation) {
      const custody = { settled: false };
      retained.push(custody);
      void operation.settled.then(() => {
        custody.settled = true;
      });
    },
  };
  return { controller, value, retained };
}

function persist(
  fixture: Fixture,
  input: Omit<FenceFixtureCommand, "expectedRevision"> & { expectedRevision?: number },
  options: { deadlineNs?: bigint; source?: ReturnType<typeof owner> } = {},
) {
  const command = { expectedRevision: 1, ...input };
  const controller = new AbortController();
  const source = options.source ?? owner(command.sameStore ? fixture.destination : fixture.source);
  const destination = owner(fixture.destination);
  const receipts: unknown[] = [];
  const settlements: Promise<SqliteWorkerOperationSettlement>[] = [];
  const factory = createSqliteSourceFenceAdmission({
    destination: destination.value,
    sources: [source.value, ...(command.alias ? [source.value] : [])],
    signal: controller.signal,
    deadlineNs: options.deadlineNs ?? process.hrtime.bigint() + 30_000_000_000n,
  });
  const result = fixture.broker.runOperation(
    fixture.store,
    (scope) => scope.execute({ type: "persist", input: command }, { signal: controller.signal }),
    undefined,
    undefined,
    (operation) => {
      settlements.push(operation.settled);
      const admission = factory(operation);
      observeSqliteWorkerCommittedFacts(admission.admission, (receipt) =>
        receipts.push(receipt.facts),
      );
      return admission;
    },
  );
  // Rejections are asserted after the deterministic gate, without an unhandled interval.
  void result.catch(() => {});
  return { result, receipts, settlements, controller, source, destination };
}

function rows(database: DatabaseSync, id: string) {
  return {
    request: database.prepare("SELECT revision FROM requests WHERE id = ?").get(id),
    lifecycle: database.prepare("SELECT id FROM lifecycles WHERE id = ?").get(id),
  };
}

const fact = (id: string) => ({ id, revision: 1 });

function assertRows(database: DatabaseSync, id: string, committed = false) {
  expect(rows(database, id)).toEqual({
    request: committed ? { revision: 1 } : undefined,
    lifecycle: committed ? { id } : undefined,
  });
}

it("settles accepted commits while MAIN waits on the source lock", async ({ signal }) => {
  const operation = await pausedPersist("native-waiter", signal);
  cleanups.push(() =>
    first.exec("PRAGMA busy_timeout = 0; UPDATE authority SET revision = 1 WHERE id = 1"),
  );
  expect(() => first.exec("BEGIN IMMEDIATE")).toThrow(/locked|busy/i);
  assertRows(second, "native-waiter");
  first.exec("PRAGMA busy_timeout = 10000");
  operation.release();
  // This native call cannot service host-message admission.
  first.exec("BEGIN IMMEDIATE; UPDATE authority SET revision = 2 WHERE id = 1; COMMIT");
  expect(await operation.result).toEqual(fact("native-waiter"));
  assertRows(second, "native-waiter", true);
  expect(operation.receipts).toEqual([fact("native-waiter")]);
});

it("excludes an independent process until destination settlement", async ({ signal }) => {
  const operation = await pausedPersist("foreign-writer", signal);
  cleanups.push(() => first.exec("UPDATE authority SET revision = 1 WHERE id = 1"));
  const write = () =>
    spawnSync(
      process.execPath,
      [
        "-e",
        `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      try { db.exec('BEGIN IMMEDIATE; UPDATE authority SET revision = 2 WHERE id = 1; COMMIT'); }
      catch (error) { process.stdout.write(String(error.message)); process.exitCode = 7; }
      finally { db.close(); }
    `,
        firstIdentity.physical.canonicalPath,
      ],
      { encoding: "utf8" },
    );

  const blocked = write();
  expect(blocked).toMatchObject({ status: 7, stdout: expect.stringMatching(/locked|busy/i) });
  operation.release();
  await operation.result;
  expect(write().status).toBe(0);
  expect(rows(second, "foreign-writer").request).toEqual({ revision: 1 });
});

it("collapses aliases and permits reverse-direction progress", async ({ signal }) => {
  for (const command of [
    { id: "alias", alias: true },
    { id: "same-store", sameStore: true },
  ]) {
    await expect(persist(forward, command).result).resolves.toEqual(fact(command.id));
  }
  const left = await pausedPersist("forward", signal, "validate");
  const right = persist(reverse, { id: "reverse" });
  cleanups.push(async () => {
    await Promise.allSettled([right.result]);
  });
  left.release();
  await expect(Promise.all([left.result, right.result])).resolves.toEqual([
    fact("forward"),
    fact("reverse"),
  ]);
});

it("releases earlier empty reservations when a later physical lock is busy", async ({ signal }) => {
  const [lower, higher] =
    firstIdentity.physical.key < secondIdentity.physical.key ? [first, second] : [second, first];
  higher.exec("BEGIN IMMEDIATE");
  // Release this lock before draining the paused producer on failure.
  cleanups.push(() => {
    if (higher.isTransaction) {
      higher.exec("ROLLBACK");
    }
  });
  const operation = await pausedPersist("all-or-release", signal, "retry");
  expect(() => lower.exec("BEGIN IMMEDIATE; ROLLBACK")).not.toThrow();
  higher.exec("ROLLBACK");
  operation.release();
  await expect(operation.result).resolves.toEqual(fact("all-or-release"));
});

it.for(["caller", "source", "destination"] as const)(
  "refuses %s revocation before acceptance and rolls back both destination rows",
  async (kind, { signal }) => {
    const id = `revoked-${kind}`;
    const operation = await pausedPersist(id, signal, "validate");
    const controller = kind === "caller" ? operation.controller : operation[kind].controller;
    controller.abort(new Error("Fixture owner closed"));
    operation.release();
    await expect(operation.result).rejects.toThrow();
    assertRows(second, id);
    expect(operation.receipts).toEqual([]);
  },
);

it("retains accepted commit custody after cancellation", async ({ signal }) => {
  const operation = await pausedPersist("accepted-cancel", signal);
  operation.controller.abort(new Error("Fixture caller canceled"));
  operation.source.controller.abort(new Error("Fixture source closed"));
  operation.destination.controller.abort(new Error("Fixture destination closed"));
  const retained = [operation.source.retained, operation.destination.retained];
  expect(retained).toEqual([[{ settled: false }], [{ settled: false }]]);
  operation.release();
  await operation.result.catch(() => {});
  assertRows(second, "accepted-cancel", true);
  expect(operation.receipts).toEqual([fact("accepted-cancel")]);
  expect(await Promise.all(operation.settlements)).toEqual([{ kind: "completed" }]);
  expect(retained).toEqual([[{ settled: true }], [{ settled: true }]]);
});

it.each([
  ["stale", { expectedRevision: 2 }, {}],
  ["expired", {}, { deadlineNs: 0n }],
  ["kernel", { fault: "kernel" }, {}],
  ["missing-receipt", { fault: "missing-receipt" }, {}],
  ["host-admission", { fault: "host-admission" }, {}],
  ["native-source-close", { fault: "source-close" }, {}],
] as const)("refuses %s without partial destination rows", async (id, command, options) => {
  const fixture = id === "native-source-close" ? await openFixture() : forward;
  const operation = persist(fixture, { id, ...command }, options);
  await expect(operation.result).rejects.toThrow(
    id === "native-source-close" ? /closed/ : undefined,
  );
  assertRows(second, id);
  expect(operation.receipts).toEqual([]);
  if (fixture !== forward) {
    await fixture.broker.close();
  }
});

it("refuses absent rows, captured-incarnation mismatch, and missing durable files", async () => {
  first.exec("DELETE FROM authority WHERE id = 1");
  try {
    await expect(persist(forward, { id: "absent" }).result).rejects.toThrow(/revoked/);
    assertRows(second, "absent");
  } finally {
    first.exec("INSERT INTO authority VALUES (1, 1)");
  }
  const changed = owner({ ...firstIdentity, incarnation: randomUUID() });
  await expect(persist(forward, { id: "incarnation" }, { source: changed }).result).rejects.toThrow(
    /owners/,
  );
  assertRows(second, "incarnation");
  const missingPath = path.join(path.dirname(aliasPath), "missing.sqlite");
  await expect(
    openFixture(secondIdentity, {
      ...firstIdentity,
      physical: { ...firstIdentity.physical, canonicalPath: missingPath },
    }),
  ).rejects.toThrow();
  expect(existsSync(missingPath)).toBe(false);
});

it.each(["reply", "source-rollback"] as const)(
  "preserves the committed receipt despite %s",
  async (fault) => {
    const [fixture, database, id] =
      fault === "reply"
        ? ([forward, second, "lost-reply"] as const)
        : ([reverse, first, "cleanup-failure"] as const);
    const operation = persist(fixture, { id, fault });
    await expect(operation.result).rejects.toThrow();
    expect(operation.receipts).toEqual([fact(id)]);
    assertRows(database, id, true);
    expect(await Promise.all(operation.settlements)).toEqual([{ kind: "completed" }]);
  },
);

it("preserves a source revocation acknowledged by a destination postcommit observer", async () => {
  const operation = persist(forward, { id: "postcommit-revoke", fault: "postcommit-revoke" });
  cleanups.push(async () => {
    await operation.result.catch(() => {});
    first.exec("UPDATE authority SET revision = 1 WHERE id = 1");
  });
  await expect(operation.result).resolves.toEqual({
    ...fact("postcommit-revoke"),
    notifiedRevision: 2,
  });
  expect(first.prepare("SELECT revision FROM authority WHERE id = 1").get()).toEqual({
    revision: 2,
  });
  assertRows(second, "postcommit-revoke", true);
});

it.each(["before-commit-exit", "after-commit-exit"] as const)(
  "joins native loss %s without replay or a leaked source lock",
  async (fault) => {
    const fixture = await openFixture();
    const operation = persist(fixture, { id: fault, fault });
    await expect(operation.result).rejects.toThrow();
    assertRows(second, fault, fault === "after-commit-exit");
    expect(() => first.exec("BEGIN IMMEDIATE; ROLLBACK")).not.toThrow();
    expect(await Promise.all(operation.settlements)).toEqual([
      expect.objectContaining({ kind: "unknown", nativeStopped: true }),
    ]);
    await fixture.broker.close();
  },
);
