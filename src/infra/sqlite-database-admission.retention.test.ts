import { once } from "node:events";
import { fstatSync, renameSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getEnvironmentData, MessageChannel, type MessagePort, Worker } from "node:worker_threads";
import type { WorkerLifecycle } from "@openclaw/worker-runtime/lifecycle";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEngineStoreAdmission } from "./database-engine/admission-scope.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { PostgresSyncConnection } from "./postgres-sync/connection.js";
import { runPostgresTransactionSync } from "./postgres-sync/transaction.js";
import type { RuntimeWorkerGeneration } from "./runtime-worker-generation.js";
import type { PostgresSqlConnection } from "./sql-connection.js";
import { SQLITE_DATABASE_ADMISSIONS_KEY } from "./sqlite-database-admission-key.js";
import {
  readSqliteDatabaseAdmissionFact as readFact,
  SqliteDatabaseAdmissionRegistry,
} from "./sqlite-database-admission-record.js";
import {
  beginSqliteDatabaseAdmissionOperation as beginOperation,
  discardSqliteDatabaseTransactionAdmissions as discardFacts,
  getSqliteDatabaseAdmission as getFact,
  getOrLoadSqliteDatabaseAdmissionForPath as loadFact,
  hasPendingSqliteDatabaseSchemaMutation as schemaDirty,
  invalidateLocalSqliteSchemaAdmissions as invalidateSchema,
  publishSqliteDatabaseAdmission as publishFact,
  publishSqliteDatabaseSchemaChange as publishSchema,
  suspendSqliteDatabaseAdmission as suspendAdmission,
  captureSqliteDatabaseAdmissions as captureAdmissions,
  installSqliteDatabaseAdmissions as installAdmissions,
  readSqliteDatabaseAdmissions as readAdmissions,
  readSqliteDatabasePendingWriteToken as pendingToken,
  readSqliteDatabaseScopedWriteToken as scopedToken,
  readSqliteDatabaseScopedWriteTokensForPath as pathScopedTokens,
  readSqliteDatabasePendingScopedWriteToken as pendingScopedToken,
  retainSqliteDatabaseWriteScopesForPath as retainScopes,
  retireSqliteDatabaseWriteScopes as retireScopes,
  prepareSqliteDatabaseCleanClose as prepareCleanClose,
  recordSqliteDatabaseIntegrity as recordIntegrity,
  readSqliteDatabaseWriteTokenForPath as pathToken,
  retireSqliteDatabaseAdmissionForPath as retireAdmission,
  retainSqliteDatabaseAdmissionLocation as retainLocation,
  revokeSqliteDatabaseAdmissions as revokeAdmissions,
  revokeSqliteDatabaseAdmissionsForPath as revokePath,
  trackSqliteDatabaseAdmissionWorker as trackWorker,
  withSqliteDatabaseAdmissionExchange as withExchange,
  withSqliteDatabaseWriteScope,
} from "./sqlite-database-admission.js";
import { withSqlitePreparedNativeMutation } from "./sqlite-native-observer.js";
import {
  stageSqliteTransactionState,
  withSqlitePostCommitPublications as postCommit,
} from "./sqlite-post-commit.js";
import {
  admitSqliteSchema,
  getAdmittedSqliteSchemaFacts as schemaFacts,
} from "./sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync as transaction } from "./sqlite-transaction.js";
import { createSqliteDatabaseAdmissionRelay } from "./sqlite-worker-operation-admission.js";
import {
  captureRetainedNativeWorkerSource,
  createRetainedNativeWorker,
} from "./worker-native-lifecycle.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createDatabase(location: string) {
  const database = openNodeSqliteDatabase(location);
  database.exec("CREATE TABLE proof(value INTEGER); INSERT INTO proof VALUES(42)");
  admitSqliteSchema(database);
  return database;
}

function databaseFixture(prefix: string) {
  const location = path.join(tempDirs.make(prefix), "proof.sqlite");
  const database = createDatabase(location);
  return {
    database,
    location,
    [Symbol.dispose]() {
      if (database.isOpen) {
        database.close();
      }
      retireAdmission(location);
    },
  };
}

function admissionWorker(body: string) {
  return `const { parentPort, workerData } = require("node:worker_threads");
     (async () => {
       const { register } = await import(workerData.loader);
       register();
       const { openNodeSqliteDatabase } = await import(workerData.native);
       const { withSqliteDatabaseAdmissionExchange, readSqliteDatabaseScopedWriteToken,
         retireSqliteDatabaseAdmissionForPath } = await import(workerData.admission);
       const { exchangeSqliteDatabaseAdmissions } = await import(workerData.relay);
       const exchange = (callback) => withSqliteDatabaseAdmissionExchange(
         (records, location, create) =>
           exchangeSqliteDatabaseAdmissions(workerData.port, records, location, create),
         callback,
       );
${body}
     })().catch((error) => { throw error; });`;
}

