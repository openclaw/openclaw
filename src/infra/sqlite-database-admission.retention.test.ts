import { once } from "node:events";
import { fstatSync, renameSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getEnvironmentData, MessageChannel, type MessagePort, Worker } from "node:worker_threads";
import type { WorkerLifecycle } from "@openclaw/worker-runtime/lifecycle";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { recordOpenClawDatabaseQuarantine } from "../state/openclaw-quarantine-store.js";
import { withEngineStoreAdmission } from "./database-engine/admission-scope.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "./node-sqlite.js";
import { PostgresSyncConnection } from "./postgres-sync/connection.js";
import { runPostgresTransactionSync } from "./postgres-sync/transaction.js";
import type { RuntimeWorkerGeneration } from "./runtime-worker-generation.js";
import type { PostgresSqlConnection } from "./sql-connection.js";
import { SQLITE_DATABASE_ADMISSIONS_KEY } from "./sqlite-database-admission-key.js";
import { readSqliteDatabaseAdmissionFact } from "./sqlite-database-admission-record.js";
import {
  beginSqliteDatabaseAdmissionOperation,
  discardSqliteDatabaseTransactionAdmissions,
  getSqliteDatabaseAdmission,
  getOrLoadSqliteDatabaseAdmissionForPath,
  hasPendingSqliteDatabaseSchemaMutation,
  invalidateLocalSqliteSchemaAdmissions,
  publishSqliteDatabaseAdmission,
  publishSqliteDatabaseSchemaChange,
  suspendSqliteDatabaseAdmission,
  captureSqliteDatabaseAdmissions,
  installSqliteDatabaseAdmissions,
  readSqliteDatabaseAdmissions,
  readSqliteDatabasePendingWriteToken,
  readSqliteDatabaseScopedWriteToken,
  prepareSqliteDatabaseCleanClose,
  recordSqliteDatabaseIntegrity,
  readSqliteDatabaseWriteTokenForPath,
  retireSqliteDatabaseAdmissionForPath,
  retainSqliteDatabaseAdmissionLocation,
  revokeSqliteDatabaseAdmissions,
  trackSqliteDatabaseAdmissionWorker,
  withSqliteDatabaseAdmissionExchange,
} from "./sqlite-database-admission.js";
import {
  stageSqliteTransactionState,
  withSqlitePostCommitPublications,
} from "./sqlite-post-commit.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "./sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
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

function recordsFor(location: string) {
  return captureSqliteDatabaseAdmissions().filter((record) => record.location === location);
}

it("retires the final closed handle's facts while preserving open siblings and descriptor custody", () => {
  const location = path.join(tempDirs.make("sqlite-admission-retention-"), "proof.sqlite");
  const first = createDatabase(location);
  const second = openNodeSqliteDatabase(location);
  admitSqliteSchema(second);
  const original = recordsFor(location)[0]!;
  const stale = structuredClone([original]);
  try {
    first.close();
    expect(recordsFor(location)).toHaveLength(1);
    expect(getAdmittedSqliteSchemaFacts(second)?.tables.has("proof")).toBe(true);
    const admittedSchema = getAdmittedSqliteSchemaFacts(second);
    recordSqliteDatabaseIntegrity(second);
    {
      using seal = prepareSqliteDatabaseCleanClose(second);
      second.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      second.close();
      expect(recordsFor(location)).toHaveLength(1);
      expect(seal.publish()).toBe(true);
    }
    expect(recordsFor(location)).toEqual([]);
    expect(fstatSync(original.descriptor).isFile()).toBe(true);

    installSqliteDatabaseAdmissions(stale);
    expect(recordsFor(location)).toEqual([]);

    first.open();
    expect(getAdmittedSqliteSchemaFacts(first)?.admissionId).toBe(admittedSchema?.admissionId);
    admitSqliteSchema(first);
    expect(first.prepare("SELECT value FROM proof").get()).toEqual({ value: 42 });
    expect(getAdmittedSqliteSchemaFacts(first)?.tables.has("proof")).toBe(true);
    const readmitted = recordsFor(location)[0]!;
    expect(readmitted.generationId).not.toBe(original.generationId);
    expect(readmitted.descriptor).toBe(original.descriptor);
    first.close();
    expect(recordsFor(location)).toEqual([]);
    retireSqliteDatabaseAdmissionForPath(location);
    expect(() => fstatSync(original.descriptor)).toThrow();
  } finally {
    if (first.isOpen) {
      first.close();
    }
    if (second.isOpen) {
      second.close();
    }
    retireSqliteDatabaseAdmissionForPath(location);
  }
});

