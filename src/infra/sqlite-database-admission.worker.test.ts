import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, linkSync, renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MessagePort, Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "./node-sqlite.js";
import { runWithSqliteDatabaseAdmissionTurn } from "./sqlite-database-admission-turn.js";
import {
  captureSqliteDatabaseAdmissions,
  hasPendingSqliteDatabaseSchemaMutation,
  readSqliteDatabaseAdmissions,
  prepareSqliteDatabaseWriter,
  publishSqliteDatabaseAdmission,
  readSqliteDatabaseWriteRevision,
  readSqliteDatabaseScopedWriteToken,
} from "./sqlite-database-admission.js";
import type {
  AdmissionTaskInput,
  AdmissionTaskResult,
} from "./sqlite-database-admission.task.test-support.js";
import {
  hostFactKey,
  workerFactKey,
  type AdmissionOperations,
} from "./sqlite-database-admission.worker.test-support.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "./sqlite-schema-facts.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import { createOwnedWorkerTaskPool } from "./worker-task-pool.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const moduleUrl = new URL("./sqlite-database-admission.worker.test-support.ts", import.meta.url);

it.each([undefined, 42])(
  "bootstraps complete host facts before any exchange, value=%s",
  async (value) => {
    const location = path.join(tempDirs.make("sqlite-bootstrap-host-facts-"), "shared.sqlite");
    const database = openNodeSqliteDatabase(location);
    if (value !== undefined) {
      publishSqliteDatabaseAdmission(database, hostFactKey, value);
    }
    const worker = new Worker(
      `
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const { register } = await import(workerData.loader);
      const unregister = register();
      const { openNodeSqliteDatabase } = await import(workerData.native);
      const { getSqliteDatabaseAdmission, withSqliteDatabaseAdmissionExchange } =
        await import(workerData.admission);
      const database = openNodeSqliteDatabase(workerData.location, { readOnly: true });
      const key = { name: workerData.key, writer: "host", read: (value) => value };
      let exchanges = 0;
      const facts = withSqliteDatabaseAdmissionExchange(() => {
        exchanges += 1;
        return [];
      }, () => ({
        absent: getSqliteDatabaseAdmission(database, { ...key, name: key.name + "-absent" }),
        value: getSqliteDatabaseAdmission(database, key),
      }));
      database.close();
      unregister();
      parentPort.postMessage({ ...facts, exchanges });
      parentPort.close();
    })().catch((error) => { throw error; });
  `,
      {
        eval: true,
        execArgv: [],
        workerData: {
          location,
          key: hostFactKey.name,
          loader: import.meta.resolve("tsx/esm/api"),
          native: new URL("./node-sqlite.ts", import.meta.url).href,
          admission: new URL("./sqlite-database-admission.ts", import.meta.url).href,
        },
      },
    );
    try {
      const [[facts], [code]] = await Promise.all([once(worker, "message"), once(worker, "exit")]);
      expect(code).toBe(0);
      expect(facts).toEqual({ absent: undefined, value, exchanges: 0 });
    } finally {
      await worker.terminate();
      database.close();
    }
  },
);

it("defers unknown writer and fact refresh until the worker releases its transaction", async () => {
  const location = path.join(tempDirs.make("sqlite-transaction-facts-"), "shared.sqlite");
  createDatabase(location, 1);
  const database = openNodeSqliteDatabase(location);
  admitSqliteSchema(database);
  const broker = new SqliteWorkerBroker();
  try {
    const store = await broker.open<AdmissionOperations>({
      moduleUrl,
      databasePath: location,
      input: undefined,
    });
    const result = await broker.runOperation(
      store!,
      (scope) => scope.execute({ type: "transactionFacts", input: undefined }),
      undefined,
      undefined,
      () => ({
        nativeLocations: [location],
        admission: createSqliteWorkerOperationAdmission((_request, grant) => {
          // This writer and its facts were absent from the worker's dispatch snapshot.
          prepareSqliteDatabaseWriter(database);
          publishSqliteDatabaseAdmission(database, hostFactKey, 42);
          publishSqliteDatabaseAdmission(database, workerFactKey, 43);
          grant();
        }),
      }),
    );
    expect(result).toMatchObject({
      transactionLookups: 0,
      transactionRevision: undefined,
      transactionHostFact: undefined,
      transactionWorkerFact: undefined,
      pendingSchema: true,
      transactionSchemaHasProof: true,
      outsideHostFact: 42,
      outsideWorkerFact: 43,
    });
    expect(result.outsideLookups).toBeGreaterThan(0);
    expect(result.outsideRevision).toBeTypeOf("number");
  } finally {
    database.close();
    await broker.close();
  }
});