function workerOptions(location: string, port: MessagePort, extra: Record<string, unknown> = {}) {
  return {
    eval: true,
    execArgv: [],
    workerData: {
      location,
      port,
      loader: import.meta.resolve("tsx/esm/api"),
      native: new URL("./node-sqlite.ts", import.meta.url).href,
      admission: new URL("./sqlite-database-admission.ts", import.meta.url).href,
      schema: new URL("./sqlite-schema-facts.ts", import.meta.url).href,
      relay: new URL("./sqlite-worker-database-admission-relay.ts", import.meta.url).href,
      transaction: new URL("./sqlite-transaction.ts", import.meta.url).href,
      ...extra,
    },
    transferList: [port],
  };
}

function recordsFor(location: string) {
  return captureAdmissions().filter((record) => record.location === location);
}

it("worker release leaves unrelated receipt scopes unvisited", () => {
  using affected = databaseFixture("sqlite-release-affected-");
  using unrelated = databaseFixture("sqlite-release-unrelated-");
  scopedToken(affected.database, "affected-session");
  scopedToken(unrelated.database, "unrelated-session");
  const registry = new SqliteDatabaseAdmissionRegistry();
  registry.install([...recordsFor(affected.location), ...recordsFor(unrelated.location)]);
  const record = registry.forLocation(affected.location)!;
  const sibling = registry.forLocation(unrelated.location)!;
  const owner = 123456;
  const references = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
  Atomics.store(new Int32Array(references), 0, 1);
  record.references.set(owner, references);
  registry.publish(record);
  const stale = structuredClone(registry.capture());
  const visits = vi.spyOn(sibling.writeScopes, "forEach");
  try {
    registry.releaseWorker(owner + 1);
    registry.releaseWorker(owner);
    expect(visits).not.toHaveBeenCalled();
    expect(Atomics.load(new Int32Array(references), 0)).toBe(-1);
    expect(record.references.has(owner)).toBe(false);
    registry.install(stale);
    expect(record.references.has(owner)).toBe(false);
    expect(registry.forLocation(affected.location)).toBe(record);
    expect(registry.forLocation(unrelated.location)).toBe(sibling);
  } finally {
    visits.mockRestore();
  }
});

it("keeps cold pinned receipts current across physical-fact reads until release", () => {
  using fixture = databaseFixture("sqlite-admission-cold-pins-");
  const { database, location } = fixture;
  database.close();
  const release = retainScopes(location, ["held"])!;
  try {
    const before = pathScopedTokens(location, ["held"]);
    expect(before?.[0]).toBeTypeOf("string");
    expect(
      loadFact(
        location,
        { ...key, name: "test.cold-pinned-fact", lifetime: "process" },
        () => "loaded",
      ),
    ).toBe("loaded");
    expect(pathScopedTokens(location, ["held"])).toEqual(before);
    release();
    expect(recordsFor(location)).toEqual([]);
  } finally {
    release();
  }
});

it("retains active source receipts until their last release without suppressing invalidation", () => {
  using fixture = databaseFixture("sqlite-admission-pinned-scopes-");
  const { database, location } = fixture;
  const key = "x".repeat(600_000);
  const release = retainScopes(location, [key])!;
  const releaseSibling = retainScopes(location, [key])!;
  try {
    const before = scopedToken(database, key);
    for (let index = 0; index < 160; index++) {
      scopedToken(database, `${index}:${"y".repeat(4096)}`);
    }
    expect(scopedToken(database, key)).toBe(before);
    release();
    release();
    expect(scopedToken(database, key)).toBe(before);
    database.prepare("UPDATE proof SET value = 43").run();
    const committed = scopedToken(database, key);
    expect(committed).not.toBe(before);
    releaseSibling();
    expect(recordsFor(location)[0]!.writeScopes.size).toBe(0);
    const releaseDeleted = retainScopes(location, ["deleted"])!;
    try {
      retireScopes(database, ["deleted"]);
      expect(recordsFor(location)[0]!.writeScopes.size).toBe(0);
    } finally {
      releaseDeleted();
    }
  } finally {
    release();
    releaseSibling();
    expect(recordsFor(location)[0]!.writeScopes.size).toBe(0);
  }
});