it("reuses physical catalog facts after unsealed close and invalidates them on DDL", () => {
  const location = path.join(tempDirs.make("sqlite-admission-process-facts-"), "proof.sqlite");
  const database = createDatabase(location);
  const admitted = getAdmittedSqliteSchemaFacts(database);
  publishSqliteDatabaseAdmission(database, key, "connection-scoped");
  database.close();
  try {
    database.open();
    const observation = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
    try {
      admitSqliteSchema(database);
      expect(getAdmittedSqliteSchemaFacts(database)?.admissionId).toBe(admitted?.admissionId);
      expect(observation.queries).toEqual([]);
    } finally {
      observation.restore();
    }
    expect(getSqliteDatabaseAdmission(database, key)).toBeUndefined();
    database.exec("ALTER TABLE proof ADD COLUMN added TEXT");
    database.close();
    database.open();
    admitSqliteSchema(database);
    expect(getAdmittedSqliteSchemaFacts(database)?.tableSql.get("proof")).toContain("added TEXT");
    expect(getAdmittedSqliteSchemaFacts(database)?.admissionId).not.toBe(admitted?.admissionId);
    database.prepare("UPDATE proof SET value = 43").run();
    expect(database.prepare("SELECT value FROM proof").get()).toEqual({ value: 43 });
  } finally {
    database.close();
    retireSqliteDatabaseAdmissionForPath(location);
  }
});

it.each([undefined, "process"] as const)(
  "preserves path-load lifetime when the loader closes its handle (%s)",
  (lifetime) => {
    const location = path.join(tempDirs.make("sqlite-admission-loader-close-"), "proof.sqlite");
    const database = createDatabase(location);
    const loadedKey = { ...key, name: "test.loader-close", lifetime };
    try {
      expect(
        getOrLoadSqliteDatabaseAdmissionForPath(location, loadedKey, () => {
          database.close();
          return "loaded";
        }),
      ).toBe("loaded");

      database.open();
      expect(getSqliteDatabaseAdmission(database, loadedKey)).toBe(
        lifetime === "process" ? "loaded" : undefined,
      );
    } finally {
      if (database.isOpen) {
        database.close();
      }
      retireSqliteDatabaseAdmissionForPath(location);
    }
  },
);

it("revokes retained validation when corruption is reported after native close", () => {
  const location = path.join(tempDirs.make("sqlite-admission-closed-corruption-"), "proof.sqlite");
  const database = createDatabase(location);
  const admitted = getAdmittedSqliteSchemaFacts(database);
  database.close();
  revokeSqliteDatabaseAdmissions(database);
  try {
    database.open();
    admitSqliteSchema(database);
    expect(getAdmittedSqliteSchemaFacts(database)?.admissionId).not.toBe(admitted?.admissionId);
    expect(database.prepare("SELECT value FROM proof").get()).toEqual({ value: 42 });
  } finally {
    database.close();
    retireSqliteDatabaseAdmissionForPath(location);
  }
});

it("keeps committed and pending row-cache tokens distinct across readmission", () => {
  const location = path.join(tempDirs.make("sqlite-admission-tokens-"), "proof.sqlite");
  const database = createDatabase(location);
  database.close();
  let previous: string | undefined;
  try {
    for (const value of [43, 44]) {
      database.open();
      admitSqliteSchema(database);
      let pending: string | undefined;
      withSqlitePostCommitPublications(database, () =>
        runSqliteImmediateTransactionSync(database, () => {
          database.prepare("UPDATE proof SET value = ?").run(value);
          pending = readSqliteDatabasePendingWriteToken(database);
        }),
      );
      const committed = readSqliteDatabaseWriteTokenForPath(location);
      expect(committed).toBe(pending);
      expect(committed).not.toBe(previous);
      expect(database.prepare("SELECT value FROM proof").get()).toEqual({ value });
      previous = committed;
      database.close();
    }
  } finally {
    if (database.isOpen) {
      database.close();
    }
    retireSqliteDatabaseAdmissionForPath(location);
  }
});