it("joins host admission created after a worker's operation context before its first DDL", async () => {
  const root = tempDirs.make("sqlite-late-host-admission-");
  const location = path.join(root, "target.sqlite");
  createDatabase(location, 1);
  const broker = new SqliteWorkerBroker();
  let reader: ReturnType<typeof openNodeSqliteDatabase> | undefined;
  try {
    const store = await broker.open<AdmissionOperations>({
      moduleUrl,
      databasePath: path.join(root, "control.sqlite"),
      input: undefined,
    });
    expect(
      await broker.runOperation(
        store!,
        (scope) => scope.execute({ type: "mutateAfterHostAdmission", input: { path: location } }),
        undefined,
        undefined,
        () => ({
          nativeLocations: [location],
          admission: createSqliteWorkerOperationAdmission((_request, grant) => {
            reader = openNodeSqliteDatabase(location, { readOnly: true });
            admitSqliteSchema(reader);
            expect(getAdmittedSqliteSchemaFacts(reader)?.tables.has("worker_publication")).toBe(
              false,
            );
            grant();
          }),
        }),
      ),
    ).toEqual({ native: true, admitted: true });
    const observation = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
    try {
      expect(getAdmittedSqliteSchemaFacts(reader!)?.tables.has("worker_publication")).toBe(true);
      expect(observation.queries).toEqual([]);
    } finally {
      observation.restore();
    }
  } finally {
    reader?.close();
    await broker.close();
  }
});

it.each([
  { rollback: false, exit: false },
  { rollback: true, exit: false },
  { rollback: false, exit: true },
])(
  "holds schema publication across the native worker boundary, rollback=$rollback, exit=$exit",
  async ({ rollback, exit }) => {
    const location = path.join(tempDirs.make("sqlite-held-publication-"), "shared.sqlite");
    const reader = openNodeSqliteDatabase(location);
    reader.exec("PRAGMA journal_mode=WAL; CREATE TABLE original(value)");
    admitSqliteSchema(reader);
    const writeRevision = readSqliteDatabaseWriteRevision(reader);
    expect(writeRevision).toBeTypeOf("number");
    const broker = new SqliteWorkerBroker();
    let held = false;
    try {
      const store = await broker.open<AdmissionOperations>({
        moduleUrl,
        databasePath: location,
        input: undefined,
      });
      const mutation = broker.runOperation(
        store!,
        (scope) => scope.execute({ type: "mutateHeld", input: { rollback, exit } }),
        undefined,
        undefined,
        () => ({
          nativeLocations: [location],
          admission: createSqliteWorkerOperationAdmission((_request, grant) => {
            held = true;
            expect(readSqliteDatabaseWriteRevision(reader)).toBeUndefined();
            expect(hasPendingSqliteDatabaseSchemaMutation(reader)).toBe(true);
            expect(getAdmittedSqliteSchemaFacts(reader)?.tables.has("worker_publication")).toBe(
              !rollback,
            );
            const visible =
              reader
                .prepare("SELECT name FROM sqlite_schema WHERE name='worker_publication'")
                .get() !== undefined;
            expect(visible).toBe(!rollback);
            grant();
          }),
        }),
      );
      if (exit) {
        await expect(mutation).rejects.toThrow(/exit/iu);
      } else {
        await mutation;
      }
      expect(held).toBe(true);
      expect(readSqliteDatabaseWriteRevision(reader)).toBeTypeOf("number");
      expect(readSqliteDatabaseWriteRevision(reader)).not.toBe(writeRevision);
      expect(hasPendingSqliteDatabaseSchemaMutation(reader)).toBe(false);
      expect(getAdmittedSqliteSchemaFacts(reader)?.tables.has("worker_publication")).toBe(
        !rollback,
      );
    } finally {
      reader.close();
      await broker.close();
    }
  },
);