it("bounds cold session receipts by bytes without evicting hot receipts or reviving stale ones", () => {
  using fixture = databaseFixture("sqlite-admission-scope-budget-");
  const { location, database } = fixture;

  const cold = scopedToken(database, "cold");
  const hot = scopedToken(database, "hot");
  const stale = structuredClone(recordsFor(location));
  const scopes = Array.from({ length: 160 }, (_, index) => `${index}:${"x".repeat(4096)}`);
  for (const key of scopes) {
    expect(scopedToken(database, key)).toBeTypeOf("string");
    expect(scopedToken(database, "hot")).toBe(hot);
  }
  const retained = () => recordsFor(location)[0]!.writeScopes;
  expect([...retained().keys()].reduce((bytes, key) => bytes + key.length * 2, 0)).toBeLessThan(
    1024 * 1024,
  );
  expect(retained().has('["key","cold"]')).toBe(false);
  installAdmissions(stale);
  expect(retained().has('["key","cold"]')).toBe(false);
  expect(scopedToken(database, "cold")).not.toBe(cold);
  expect(pathScopedTokens(location, scopes)).toHaveLength(scopes.length);
  const oversized = "x".repeat(600_000);
  const before = scopedToken(database, oversized);
  expect(before).toBeTypeOf("string");
  let pending: string | undefined;
  postCommit(database, () =>
    transaction(database, () => {
      database.prepare("UPDATE proof SET value = 43").run();
      pending = pendingScopedToken(database, oversized);
    }),
  );
  expect(pending).toBeTypeOf("string");
  expect(pending).not.toBe(before);
  expect(scopedToken(database, oversized)).toBe(pending);
  expect(database.prepare("SELECT value FROM proof").get()).toEqual({ value: 43 });
  database.close();
  expect(recordsFor(location)).toEqual([]);
});

it("retires the final closed handle's facts while preserving open siblings and descriptor custody", () => {
  using fixture = databaseFixture("sqlite-admission-retention-");
  const { database: first, location } = fixture;
  using second = openNodeSqliteDatabase(location);
  admitSqliteSchema(second);
  const original = recordsFor(location)[0]!;
  const stale = structuredClone([original]);
  publishFact(first, key, "connection-scoped");
  first.close();
  expect(recordsFor(location)).toHaveLength(1);
  expect(schemaFacts(second)?.tables.has("proof")).toBe(true);
  const admittedSchema = schemaFacts(second);
  recordIntegrity(second);
  {
    using seal = prepareCleanClose(second);
    second.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    second.close();
    expect(recordsFor(location)).toHaveLength(1);
    expect(seal.publish()).toBe(true);
  }
  expect(recordsFor(location)).toEqual([]);
  expect(fstatSync(original.descriptor).isFile()).toBe(true);

  installAdmissions(stale);
  expect(recordsFor(location)).toEqual([]);

  using reopened = openNodeSqliteDatabase(location);
  expect(schemaFacts(reopened)?.admissionId).toBe(admittedSchema?.admissionId);
  expect(getFact(reopened, key)).toBeUndefined();
  expect(reopened.prepare("SELECT value FROM proof").get()).toEqual({ value: 42 });
  expect(schemaFacts(reopened)?.tables.has("proof")).toBe(true);
  const readmitted = recordsFor(location)[0]!;
  expect(readmitted.generationId).not.toBe(original.generationId);
  expect(readmitted.descriptor).toBe(original.descriptor);
  reopened.close();
  expect(recordsFor(location)).toEqual([]);
  retireAdmission(location);
  expect(() => fstatSync(original.descriptor)).toThrow();
});

it.each([undefined, "process"] as const)(
  "preserves path-load lifetime when the loader closes its handle (%s)",
  (lifetime) => {
    using fixture = databaseFixture("sqlite-admission-loader-close-");
    const { location, database } = fixture;
    const loadedKey = { ...key, name: "test.loader-close", lifetime };

    expect(
      loadFact(location, loadedKey, () => {
        database.close();
        return "loaded";
      }),
    ).toBe("loaded");

    database.open();
    expect(getFact(database, loadedKey)).toBe(lifetime === "process" ? "loaded" : undefined);
  },
);

it("revokes retained validation when corruption is reported after native close", () => {
  using fixture = databaseFixture("sqlite-admission-closed-corruption-");
  const { database } = fixture;
  const admitted = schemaFacts(database);
  database.close();
  revokeAdmissions(database);

  database.open();
  admitSqliteSchema(database);
  expect(schemaFacts(database)?.admissionId).not.toBe(admitted?.admissionId);
  expect(database.prepare("SELECT value FROM proof").get()).toEqual({ value: 42 });
});