it("releases a connection reference when initial admission exchange fails", () => {
  const location = path.join(tempDirs.make("sqlite-admission-open-failure-"), "proof.sqlite");
  createDatabase(location).close();
  retainSqliteDatabaseAdmissionLocation(location);
  try {
    expect(() =>
      withSqliteDatabaseAdmissionExchange(
        () => {
          throw new Error("admission relay closed");
        },
        () => openNodeSqliteDatabase(location),
      ),
    ).toThrow("admission relay closed");
    expect(recordsFor(location)).toEqual([]);
  } finally {
    retireSqliteDatabaseAdmissionForPath(location);
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
    const inherited = readSqliteDatabaseAdmissions(
      getEnvironmentData(SQLITE_DATABASE_ADMISSIONS_KEY),
    );
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
      retireSqliteDatabaseAdmissionForPath(location);
    }
  }
});

it.each(["reference-first", "close-first", "explicit-retirement", "path-replaced"] as const)(
  "settles native-open reference admission before exposing the handle (%s)",
  async (ordering) => {
    const location = path.join(tempDirs.make("sqlite-admission-open-reference-"), "proof.sqlite");
    const database = createDatabase(location);
    const relay = createSqliteDatabaseAdmissionRelay(() => {});
    const bridge = new MessageChannel();
    let firstReference: SharedArrayBuffer | undefined;
    let worker: Worker | undefined;
    bridge.port1.on("message", (message: { admissions: unknown; port: MessagePort }) => {
      const admissions = readSqliteDatabaseAdmissions(message.admissions);
      const reference =
        worker &&
        admissions?.find((record) => record.location === location)?.references.get(worker.threadId);
      if (!firstReference && reference && Atomics.load(new Int32Array(reference), 0) > 0) {
        firstReference = reference;
        if (ordering === "explicit-retirement") {
          retireSqliteDatabaseAdmissionForPath(location);
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
    const script = `const { parentPort, workerData } = require("node:worker_threads");
     (async () => {
       const { register } = await import(workerData.loader);
       register();
       const { openNodeSqliteDatabase } = await import(workerData.native);
       const { withSqliteDatabaseAdmissionExchange, readSqliteDatabaseScopedWriteToken } =
         await import(workerData.admission);
       const { exchangeSqliteDatabaseAdmissions } = await import(workerData.relay);
       const { runSqliteImmediateTransactionSync } = await import(workerData.transaction);
       const run = (callback) => withSqliteDatabaseAdmissionExchange(
         (records, location, create) =>
           exchangeSqliteDatabaseAdmissions(workerData.port, records, location, create),
         callback,
       );
       let database;
       try {
         database = run(() => openNodeSqliteDatabase(workerData.location));
       } catch (error) {
         parentPort.postMessage({ kind: "open-error", message: error.message });
         workerData.port.close();
         parentPort.close();
         return;
       }
       parentPort.on("message", () => {
         const result = run(() => runSqliteImmediateTransactionSync(database, () => ({
           isOpen: database.isOpen,
           value: database.prepare("SELECT value FROM proof").get().value,
           tokenPresent: readSqliteDatabaseScopedWriteToken(database, ["proof"]) !== undefined,
         })));
         run(() => database.close());
         parentPort.postMessage({ kind: "read", ...result });
         workerData.port.close();
         parentPort.close();
       });
       parentPort.postMessage({ kind: "opened" });
     })().catch((error) => { throw error; });`;
    try {
      worker = new Worker(script, {
        eval: true,
        execArgv: [],
        workerData: {
          location,
          port: bridge.port2,
          loader: import.meta.resolve("tsx/esm/api"),
          native: new URL("./node-sqlite.ts", import.meta.url).href,
          admission: new URL("./sqlite-database-admission.ts", import.meta.url).href,
          relay: new URL("./sqlite-worker-database-admission-relay.ts", import.meta.url).href,
          transaction: new URL("./sqlite-transaction.ts", import.meta.url).href,
        },
        transferList: [bridge.port2],
      });
      trackSqliteDatabaseAdmissionWorker(worker);
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
      if (database.isOpen) {
        database.close();
      }
      retireSqliteDatabaseAdmissionForPath(location);
      if (ordering === "path-replaced") {
        retireSqliteDatabaseAdmissionForPath(path.join(path.dirname(location), "previous.sqlite"));
      }
    }
  },
);

it.each([false, true])(
  "retains sibling facts across worker exit but invalidates committed writes (retained: %s)",
  async (retained) => {
    const root = tempDirs.make("sqlite-admission-worker-retention-");
    const location = path.join(root, "proof.sqlite");
    const database = createDatabase(location);
    const closedLocation = path.join(root, "closed.sqlite");
    const closedDatabase = createDatabase(closedLocation);
    const unrelatedLocation = path.join(root, "unrelated.sqlite");
    const unrelatedDatabase = createDatabase(unrelatedLocation);
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
    const script = `const { parentPort, workerData } = require("node:worker_threads");
     (async () => {
       const { register } = await import(workerData.loader);
       register();
       const { openNodeSqliteDatabase } = await import(workerData.native);
       const { withSqliteDatabaseAdmissionExchange, retireSqliteDatabaseAdmissionForPath } =
         await import(workerData.admission);
       const { admitSqliteSchema, getAdmittedSqliteSchemaFacts } = await import(workerData.schema);
       const { exchangeSqliteDatabaseAdmissions } = await import(workerData.relay);
       let database;
       const run = (command) => withSqliteDatabaseAdmissionExchange(
         (records, location, create) =>
           exchangeSqliteDatabaseAdmissions(workerData.port, records, location, create),
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
       run("open");
     })().catch((error) => { throw error; });`;
    const options = {
      eval: true,
      execArgv: [],
      workerData: {
        location,
        closedLocation,
        port: relay.port,
        loader: import.meta.resolve("tsx/esm/api"),
        native: new URL("./node-sqlite.ts", import.meta.url).href,
        admission: new URL("./sqlite-database-admission.ts", import.meta.url).href,
        schema: new URL("./sqlite-schema-facts.ts", import.meta.url).href,
        relay: new URL("./sqlite-worker-database-admission-relay.ts", import.meta.url).href,
      },
      transferList: [relay.port],
    };
    const retainedWorker = retained
      ? createRetainedNativeWorker(script, options, source)
      : undefined;
    const worker: WorkerLifecycle = retainedWorker ?? new Worker(script, options);
    source?.retain(worker, async () => {
      await worker.terminate();
    });
    if (retainedWorker) {
      expect(worker.threadId).toBe(0);
      retainedWorker.on("started", () => trackSqliteDatabaseAdmissionWorker(worker));
    } else {
      trackSqliteDatabaseAdmissionWorker(worker);
    }
    let reply = createDeferred<unknown>();
    worker.on("message", (message: unknown) => reply.resolve(message));
    worker.on("error", (error: Error) => reply.reject(error));
    const command = async (message: string) => {
      reply = createDeferred<unknown>();
      worker.postMessage(message, []);
      return await reply.promise;
    };
    let sibling:
      | { worker: Worker; relay: ReturnType<typeof createSqliteDatabaseAdmissionRelay> }
      | undefined;
    try {
      const admissionId = getAdmittedSqliteSchemaFacts(database)?.admissionId;
      expect(await reply.promise).toEqual({ value: 42, admissionId });
      expect(worker.threadId).toBeGreaterThan(0);
      const descriptor = recordsFor(location)[0]!.descriptor;
      const siblingRelay = createSqliteDatabaseAdmissionRelay(() => {});
      const siblingWorker = new Worker(script, {
        ...options,
        workerData: { ...options.workerData, port: siblingRelay.port },
        transferList: [siblingRelay.port],
      });
      sibling = { worker: siblingWorker, relay: siblingRelay };
      trackSqliteDatabaseAdmissionWorker(siblingWorker);
      expect((await once(siblingWorker, "message"))[0]).toEqual({ value: 42, admissionId });
      database.close();
      expect(recordsFor(location)).toHaveLength(1);
      expect(await command("close")).toBe("close");
      expect(recordsFor(location)).toHaveLength(1);
      expect(await command("open")).toEqual({ value: 42, admissionId });
      expect(await command("close")).toBe("close");
      const siblingReply = once(siblingWorker, "message");
      siblingWorker.postMessage("read", []);
      expect((await siblingReply)[0]).toEqual({ value: 42, admissionId });
      await siblingWorker.terminate();
      siblingRelay.finish();
      sibling = undefined;
      expect(recordsFor(location)).toEqual([]);
      expect(await command("open")).toEqual({ value: 42, admissionId });
      expect(await command("close")).toBe("close");
      expect(recordsFor(location)).toEqual([]);
      expect(await command("retire")).toBe("retire");
      expect(() => fstatSync(descriptor)).toThrow();

      database.open();
      admitSqliteSchema(database);
      expect(await command("open")).toEqual({
        value: 42,
        admissionId: getAdmittedSqliteSchemaFacts(database)?.admissionId,
      });
      const beforeWrite = readSqliteDatabaseWriteTokenForPath(location);
      const scopedBeforeWrite = readSqliteDatabaseScopedWriteToken(database, "proof");
      expect(await command("write")).toEqual({
        value: 43,
        admissionId: getAdmittedSqliteSchemaFacts(database)?.admissionId,
      });
      expect(readSqliteDatabaseWriteTokenForPath(location)).not.toBe(beforeWrite);
      expect(readSqliteDatabaseScopedWriteToken(database, "proof")).not.toBe(scopedBeforeWrite);
      expect(database.prepare("SELECT value FROM proof").get()).toEqual({ value: 43 });
      const retiredOwner = worker.threadId;
      const stale = structuredClone(recordsFor(location));
      expect(stale[0]!.references.has(retiredOwner)).toBe(true);
      const beforeExit = readSqliteDatabaseWriteTokenForPath(location);
      const scopedBeforeExit = readSqliteDatabaseScopedWriteToken(database, "proof");
      const closedBeforeExit = readSqliteDatabaseWriteTokenForPath(closedLocation);
      const unrelatedBeforeExit = readSqliteDatabaseWriteTokenForPath(unrelatedLocation);
      expect(beforeExit).toBeTypeOf("string");
      expect(closedBeforeExit).toBeTypeOf("string");
      expect(unrelatedBeforeExit).toBeTypeOf("string");
      await worker.terminate();
      expect(readSqliteDatabaseWriteTokenForPath(location)).toBe(beforeExit);
      expect(readSqliteDatabaseScopedWriteToken(database, "proof")).toBe(scopedBeforeExit);
      expect(readSqliteDatabaseWriteTokenForPath(closedLocation)).toBe(closedBeforeExit);
      expect(readSqliteDatabaseWriteTokenForPath(unrelatedLocation)).toBe(unrelatedBeforeExit);
      const inherited = readSqliteDatabaseAdmissions(
        getEnvironmentData(SQLITE_DATABASE_ADMISSIONS_KEY),
      )?.find((record) => record.location === location);
      expect(inherited).toBeDefined();
      expect(inherited!.references.has(retiredOwner)).toBe(false);
      installSqliteDatabaseAdmissions(stale);
      expect(recordsFor(location)[0]!.references.has(retiredOwner)).toBe(false);
      expect(getAdmittedSqliteSchemaFacts(database)?.tables.has("proof")).toBe(true);
      database.close();
      expect(recordsFor(location)).toEqual([]);
    } finally {
      await sibling?.worker.terminate();
      sibling?.relay.finish();
      await worker.terminate();
      relay.finish();
      if (database.isOpen) {
        database.close();
      }
      retireSqliteDatabaseAdmissionForPath(location);
      closedDatabase.close();
      unrelatedDatabase.close();
      retireSqliteDatabaseAdmissionForPath(closedLocation);
      retireSqliteDatabaseAdmissionForPath(unrelatedLocation);
      const retireSource = await closeSource?.();
      await retireSource?.();
    }
  },
);

it("quarantine invalidates scoped receipts and admission facts with a live handle", () => {
  const root = tempDirs.make("sqlite-admission-quarantine-");
  const location = path.join(root, "proof.sqlite");
  using database = createDatabase(location);
  const beforeQuarantine = readSqliteDatabaseScopedWriteToken(database, "proof");
  publishSqliteDatabaseAdmission(database, key, "healthy");
  publishSqliteDatabaseAdmission(database, schemaKey, "admitted");

  expect(
    recordOpenClawDatabaseQuarantine({
      env: { OPENCLAW_STATE_DIR: root },
      path: location,
      kind: "agent",
      reason: "synthetic verified damage",
    }),
  ).toBe(true);

  expect(readSqliteDatabaseScopedWriteToken(database, "proof")).not.toBe(beforeQuarantine);
  expect(getSqliteDatabaseAdmission(database, key)).toBeUndefined();
  expect(getSqliteDatabaseAdmission(database, schemaKey)).toBeUndefined();
});

const key = { name: "test.engine-admission", read: (value: unknown) => value };
const schemaKey = { ...key, name: "test.engine-schema-admission", schemaDependent: true };

it.each(["committed", "native", "sqlite-transaction", "postgres-transaction"] as const)(
  "decodes admission values once at publication (%s)",
  (scope) => {
    const location = path.join(tempDirs.make("sqlite-admission-decode-"), "proof.sqlite");
    const database = createDatabase(location);
    const connection = scope === "postgres-transaction" ? postgresConnection(database) : database;
    const read = vi.fn((value: unknown) =>
      typeof value === "string" ? value.toUpperCase() : undefined,
    );
    const decodedKey = { name: "test.decoded-fact", read };
    const publishAndRead = () => {
      publishSqliteDatabaseAdmission(connection, decodedKey, "first");
      expect(read).toHaveBeenCalledTimes(1);
      expect(getSqliteDatabaseAdmission(connection, decodedKey)).toBe("FIRST");
      expect(getSqliteDatabaseAdmission(connection, decodedKey)).toBe("FIRST");
      expect(read).toHaveBeenCalledTimes(1);
      publishSqliteDatabaseAdmission(connection, decodedKey, "replacement");
      expect(getSqliteDatabaseAdmission(connection, decodedKey)).toBe("REPLACEMENT");
      expect(read).toHaveBeenCalledTimes(2);
    };
    try {
      if (scope === "native") {
        const finish = beginSqliteDatabaseAdmissionOperation(database);
        try {
          publishAndRead();
        } finally {
          finish();
        }
        expect(getSqliteDatabaseAdmission(connection, decodedKey)).toBeUndefined();
      } else {
        if (scope.endsWith("transaction")) {
          runSqliteImmediateTransactionSync(connection, publishAndRead);
        } else {
          publishAndRead();
        }
        expect(getSqliteDatabaseAdmission(connection, decodedKey)).toBe("REPLACEMENT");
        expect(getOrLoadSqliteDatabaseAdmissionForPath(location, decodedKey, () => "stale")).toBe(
          "REPLACEMENT",
        );
        expect(read).toHaveBeenCalledTimes(2);

        const transferred = structuredClone(recordsFor(location)[0]!.facts.get(decodedKey.name)!);
        expect(readSqliteDatabaseAdmissionFact(transferred, decodedKey)).toBe("REPLACEMENT");
        expect(readSqliteDatabaseAdmissionFact(transferred, decodedKey)).toBe("REPLACEMENT");
        expect(read).toHaveBeenCalledTimes(3);
      }
    } finally {
      database.close();
      retireSqliteDatabaseAdmissionForPath(location);
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

it("PostgreSQL keeps publications local until commit and restores nested and outer rollback", () =>
  withEngineStoreAdmission(() => {
    const filename = path.join(tempDirs.make("engine-admission-"), "anchor.sqlite");
    using anchor = openNodeSqliteDatabase(filename);
    using peer = openNodeSqliteDatabase(filename);
    const connection = postgresConnection(anchor);
    const transact = (operation: () => void) =>
      runSqliteImmediateTransactionSync(connection, operation);

    publishSqliteDatabaseAdmission(connection, key, "initial");
    expect(getSqliteDatabaseAdmission(peer, key)).toBe("initial");
    transact(() => {
      expect(connection.isTransaction).toBe(true);
      expect(anchor.isTransaction).toBe(false);
      publishSqliteDatabaseAdmission(connection, key, "outer");
      expect(getSqliteDatabaseAdmission(connection, key)).toBe("outer");
      expect(getSqliteDatabaseAdmission(peer, key)).toBe("initial");
      expect(() =>
        transact(() => {
          publishSqliteDatabaseAdmission(connection, key, "nested");
          expect(getSqliteDatabaseAdmission(connection, key)).toBe("nested");
          throw new Error("nested rollback");
        }),
      ).toThrow("nested rollback");
      expect(getSqliteDatabaseAdmission(connection, key)).toBe("outer");
      expect(getSqliteDatabaseAdmission(peer, key)).toBe("initial");
    });
    expect(getSqliteDatabaseAdmission(peer, key)).toBe("outer");
    expect(() =>
      transact(() => {
        publishSqliteDatabaseAdmission(connection, key, "rolled back");
        throw new Error("outer rollback");
      }),
    ).toThrow("outer rollback");
    expect(getSqliteDatabaseAdmission(connection, key)).toBe("outer");
    expect(getSqliteDatabaseAdmission(peer, key)).toBe("outer");
    publishSqliteDatabaseAdmission(connection, key, "autocommit");
    expect(getSqliteDatabaseAdmission(peer, key)).toBe("autocommit");
  }));

it("uses the PostgreSQL anchor for schema dirtiness, final revisions, and discarded facts", () =>
  withEngineStoreAdmission(() => {
    const filename = path.join(tempDirs.make("engine-schema-admission-"), "anchor.sqlite");
    using anchor = openNodeSqliteDatabase(filename);
    using peer = openNodeSqliteDatabase(filename);
    const connection = postgresConnection(anchor);
    publishSqliteDatabaseAdmission(connection, schemaKey, "initial");
    expect(() =>
      connection.runTransaction(() => {
        invalidateLocalSqliteSchemaAdmissions(connection);
        expect(hasPendingSqliteDatabaseSchemaMutation(connection)).toBe(true);
        expect(getSqliteDatabaseAdmission(connection, schemaKey)).toBeUndefined();
        throw new Error("DDL rollback");
      }),
    ).toThrow("DDL rollback");
    expect(hasPendingSqliteDatabaseSchemaMutation(connection)).toBe(false);
    expect(getSqliteDatabaseAdmission(connection, schemaKey)).toBe("initial");

    connection.runTransaction(() => {
      invalidateLocalSqliteSchemaAdmissions(connection);
      stageSqliteTransactionState(anchor, {
        stage: () => {},
        rollback: () => {},
        commit: () => publishSqliteDatabaseSchemaChange(connection),
      });
      publishSqliteDatabaseAdmission(connection, schemaKey, "committed schema");
      expect(getSqliteDatabaseAdmission(peer, schemaKey)).toBe("initial");
    });
    expect(getSqliteDatabaseAdmission(peer, schemaKey)).toBe("committed schema");
    expect(hasPendingSqliteDatabaseSchemaMutation(connection)).toBe(false);

    connection.runTransaction(() => {
      publishSqliteDatabaseAdmission(connection, schemaKey, "discarded");
      discardSqliteDatabaseTransactionAdmissions(connection);
      expect(getSqliteDatabaseAdmission(connection, schemaKey)).toBeUndefined();
    });
    expect(getSqliteDatabaseAdmission(peer, schemaKey)).toBeUndefined();
    publishSqliteDatabaseAdmission(connection, schemaKey, "replacement");
    expect(getSqliteDatabaseAdmission(peer, schemaKey)).toBe("replacement");
  }));

it("keeps PostgreSQL publications independent of native SQLite callback facts and suspension", () =>
  withEngineStoreAdmission(() => {
    const filename = path.join(tempDirs.make("engine-native-admission-"), "anchor.sqlite");
    using anchor = openNodeSqliteDatabase(filename);
    using peer = openNodeSqliteDatabase(filename);
    const connection = postgresConnection(anchor);
    const finish = beginSqliteDatabaseAdmissionOperation(anchor);
    try {
      publishSqliteDatabaseAdmission(anchor, key, "native callback");
      publishSqliteDatabaseAdmission(connection, key, "postgres");
      expect(getSqliteDatabaseAdmission(connection, key)).toBe("postgres");
      expect(getSqliteDatabaseAdmission(peer, key)).toBe("postgres");
      suspendSqliteDatabaseAdmission(anchor, true);
      expect(getSqliteDatabaseAdmission(connection, key)).toBeUndefined();
      publishSqliteDatabaseAdmission(connection, key, "suspended");
    } finally {
      suspendSqliteDatabaseAdmission(anchor, false);
      finish();
    }
    expect(getSqliteDatabaseAdmission(peer, key)).toBe("postgres");
  }));
