import { once } from "node:events";
import { fstatSync, renameSync } from "node:fs";
import path from "node:path";
import { getEnvironmentData, MessageChannel, type MessagePort, Worker } from "node:worker_threads";
import type { WorkerLifecycle } from "@openclaw/worker-runtime/lifecycle";
import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import type { RuntimeWorkerGeneration } from "./runtime-worker-generation.js";
import { SQLITE_DATABASE_ADMISSIONS_KEY } from "./sqlite-database-admission-key.js";
import {
  captureSqliteDatabaseAdmissions,
  installSqliteDatabaseAdmissions,
  readSqliteDatabaseAdmissions,
  readSqliteDatabasePendingWriteToken,
  prepareSqliteDatabaseCleanClose,
  recordSqliteDatabaseIntegrity,
  readSqliteDatabaseWriteTokenForPath,
  retireSqliteDatabaseAdmissionForPath,
  retainSqliteDatabaseAdmissionLocation,
  trackSqliteDatabaseAdmissionWorker,
  withSqliteDatabaseAdmissionExchange,
} from "./sqlite-database-admission.js";
import { withSqlitePostCommitPublications } from "./sqlite-post-commit.js";
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
  "retains later worker siblings until final close or exit (retained: %s)",
  async (retained) => {
    const location = path.join(tempDirs.make("sqlite-admission-worker-retention-"), "proof.sqlite");
    const database = createDatabase(location);
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
      const siblingReply = once(siblingWorker, "message");
      siblingWorker.postMessage("read", []);
      expect((await siblingReply)[0]).toEqual({ value: 42, admissionId });
      await siblingWorker.terminate();
      siblingRelay.finish();
      sibling = undefined;
      expect(recordsFor(location)).toEqual([]);
      expect(await command("retire")).toBe("retire");
      expect(() => fstatSync(descriptor)).toThrow();

      database.open();
      admitSqliteSchema(database);
      expect(await command("open")).toEqual({
        value: 42,
        admissionId: getAdmittedSqliteSchemaFacts(database)?.admissionId,
      });
      database.close();
      expect(recordsFor(location)).toHaveLength(1);
      await worker.terminate();
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
      const retireSource = await closeSource?.();
      await retireSource?.();
    }
  },
);