it("prepares the actual autocommit receipt before one scoped statement and publishes it after settlement", () => {
  using fixture = databaseFixture("sqlite-prepared-receipt-");
  const { database, location } = fixture;
  const before = scopedToken(database, "entry");
  const statement = database.prepare("INSERT INTO proof VALUES (?)");
  let pending: string | undefined;
  let pendingDatabase: string | undefined;
  let installed: { scoped: string | undefined; database: string | undefined } | undefined;
  postCommit(database, () =>
    withSqliteDatabaseWriteScope(database, ["entry"], () =>
      withSqlitePreparedNativeMutation(
        database,
        () => {
          expect(database.isTransaction).toBe(false);
          pending = pendingScopedToken(database, "entry");
          pendingDatabase = pendingToken(database);
          stageSqliteTransactionState(database, {
            commit: () => {
              installed = {
                scoped: scopedToken(database, "entry"),
                database: pathToken(location),
              };
            },
          });
        },
        () => statement.run(43),
      ),
    ),
  );
  expect(installed).toEqual({ scoped: pending, database: pendingDatabase });
  expect(pending).not.toBe(before);
  expect(pendingDatabase).toBeTypeOf("string");
  expect(pendingToken(database)).toBeUndefined();
  expect(database.prepare("SELECT value FROM proof").all()).toEqual([{ value: 42 }, { value: 43 }]);
});

it("keeps committed and pending row-cache tokens distinct across readmission", () => {
  using fixture = databaseFixture("sqlite-admission-tokens-");
  const { location, database } = fixture;
  database.close();
  let previous: string | undefined;

  for (const value of [43, 44]) {
    database.open();
    admitSqliteSchema(database);
    let pending: string | undefined;
    postCommit(database, () =>
      transaction(database, () => {
        database.prepare("UPDATE proof SET value = ?").run(value);
        pending = pendingToken(database);
      }),
    );
    const committed = pathToken(location);
    expect(committed).toBe(pending);
    expect(committed).not.toBe(previous);
    expect(database.prepare("SELECT value FROM proof").get()).toEqual({ value });
    previous = committed;
    database.close();
  }
});

it("keeps the prior prepared receipt when a competing writer refuses the native statement", () => {
  using fixture = databaseFixture("sqlite-prepared-busy-");
  const { database, location } = fixture;
  using peer = openNodeSqliteDatabase(location);
  database.exec("PRAGMA busy_timeout=0");
  peer.exec("BEGIN IMMEDIATE");
  const before = scopedToken(database, "entry");
  const beforeDatabase = pathToken(location);
  const statement = database.prepare("INSERT INTO proof VALUES (?)");
  expect(() =>
    postCommit(database, () =>
      withSqliteDatabaseWriteScope(database, ["entry"], () =>
        withSqlitePreparedNativeMutation(
          database,
          () => {},
          () => statement.run(43),
        ),
      ),
    ),
  ).toThrow("database is locked");
  expect(scopedToken(database, "entry")).toBe(before);
  expect(pathToken(location)).toBe(beforeDatabase);
  expect(database.prepare("SELECT value FROM proof").all()).toEqual([{ value: 42 }]);
  peer.exec("ROLLBACK");
});

it("releases a connection reference when initial admission exchange fails", () => {
  const location = path.join(tempDirs.make("sqlite-admission-open-failure-"), "proof.sqlite");
  createDatabase(location).close();
  retainLocation(location);
  try {
    expect(() =>
      withExchange(
        () => {
          throw new Error("admission relay closed");
        },
        () => openNodeSqliteDatabase(location),
      ),
    ).toThrow("admission relay closed");
    expect(recordsFor(location)).toEqual([]);
  } finally {
    retireAdmission(location);
  }
});

it("inherits only open database facts after 300 databases close", async () => {
  const root = tempDirs.make("sqlite-admission-many-closed-");
  const keptLocation = path.join(root, "open.sqlite");
  const kept = createDatabase(keptLocation);
  const locations = Array.from({ length: 300 }, (_, index) => path.join(root, `${index}.sqlite`));
  let worker: Worker | undefined;
  try {
    for (const location of locations) {
      createDatabase(location).close();
    }
    const inherited = readAdmissions(getEnvironmentData(SQLITE_DATABASE_ADMISSIONS_KEY));
    expect(
      inherited
        ?.filter((record) => record.location.startsWith(root))
        .map((record) => record.location),
    ).toEqual([keptLocation]);
    worker = new Worker(
      `const { getEnvironmentData, parentPort, workerData } = require("node:worker_threads");
       parentPort.postMessage(getEnvironmentData(workerData.key)
         .filter((record) => record.location.startsWith(workerData.root))
         .map((record) => record.location));`,
      { eval: true, execArgv: [], workerData: { key: SQLITE_DATABASE_ADMISSIONS_KEY, root } },
    );
    const [[inheritedLocations], [code]] = await Promise.all([
      once(worker, "message"),
      once(worker, "exit"),
    ]);
    expect(code).toBe(0);
    expect(inheritedLocations).toEqual([keptLocation]);
  } finally {
    await worker?.terminate();
    kept.close();
    for (const location of [keptLocation, ...locations]) {
      retireAdmission(location);
    }
  }
});