it("shares exact session receipts with existing writer isolates and fences unclassified writes", async () => {
  const location = path.join(tempDirs.make("sqlite-scoped-receipts-"), "shared.sqlite");
  const database = openNodeSqliteDatabase(location);
  database.exec("CREATE TABLE original(value)");
  admitSqliteSchema(database);
  const broker = new SqliteWorkerBroker();
  try {
    const store = await broker.open<AdmissionOperations>({
      moduleUrl,
      databasePath: location,
      input: undefined,
    });
    const first = readSqliteDatabaseScopedWriteToken(database, "first");
    const second = readSqliteDatabaseScopedWriteToken(database, "second");
    await store!.execute({
      type: "writeRows",
      input: { sql: "INSERT INTO original VALUES (2)", sessionKeys: ["second"] },
    });
    expect(readSqliteDatabaseScopedWriteToken(database, "first")).toBe(first);
    expect(readSqliteDatabaseScopedWriteToken(database, "second")).not.toBe(second);
    const secondCommitted = readSqliteDatabaseScopedWriteToken(database, "second");

    // The writer already exists when a new actor registers another dependency.
    const late = readSqliteDatabaseScopedWriteToken(database, "late");
    await store!.execute({
      type: "writeRows",
      input: { sql: "INSERT INTO original VALUES (3)", sessionKeys: ["late"] },
    });
    expect(readSqliteDatabaseScopedWriteToken(database, "late")).not.toBe(late);
    expect(readSqliteDatabaseScopedWriteToken(database, "first")).toBe(first);
    expect(readSqliteDatabaseScopedWriteToken(database, "second")).toBe(secondCommitted);

    await store!.execute({ type: "writeRows", input: { sql: "INSERT INTO original VALUES (4)" } });
    expect(readSqliteDatabaseScopedWriteToken(database, "first")).not.toBe(first);
    expect(readSqliteDatabaseScopedWriteToken(database, "second")).not.toBe(secondCommitted);
    expect(database.prepare("SELECT value FROM original ORDER BY value").all()).toEqual([
      { value: 2 },
      { value: 3 },
      { value: 4 },
    ]);
  } finally {
    database.close();
    await broker.close();
  }
});

it("keeps one shared generation when the host opens a newly created worker database before publication", async () => {
  const location = path.join(tempDirs.make("sqlite-created-generation-"), "created.sqlite");
  const broker = new SqliteWorkerBroker();
  let reader: ReturnType<typeof openNodeSqliteDatabase> | undefined;
  try {
    const store = await broker.open<AdmissionOperations>(
      {
        moduleUrl,
        databasePath: location,
        input: { hostBeforeAdmission: true },
      },
      undefined,
      undefined,
      {
        createAdmission: () => ({
          nativeLocations: [location],
          admission: createSqliteWorkerOperationAdmission((request, grant) => {
            if (request.stage === "prepare") {
              reader = openNodeSqliteDatabase(location, { readOnly: true });
            }
            grant();
          }),
        }),
      },
    );
    expect(reader).toBeDefined();
    admitSqliteSchema(reader!);
    expect(getAdmittedSqliteSchemaFacts(reader!)?.tables.has("worker_publication")).toBe(false);
    await store!.execute({ type: "mutate", input: undefined });
    expect(getAdmittedSqliteSchemaFacts(reader!)?.tables.has("worker_publication")).toBe(true);
  } finally {
    reader?.close();
    await broker.close();
  }
});

function createDatabase(location: string, value: number): void {
  const database = new DatabaseSync(location);
  try {
    database.exec("CREATE TABLE proof (value INTEGER NOT NULL)");
    database.prepare("INSERT INTO proof VALUES (?)").run(value);
  } finally {
    database.close();
  }
}

