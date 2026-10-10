import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "./node-sqlite.js";
import { runWithSqliteDatabaseAdmissionTurn } from "./sqlite-database-admission-turn.js";
import { hasPendingSqliteDatabaseSchemaMutation } from "./sqlite-database-admission.js";
import type {
  AdmissionTaskInput,
  AdmissionTaskResult,
} from "./sqlite-database-admission.task.test-support.js";
import type { AdmissionOperations } from "./sqlite-database-admission.worker.test-support.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "./sqlite-schema-facts.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import { createOwnedWorkerTaskPool } from "./worker-task-pool.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const moduleUrl = new URL("./sqlite-database-admission.worker.test-support.ts", import.meta.url);

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

    renameSync(location, path.join(root, "old.sqlite"));
    createDatabase(location, 43);
    const replacement = await second!.execute({ type: "read", input: { path: location } });
    expect(replacement.values).toEqual([43]);
    expect(replacement.sql.length).toBeGreaterThan(0);
    const sharedReplacement = await first!.execute({ type: "read", input: { path: location } });
    expect(sharedReplacement.values).toEqual([43]);
    expect(sharedReplacement.sql).toEqual([]);
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

    const outerLocation = path.join(root, "family-outer.sqlite");
    const callbackLocation = path.join(root, "family-callback.sqlite");
    createDatabase(outerLocation, 4);
    createDatabase(callbackLocation, 5);
    const firstChildQueued = createDeferredCore();
    const continueCallback = createDeferredCore();
    const nestedRead = () =>
      runWithSqliteDatabaseAdmissionTurn([callbackLocation], () =>
        pools[1]!.run({ path: callbackLocation }, {}),
      );
    const outer = runWithSqliteDatabaseAdmissionTurn([outerLocation], () =>
      pools[0]!.run(
        { path: outerLocation, awaitPublication: true },
        {
          async onRequest() {
            const firstChild = nestedRead();
            firstChildQueued.resolve();
            await continueCallback.promise;
            const secondChild = nestedRead();
            const [admitted, borrowed] = await Promise.all([firstChild, secondChild]);
            expect(admitted.sql.some((sql) => sql.includes("sqlite_schema"))).toBe(true);
            expect(borrowed.sql).toEqual([]);
            return { input: undefined, timeoutMs: 300_000 };
          },
        },
      ),
    );
    const queued = nestedRead();
    await firstChildQueued.promise;
    const laterQueued = nestedRead();
    continueCallback.resolve();
    const [, firstFollower, secondFollower] = await Promise.all([outer, queued, laterQueued]);
    expect(firstFollower.sql).toEqual([]);
    expect(secondFollower.sql).toEqual([]);

    const nestedLocation = path.join(root, "nested.sqlite");
    createDatabase(nestedLocation, 3);
    const nested = await pools[0]!.run({ path: nestedLocation, nested: true }, {});
    expect(nested.threadId).not.toBe(ready[0]!.threadId);
    expect(nested.sql.some((sql) => sql.includes("sqlite_schema"))).toBe(true);
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