it.each(["reference-first", "close-first", "explicit-retirement", "path-replaced"] as const)(
  "settles native-open reference admission before exposing the handle (%s)",
  async (ordering) => {
    using fixture = databaseFixture("sqlite-admission-open-reference-");
    const { database, location } = fixture;
    const relay = createSqliteDatabaseAdmissionRelay(() => {});
    const bridge = new MessageChannel();
    let firstReference: SharedArrayBuffer | undefined;
    let worker: Worker | undefined;
    bridge.port1.on("message", (message: { admissions: unknown; port: MessagePort }) => {
      const admissions = readAdmissions(message.admissions);
      const reference =
        worker &&
        admissions?.find((record) => record.location === location)?.references.get(worker.threadId);
      if (!firstReference && reference && Atomics.load(new Int32Array(reference), 0) > 0) {
        firstReference = reference;
        if (ordering === "explicit-retirement") {
          retireAdmission(location);
        }
        if (ordering !== "reference-first") {
          database.close();
        }
        if (ordering === "path-replaced") {
          renameSync(location, path.join(path.dirname(location), "previous.sqlite"));
          createDatabase(location).close();
        }
      }
      relay.port.postMessage(message, [message.port]);
    });
    const script =
      admissionWorker(`       const { runSqliteImmediateTransactionSync } = await import(workerData.transaction);
       let database;
       try {
         database = exchange(() => openNodeSqliteDatabase(workerData.location));
       } catch (error) {
         parentPort.postMessage({ kind: "open-error", message: error.message });
         workerData.port.close();
         parentPort.close();
         return;
       }
       parentPort.on("message", () => {
         const result = exchange(() => runSqliteImmediateTransactionSync(database, () => ({
           isOpen: database.isOpen,
           value: database.prepare("SELECT value FROM proof").get().value,
           tokenPresent: readSqliteDatabaseScopedWriteToken(database, ["proof"]) !== undefined,
         })));
         exchange(() => database.close());
         parentPort.postMessage({ kind: "read", ...result });
         workerData.port.close();
         parentPort.close();
       });
       parentPort.postMessage({ kind: "opened" });`);
    try {
      worker = new Worker(script, workerOptions(location, bridge.port2));
      trackWorker(worker);
      const [opened] = await once(worker, "message");
      if (!firstReference) {
        throw new Error("Worker omitted its first native reference publication");
      }
      if (ordering === "explicit-retirement" || ordering === "path-replaced") {
        expect(opened).toEqual({
          kind: "open-error",
          message:
            ordering === "explicit-retirement"
              ? "SQLite database admission retired during native open"
              : "SQLite database changed identity during native open",
        });
        expect(Atomics.load(new Int32Array(firstReference), 0)).toBe(0);
        return;
      }
      expect(opened).toEqual({ kind: "opened" });
      if (database.isOpen) {
        database.close();
      }
      const read = once(worker, "message");
      worker.postMessage("read", []);
      expect((await read)[0]).toEqual({
        kind: "read",
        isOpen: true,
        value: 42,
        tokenPresent: true,
      });
      expect(Atomics.load(new Int32Array(firstReference), 0)).toBe(0);
    } finally {
      await worker?.terminate();
      bridge.port1.close();
      relay.finish();
      if (ordering === "path-replaced") {
        retireAdmission(path.join(path.dirname(location), "previous.sqlite"));
      }
    }
  },
);