it("keeps per-operation admission replies scoped to the requested database", async () => {
  const root = tempDirs.make("sqlite-admission-fleet-");
  const location = path.join(root, "target.sqlite");
  createDatabase(location, 42);
  const broker = new SqliteWorkerBroker();
  try {
    const store = await broker.open<AdmissionOperations>({
      moduleUrl,
      databasePath: path.join(root, "control.sqlite"),
      input: undefined,
    });
    const unrelated = Array.from({ length: 3 }, (_, index) =>
      path.join(root, `unrelated-${index}.sqlite`),
    );
    for (const filename of unrelated) {
      createDatabase(filename, 0);
      const database = openNodeSqliteDatabase(filename);
      try {
        admitSqliteSchema(database);
      } finally {
        database.close();
      }
    }
    const replies: string[][] = [];
    // oxlint-disable-next-line typescript/unbound-method -- call restores the sending port below.
    const postMessage = MessagePort.prototype.postMessage;
    const post = vi.spyOn(MessagePort.prototype, "postMessage").mockImplementation(function (
      this: MessagePort,
      message: unknown,
      transferList,
    ) {
      const admissions = readSqliteDatabaseAdmissions(message);
      if (admissions) {
        replies.push(admissions.map((record) => record.location));
      }
      return postMessage.call(this, message, transferList);
    });
    try {
      const result = await broker.runOperation(
        store!,
        (scope) =>
          scope.execute({ type: "read", input: { path: location, awaitPublication: true } }),
        undefined,
        undefined,
        () => ({
          nativeLocations: [location],
          admission: createSqliteWorkerOperationAdmission((_request, grant) => {
            const database = openNodeSqliteDatabase(location);
            try {
              admitSqliteSchema(database);
            } finally {
              database.close();
            }
            grant();
          }),
        }),
      );
      expect(result.values).toEqual([42]);
      expect(result.sql).toEqual([]);
      expect(replies.flat()).toContain(location);
      expect(replies.flat().filter((filename) => unrelated.includes(filename))).toEqual([]);
    } finally {
      post.mockRestore();
    }
  } finally {
    await broker.close();
  }
});

it("publishes through a retained physical database after its original pathname is replaced", async () => {
  const root = tempDirs.make("sqlite-retained-admission-");
  const location = path.join(root, "original.sqlite");
  const retainedPath = path.join(root, "retained.sqlite");
  const replacementPath = path.join(root, "replacement.sqlite");
  createDatabase(location, 42);
  const reader = openNodeSqliteDatabase(location);
  admitSqliteSchema(reader);
  linkSync(location, retainedPath);
  const broker = new SqliteWorkerBroker();
  try {
    // The worker's own filename stays valid; only the shared admission's first pathname changes.
    const store = await broker.open<AdmissionOperations>({
      moduleUrl,
      databasePath: retainedPath,
      input: undefined,
    });
    createDatabase(replacementPath, 99);
    renameSync(replacementPath, location);
    const revision = readSqliteDatabaseWriteRevision(reader);
    expect(revision).toBeTypeOf("number");
    await store!.execute({ type: "writeRows", input: { sql: "UPDATE proof SET value=43" } });
    const updatedRevision = readSqliteDatabaseWriteRevision(reader);
    expect(updatedRevision).toBeTypeOf("number");
    expect(updatedRevision).not.toBe(revision);
    expect(reader.prepare("SELECT value FROM proof").get()).toEqual({ value: 43 });
    await store!.execute({ type: "mutate", input: undefined });
    expect(hasPendingSqliteDatabaseSchemaMutation(reader)).toBe(false);
    expect(getAdmittedSqliteSchemaFacts(reader)?.tables.has("worker_publication")).toBe(true);
    const replacement = openNodeSqliteDatabase(location, { readOnly: true });
    try {
      admitSqliteSchema(replacement);
      expect(getAdmittedSqliteSchemaFacts(replacement)?.tables.has("worker_publication")).toBe(
        false,
      );
      expect(replacement.prepare("SELECT value FROM proof").get()).toEqual({ value: 99 });
    } finally {
      replacement.close();
    }
  } finally {
    await broker.close();
    reader.close();
  }
});