it.each([false, true])(
  "retains sibling facts across worker exit but invalidates committed writes (retained: %s)",
  async (retained) => {
    using fixture = databaseFixture("sqlite-admission-worker-retention-");
    using closed = databaseFixture("sqlite-admission-closed-");
    using unrelated = databaseFixture("sqlite-admission-unrelated-");
    const { database, location } = fixture;
    const closedLocation = closed.location;
    const unrelatedLocation = unrelated.location;
    const relay = createSqliteDatabaseAdmissionRelay(() => {});
    let closeSource: Parameters<RuntimeWorkerGeneration["retain"]>[1] | undefined;
    const source = retained
      ? captureRetainedNativeWorkerSource({
          runtimeGeneration: {
            resolve: (url) => url,
            retain: (_owner, close) => {
              closeSource = close;
            },
          },
        })
      : undefined;
    const script =
      admissionWorker(`       const { admitSqliteSchema, getAdmittedSqliteSchemaFacts } = await import(workerData.schema);
       let database;
       const run = (command) => exchange(
         () => {
           if (command === "open") {
             database = openNodeSqliteDatabase(workerData.location);
             admitSqliteSchema(database);
             const closed = openNodeSqliteDatabase(workerData.closedLocation);
             admitSqliteSchema(closed);
             closed.close();
           } else if (command === "write") {
             database.prepare("UPDATE proof SET value = 43").run();
           } else if (command === "close") {
             database.close();
           } else if (command === "retire") {
             retireSqliteDatabaseAdmissionForPath(workerData.location);
           }
           parentPort.postMessage(command === "close" || command === "retire" ? command : {
             value: database.prepare("SELECT value FROM proof").get().value,
             admissionId: getAdmittedSqliteSchemaFacts(database).admissionId,
           });
         },
       );
       parentPort.on("message", run);
       run("open");`);
    const options = workerOptions(location, relay.port, { closedLocation });
    const retainedWorker = retained
      ? createRetainedNativeWorker(script, options, source)
      : undefined;
    const worker: WorkerLifecycle = retainedWorker ?? new Worker(script, options);
    source?.retain(worker, async () => {
      await worker.terminate();
    });
    if (retainedWorker) {
      expect(worker.threadId).toBe(0);
      retainedWorker.on("started", () => trackWorker(worker));
    } else {
      trackWorker(worker);
    }
    let reply = createDeferred<unknown>();
    worker.on("message", (message: unknown) => reply.resolve(message));
    worker.on("error", (error: Error) => reply.reject(error));
    const command = async (message: string, expected: unknown = message) => {
      reply = createDeferred<unknown>();
      worker.postMessage(message, []);
      expect(await reply.promise).toEqual(expected);
    };
    let sibling:
      | { worker: Worker; relay: ReturnType<typeof createSqliteDatabaseAdmissionRelay> }
      | undefined;
    try {
      const admissionId = schemaFacts(database)?.admissionId;
      expect(await reply.promise).toEqual({ value: 42, admissionId });
      expect(worker.threadId).toBeGreaterThan(0);
      const descriptor = recordsFor(location)[0]!.descriptor;
      const siblingRelay = createSqliteDatabaseAdmissionRelay(() => {});
      const siblingWorker = new Worker(
        script,
        workerOptions(location, siblingRelay.port, { closedLocation }),
      );
      sibling = { worker: siblingWorker, relay: siblingRelay };
      trackWorker(siblingWorker);
      expect((await once(siblingWorker, "message"))[0]).toEqual({ value: 42, admissionId });
      database.close();
      expect(recordsFor(location)).toHaveLength(1);
      await command("close");
      expect(recordsFor(location)).toHaveLength(1);
      await command("open", { value: 42, admissionId });
      await command("close");
      const siblingReply = once(siblingWorker, "message");
      siblingWorker.postMessage("read", []);
      expect((await siblingReply)[0]).toEqual({ value: 42, admissionId });
      await siblingWorker.terminate();
      siblingRelay.finish();
      sibling = undefined;
      expect(recordsFor(location)).toEqual([]);
      await command("open", { value: 42, admissionId });
      await command("close");
      expect(recordsFor(location)).toEqual([]);
      await command("retire");
      expect(() => fstatSync(descriptor)).toThrow();

      database.open();
      admitSqliteSchema(database);
      await command("open", { value: 42, admissionId: schemaFacts(database)?.admissionId });
      const beforeWrite = pathToken(location);
      const scopedBeforeWrite = scopedToken(database, "proof");
      await command("write", { value: 43, admissionId: schemaFacts(database)?.admissionId });
      expect(pathToken(location)).not.toBe(beforeWrite);
      expect(scopedToken(database, "proof")).not.toBe(scopedBeforeWrite);
      expect(database.prepare("SELECT value FROM proof").get()).toEqual({ value: 43 });
      const retiredOwner = worker.threadId;
      const stale = structuredClone(recordsFor(location));
      expect(stale[0]!.references.has(retiredOwner)).toBe(true);
      const beforeExit = pathToken(location);
      const scopedBeforeExit = scopedToken(database, "proof");
      const closedBeforeExit = pathToken(closedLocation);
      const unrelatedBeforeExit = pathToken(unrelatedLocation);
      expect(beforeExit).toBeTypeOf("string");
      expect(closedBeforeExit).toBeTypeOf("string");
      expect(unrelatedBeforeExit).toBeTypeOf("string");
      await worker.terminate();
      expect(pathToken(location)).toBe(beforeExit);
      expect(scopedToken(database, "proof")).toBe(scopedBeforeExit);
      expect(pathToken(closedLocation)).toBe(closedBeforeExit);
      expect(pathToken(unrelatedLocation)).toBe(unrelatedBeforeExit);
      const inherited = readAdmissions(getEnvironmentData(SQLITE_DATABASE_ADMISSIONS_KEY))?.find(
        (record) => record.location === location,
      );
      expect(inherited).toBeDefined();
      expect(inherited!.references.has(retiredOwner)).toBe(false);
      installAdmissions(stale);
      expect(recordsFor(location)[0]!.references.has(retiredOwner)).toBe(false);
      expect(schemaFacts(database)?.tables.has("proof")).toBe(true);
      database.close();
      expect(recordsFor(location)).toEqual([]);
    } finally {
      await sibling?.worker.terminate();
      sibling?.relay.finish();
      await worker.terminate();
      relay.finish();
      fixture[Symbol.dispose]();
      closed[Symbol.dispose]();
      unrelated[Symbol.dispose]();
      const retireSource = await closeSource?.();
      await retireSource?.();
    }
  },
);

it("path revocation invalidates scoped receipts and admission facts with a live handle", () => {
  using fixture = databaseFixture("sqlite-admission-path-revocation-");
  const { database, location } = fixture;
  const beforeRevocation = scopedToken(database, "proof");
  publishFact(database, key, "healthy");
  publishFact(database, schemaKey, "admitted");

  revokePath(location);

  expect(scopedToken(database, "proof")).not.toBe(beforeRevocation);
  expect(getFact(database, key)).toBeUndefined();
  expect(getFact(database, schemaKey)).toBeUndefined();
});

const key = { name: "test.engine-admission", read: (value: unknown) => value };
const schemaKey = { ...key, name: "test.engine-schema-admission", schemaDependent: true };

it.each(["committed", "native", "sqlite-transaction", "postgres-transaction"] as const)(
  "decodes admission values once at publication (%s)",
  (scope) => {
    using fixture = databaseFixture("sqlite-admission-decode-");
    const { location, database } = fixture;
    const connection = scope === "postgres-transaction" ? postgresConnection(database) : database;
    const read = vi.fn((value: unknown) =>
      typeof value === "string" ? value.toUpperCase() : undefined,
    );
    const decodedKey = { name: "test.decoded-fact", read };
    const publishAndRead = () => {
      publishFact(connection, decodedKey, "first");
      expect(read).toHaveBeenCalledTimes(1);
      expect(getFact(connection, decodedKey)).toBe("FIRST");
      expect(getFact(connection, decodedKey)).toBe("FIRST");
      expect(read).toHaveBeenCalledTimes(1);
      publishFact(connection, decodedKey, "replacement");
      expect(getFact(connection, decodedKey)).toBe("REPLACEMENT");
      expect(read).toHaveBeenCalledTimes(2);
    };

    if (scope === "native") {
      const finish = beginOperation(database);
      try {
        publishAndRead();
      } finally {
        finish();
      }
      expect(getFact(connection, decodedKey)).toBeUndefined();
    } else {
      if (scope.endsWith("transaction")) {
        transaction(connection, publishAndRead);
      } else {
        publishAndRead();
      }
      expect(getFact(connection, decodedKey)).toBe("REPLACEMENT");
      expect(loadFact(location, decodedKey, () => "stale")).toBe("REPLACEMENT");
      expect(read).toHaveBeenCalledTimes(2);

      const transferred = structuredClone(recordsFor(location)[0]!.facts.get(decodedKey.name)!);
      expect(readFact(transferred, decodedKey)).toBe("REPLACEMENT");
      expect(readFact(transferred, decodedKey)).toBe("REPLACEMENT");
      expect(read).toHaveBeenCalledTimes(3);
    }
  },
);

const postgresConnections: PostgresSqlConnection[] = [];
afterEach(() => {
  for (const connection of postgresConnections.splice(0)) {
    withEngineStoreAdmission(() => connection.close());
  }
});