it("retires joined descendant writer custody while preserving an independent sibling", async ({
  signal,
}) => {
  const root = tempDirs.make("sqlite-descendant-custody-");
  const locations = [path.join(root, "parent.sqlite"), path.join(root, "sibling.sqlite")];
  const readers = locations.map((location) => {
    const reader = openNodeSqliteDatabase(location);
    reader.exec("CREATE TABLE original(value)");
    admitSqliteSchema(reader);
    return reader;
  });
  const pools = locations.map(() =>
    createOwnedWorkerTaskPool<AdmissionTaskInput, AdmissionTaskResult>(
      {
        workerUrl: new URL("./sqlite-database-admission.task.test-support.ts", import.meta.url),
        maxWorkers: 1,
        idleTimeoutMs: 0,
      },
      { retainedTransport: true },
    ),
  );
  const gates = locations.map(
    () => new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
  );
  const held = locations.map(() => createDeferredCore());
  const abort = new AbortController();
  const tasks = pools.map((pool, index) =>
    pool.run(
      { path: locations[index], broker: true, holdMutation: gates[index]!.buffer },
      {
        signal: index === 0 ? abort.signal : undefined,
        onNotification(value) {
          expect(value).toBe("descendant-held");
          held[index]!.resolve();
        },
      },
    ),
  );
  try {
    await withinTest(
      Promise.all(
        held.map(({ promise }, index) =>
          awaitGateBeforeSettlement(promise, tasks[index]!, "Descendant did not hold its writer"),
        ),
      ),
      signal,
    );
    for (const reader of readers) {
      expect(hasPendingSqliteDatabaseSchemaMutation(reader)).toBe(true);
    }
    abort.abort(new Error("Stop parent task"));
    await expect(tasks[0]).rejects.toThrow("Stop parent task");
    await pools[0]!.close();
    expect(hasPendingSqliteDatabaseSchemaMutation(readers[0]!)).toBe(false);
    expect(getAdmittedSqliteSchemaFacts(readers[0]!)?.tables.has("worker_publication")).toBe(true);
    expect(hasPendingSqliteDatabaseSchemaMutation(readers[1]!)).toBe(true);
    Atomics.store(gates[1]!, 0, 1);
    Atomics.notify(gates[1]!, 0);
    await tasks[1];
    expect(hasPendingSqliteDatabaseSchemaMutation(readers[1]!)).toBe(false);
  } finally {
    for (const gate of gates) {
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
    }
    await Promise.all(pools.map((pool) => pool.close()));
    await Promise.allSettled(tasks);
    for (const reader of readers) {
      reader.close();
    }
  }
});