function postgresConnection(anchor: DatabaseSync): PostgresSqlConnection {
  const configured = getEnvironmentData("openclaw.test.workboard.connection");
  if (typeof configured === "string") {
    const connection = new PostgresSyncConnection(configured, "public", anchor, "admission-test");
    postgresConnections.push(connection);
    return connection;
  }
  let isTransaction = false;
  return {
    [Symbol.for("openclaw.postgres-sync-connection")]: true,
    anchor,
    advisoryLockKey: 1n,
    mutationRevision: 0,
    get isOpen() {
      return anchor.isOpen;
    },
    get isTransaction() {
      return isTransaction;
    },
    exec(sql) {
      if (sql.startsWith("BEGIN")) {
        isTransaction = true;
      } else if (sql === "COMMIT" || sql === "ROLLBACK") {
        isTransaction = false;
      }
    },
    query() {
      throw new Error("Admission facts must not query PostgreSQL");
    },
    prepare() {
      throw new Error("Admission facts must not query PostgreSQL");
    },
    close() {},
    runTransaction(operation, options, ...modes) {
      return runPostgresTransactionSync(this, operation, options, ...modes);
    },
  };
}

function withPostgres(
  operation: (connection: PostgresSqlConnection, peer: DatabaseSync, anchor: DatabaseSync) => void,
) {
  return withEngineStoreAdmission(() => {
    const filename = path.join(tempDirs.make("engine-admission-"), "anchor.sqlite");
    using anchor = openNodeSqliteDatabase(filename);
    using peer = openNodeSqliteDatabase(filename);
    operation(postgresConnection(anchor), peer, anchor);
  });
}

it("PostgreSQL keeps publications local until commit and restores nested and outer rollback", () =>
  withPostgres((connection, peer, anchor) => {
    const transact = (operation: () => void) => transaction(connection, operation);

    publishFact(connection, key, "initial");
    expect(getFact(peer, key)).toBe("initial");
    transact(() => {
      expect(connection.isTransaction).toBe(true);
      expect(anchor.isTransaction).toBe(false);
      publishFact(connection, key, "outer");
      expect(getFact(connection, key)).toBe("outer");
      expect(getFact(peer, key)).toBe("initial");
      expect(() =>
        transact(() => {
          publishFact(connection, key, "nested");
          expect(getFact(connection, key)).toBe("nested");
          throw new Error("nested rollback");
        }),
      ).toThrow("nested rollback");
      expect(getFact(connection, key)).toBe("outer");
      expect(getFact(peer, key)).toBe("initial");
    });
    expect(getFact(peer, key)).toBe("outer");
    expect(() =>
      transact(() => {
        publishFact(connection, key, "rolled back");
        throw new Error("outer rollback");
      }),
    ).toThrow("outer rollback");
    expect([getFact(connection, key), getFact(peer, key)]).toEqual(["outer", "outer"]);
    publishFact(connection, key, "autocommit");
    expect(getFact(peer, key)).toBe("autocommit");
  }));

it("uses the PostgreSQL anchor for schema dirtiness, final revisions, and discarded facts", () =>
  withPostgres((connection, peer, anchor) => {
    publishFact(connection, schemaKey, "initial");
    expect(() =>
      connection.runTransaction(() => {
        invalidateSchema(connection);
        expect(schemaDirty(connection)).toBe(true);
        expect(getFact(connection, schemaKey)).toBeUndefined();
        throw new Error("DDL rollback");
      }),
    ).toThrow("DDL rollback");
    expect(schemaDirty(connection)).toBe(false);
    expect(getFact(connection, schemaKey)).toBe("initial");

    connection.runTransaction(() => {
      invalidateSchema(connection);
      stageSqliteTransactionState(anchor, {
        stage: () => {},
        rollback: () => {},
        commit: () => publishSchema(connection),
      });
      publishFact(connection, schemaKey, "committed schema");
      expect(getFact(peer, schemaKey)).toBe("initial");
    });
    expect(getFact(peer, schemaKey)).toBe("committed schema");
    expect(schemaDirty(connection)).toBe(false);

    connection.runTransaction(() => {
      publishFact(connection, schemaKey, "discarded");
      discardFacts(connection);
      expect(getFact(connection, schemaKey)).toBeUndefined();
    });
    expect(getFact(peer, schemaKey)).toBeUndefined();
    publishFact(connection, schemaKey, "replacement");
    expect(getFact(peer, schemaKey)).toBe("replacement");
  }));

it("keeps PostgreSQL publications independent of native SQLite callback facts and suspension", () =>
  withPostgres((connection, peer, anchor) => {
    const finish = beginOperation(anchor);
    try {
      publishFact(anchor, key, "native callback");
      publishFact(connection, key, "postgres");
      expect([getFact(connection, key), getFact(peer, key)]).toEqual(["postgres", "postgres"]);
      suspendAdmission(anchor, true);
      expect(getFact(connection, key)).toBeUndefined();
      publishFact(connection, key, "suspended");
    } finally {
      suspendAdmission(anchor, false);
      finish();
    }
    expect(getFact(peer, key)).toBe("postgres");
  }));