it("preserves a sibling writer's POSIX lock when an unhosted worker retires", async () => {
  const location = path.join(tempDirs.make("sqlite-unhosted-lock-"), "shared.sqlite");
  createDatabase(location, 1);
  const writer = new DatabaseSync(location);
  writer.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE");
  const worker = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const { register } = await import(workerData.loader);
      const unregister = register();
      const { openNodeSqliteDatabase } = await import(workerData.native);
      const { admitSqliteSchema } = await import(workerData.schema);
      const database = openNodeSqliteDatabase(workerData.location, { readOnly: true });
      admitSqliteSchema(database);
      database.close();
      unregister();
      parentPort.close();
    })().catch((error) => { throw error; });
  `,
    {
      eval: true,
      execArgv: [],
      workerData: {
        location,
        loader: import.meta.resolve("tsx/esm/api"),
        native: new URL("./node-sqlite.ts", import.meta.url).href,
        schema: new URL("./sqlite-schema-facts.ts", import.meta.url).href,
      },
    },
  );
  try {
    await once(worker, "exit");
    const outcome = execFileSync(
      process.execPath,
      [
        "-e",
        `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]);
      try {
        db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK");
        process.stdout.write("unlocked");
      } catch (error) {
        if ((error.errcode & 255) !== 5) throw error;
        process.stdout.write("busy");
      } finally { db.close(); }
    `,
        location,
      ],
      { encoding: "utf8" },
    );
    expect(outcome).toBe("busy");
  } finally {
    await worker.terminate();
    writer.exec("ROLLBACK");
    writer.close();
  }
});

it("shares admission published after dispatch with existing isolates and revalidates replaced files", async () => {
  const root = tempDirs.make("sqlite-admission-workers-");
  const location = path.join(root, "shared.sqlite");
  createDatabase(location, 42);
  const brokers = [new SqliteWorkerBroker(), new SqliteWorkerBroker()];
  const stores = await Promise.all(
    ["first", "second"].map(async (name, index) => {
      const databasePath = path.join(root, `${name}.sqlite`);
      createDatabase(databasePath, 0);
      return brokers[index]!.open<AdmissionOperations>({
        moduleUrl,
        databasePath,
        input: undefined,
      });
    }),
  );
  try {
    const [first, second] = stores;
    const firstRead = await brokers[0]!.runOperation(
      first!,
      (scope) => scope.execute({ type: "read", input: { path: location, awaitPublication: true } }),
      undefined,
      undefined,
      () => ({
        nativeLocations: [location],
        admission: createSqliteWorkerOperationAdmission((_request, grant) => {
          const database = openNodeSqliteDatabase(location);
          try {
            admitSqliteSchema(database);
          } finally {
            database.close();
          }
          grant();
        }),
      }),
    );
    const secondRead = await second!.execute({ type: "read", input: { path: location } });
    const reopened = await first!.execute({ type: "read", input: { path: location } });
    expect(firstRead.threadId).not.toBe(secondRead.threadId);
    for (const read of [firstRead, secondRead, reopened]) {
      expect(read.values).toEqual([42]);
      expect(read.sql).toEqual([]);
    }
    expect(
      await brokers[0]!.runOperation(
        first!,
        (scope) => scope.execute({ type: "hostFacts", input: { path: location } }),
        undefined,
        undefined,
        () => ({
          nativeLocations: [location],
          admission: createSqliteWorkerOperationAdmission((_request, grant) => {
            const database = openNodeSqliteDatabase(location);
            try {
              publishSqliteDatabaseAdmission(database, hostFactKey, 42);
            } finally {
              database.close();
            }
            grant();
          }),
        }),
      ),
    ).toEqual({ value: 42, lookupMessages: 0 });

    renameSync(location, path.join(root, "old.sqlite"));
    createDatabase(location, 43);
    const replacement = await second!.execute({ type: "read", input: { path: location } });
    expect(replacement.values).toEqual([43]);
    expect(replacement.sql.length).toBeGreaterThan(0);
    const sharedReplacement = await first!.execute({ type: "read", input: { path: location } });
    expect(sharedReplacement.values).toEqual([43]);
    expect(sharedReplacement.sql).toEqual([]);

    const replacementRecord = captureSqliteDatabaseAdmissions().findLast(
      (record) => record.location === location,
    )!;
    await second!.execute({ type: "retirePath", input: { path: location } });
    const readmitted = openNodeSqliteDatabase(location, { readOnly: true });
    const sibling = openNodeSqliteDatabase(location, { readOnly: true });
    try {
      admitSqliteSchema(readmitted);
      admitSqliteSchema(sibling);
      expect(getAdmittedSqliteSchemaFacts(sibling)?.admissionId).toBe(
        getAdmittedSqliteSchemaFacts(readmitted)?.admissionId,
      );
    } finally {
      readmitted.close();
      sibling.close();
    }
    await second!.execute({ type: "retirePath", input: { path: location } });
    expect(
      captureSqliteDatabaseAdmissions().some(
        (record) => record.identity === replacementRecord.identity,
      ),
    ).toBe(false);
  } finally {
    await Promise.all(brokers.map((broker) => broker.close()));
  }
});

it("serializes simultaneous first admissions across independent worker brokers", async () => {
  const location = path.join(tempDirs.make("sqlite-first-admission-"), "shared.sqlite");
  createDatabase(location, 1);
  const brokers = [new SqliteWorkerBroker(), new SqliteWorkerBroker()];
  try {
    const stores = await Promise.all(
      brokers.map((broker) =>
        broker.open<AdmissionOperations>({ moduleUrl, databasePath: location, input: undefined }),
      ),
    );
    const admissions = await Promise.all(
      stores.map((store) => store!.execute({ type: "admitted", input: undefined })),
    );
    expect(new Set(admissions.map((result) => result.threadId)).size).toBe(2);
    expect(admissions.filter((result) => result.sql.length > 0)).toHaveLength(1);
    expect(
      admissions.some((result) => result.sql.some((sql) => sql.includes("sqlite_schema"))),
    ).toBe(true);
  } finally {
    await Promise.all(brokers.map((broker) => broker.close()));
  }
});

it("shares facts with retained task workers across awaited host exchanges", async () => {
  const root = tempDirs.make("sqlite-admission-tasks-");
  const location = path.join(root, "shared.sqlite");
  createDatabase(location, 1);
  const pools = Array.from({ length: 2 }, () =>
    createOwnedWorkerTaskPool<AdmissionTaskInput, AdmissionTaskResult>(
      {
        workerUrl: new URL("./sqlite-database-admission.task.test-support.ts", import.meta.url),
        maxWorkers: 1,
        idleTimeoutMs: 0,
      },
      { retainedTransport: true },
    ),
  );
  try {
    const ready = await Promise.all(pools.map((pool) => pool.run({}, {})));
    expect(new Set(ready.map((result) => result.threadId)).size).toBe(2);
    const first = await pools[0]!.run(
      { path: location, awaitPublication: true },
      {
        async onRequest() {
          const database = openNodeSqliteDatabase(location);
          try {
            admitSqliteSchema(database);
          } finally {
            database.close();
          }
          return { input: undefined, timeoutMs: 300_000 };
        },
      },
    );
    const second = await pools[1]!.run({ path: location }, {});
    expect(first.sql).toEqual([]);
    expect(second.sql).toEqual([]);

    const discovered = path.join(root, "new-sibling.sqlite");
    createDatabase(discovered, 2);
    const family = runWithSqliteDatabaseAdmissionTurn(
      [],
      () => pools[0]!.run({ path: discovered }, {}),
      [root],
    );
    const exact = runWithSqliteDatabaseAdmissionTurn([discovered], () =>
      pools[1]!.run({ path: discovered }, {}),
    );
    const [firstAdmission, reused] = await Promise.all([family, exact]);
    expect(firstAdmission.sql.some((sql) => sql.includes("sqlite_schema"))).toBe(true);
    expect(reused.sql).toEqual([]);

    const nestedLocation = path.join(root, "nested.sqlite");
    createDatabase(nestedLocation, 3);
    const nested = await pools[0]!.run(
      { path: nestedLocation, nested: true, measureHostAbsence: true },
      {},
    );
    expect(nested.threadId).not.toBe(ready[0]!.threadId);
    expect(nested.sql.some((sql) => sql.includes("sqlite_schema"))).toBe(true);
    expect(nested.hostLookupMessages).toBe(0);
    const afterNested = await pools[1]!.run({ path: nestedLocation }, {});
    expect(afterNested.sql).toEqual([]);

    const missing = path.join(root, "unadmitted.sqlite");
    await expect(pools[0]!.run({ path: missing }, {})).rejects.toThrow(/host authority/);
    expect(existsSync(missing)).toBe(false);

    const nestedCreated = path.join(root, "nested-created.sqlite");
    const created = await pools[0]!.run({ path: nestedCreated, nested: true, broker: true }, {});
    expect(existsSync(nestedCreated)).toBe(true);
    expect(created.sql.some((sql) => sql.includes("sqlite_schema"))).toBe(true);
    const afterCreation = await pools[1]!.run({ path: nestedCreated }, {});
    expect(afterCreation.sql).toEqual([]);

    const captured = path.join(root, "captured.sqlite");
    const uncaptured = path.join(root, "uncaptured.sqlite");
    await expect(
      pools[0]!.run({ path: captured, nested: true, broker: true, creationPath: uncaptured }, {}),
    ).rejects.toThrow("SQLite admission facts exchange failed");
    expect(existsSync(captured)).toBe(false);
    expect(existsSync(uncaptured)).toBe(false);
  } finally {
    await Promise.all(pools.map((pool) => pool.close()));
  }
});
