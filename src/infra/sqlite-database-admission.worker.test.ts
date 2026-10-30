import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, linkSync, renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MessagePort, Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runWithSqliteDatabaseAdmissionTurn } from "./sqlite-database-admission-turn.js";
import {
  captureSqliteDatabaseAdmissions,
  hasPendingSqliteDatabaseSchemaMutation,
  readSqliteDatabaseAdmissions,
  readSqliteDatabaseWriteRevision,
  readSqliteDatabaseScopedWriteToken,
  retireSqliteDatabaseWriteScopes,
  publishSqliteDatabaseAdmission,
  getSqliteDatabaseAdmission,
} from "./sqlite-database-admission.js";
import type {
  AdmissionTaskInput,
  AdmissionTaskResult,
} from "./sqlite-database-admission.task.test-support.js";
import {
  hostFactKey,
  type AdmissionOperations,
} from "./sqlite-database-admission.worker.test-support.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "./sqlite-schema-facts.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import type { SqliteWorkerReply } from "./sqlite-worker-contract.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import { createOwnedWorkerTaskPool } from "./worker-task-pool.js";

const ownedBrokers: SqliteWorkerBroker[] = [];
const databases: DatabaseSync[] = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await Promise.all(ownedBrokers.splice(0).map((broker) => broker.close()));
    } finally {
      for (const database of databases.splice(0)) {
        if (database.isOpen) {
          database.close();
        }
      }
      cleanup();
    }
  }),
);
const moduleUrl = new URL("./sqlite-database-admission.worker.test-support.ts", import.meta.url);

function createBroker() {
  const broker = new SqliteWorkerBroker();
  ownedBrokers.push(broker);
  return broker;
}

function openDatabase(...args: Parameters<typeof openNodeSqliteDatabase>) {
  const database = openNodeSqliteDatabase(...args);
  databases.push(database);
  return database;
}

function openStore(broker: SqliteWorkerBroker, databasePath: string) {
  return broker.open<AdmissionOperations>({ moduleUrl, databasePath, input: undefined });
}

function createTaskPool(retainedTransport = false) {
  return createOwnedWorkerTaskPool<AdmissionTaskInput, AdmissionTaskResult>(
    {
      workerUrl: new URL("./sqlite-database-admission.task.test-support.ts", import.meta.url),
      maxWorkers: 1,
      idleTimeoutMs: 0,
    },
    retainedTransport ? { retainedTransport: true } : undefined,
  );
}

function hostAdmission(
  location: string,
  admit: Parameters<typeof createSqliteWorkerOperationAdmission>[0],
) {
  return () => ({
    nativeLocations: [location],
    admission: createSqliteWorkerOperationAdmission(admit),
  });
}

function readerWorker(location: string, program: string) {
  return new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const { register } = await import(workerData.loader);
      const unregister = register();
      const { openNodeSqliteDatabase } = await import(workerData.native);
      ${program}
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
        schema: new URL("./sqlite-schema-facts.ts", import.meta.url).href,
      },
    },
  );
}

it("settles worker facts through admission without echoing snapshots in ordinary replies", async () => {
  const location = path.join(tempDirs.make("sqlite-admission-reply-"), "shared.sqlite");
  const database = openDatabase(location);
  const broker = createBroker();
  const replies: SqliteWorkerReply[] = [];
  const workerFact = { ...hostFactKey, name: "admission-test-worker-value" };
  let factAtReply: number | undefined;
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply preserves the emitting worker.
  const originalEmit = Worker.prototype.emit;
  vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
    this: Worker,
    event: string | symbol,
    reply: SqliteWorkerReply,
  ) {
    if (event === "message" && reply.ok) {
      replies.push(reply);
      factAtReply = getSqliteDatabaseAdmission(database, workerFact);
    }
    return Reflect.apply(originalEmit, this, [event, reply]);
  });
  const store = await openStore(broker, location);
  publishSqliteDatabaseAdmission(database, hostFactKey, 1);
  await store!.execute({ type: "admitted", input: { measureHostAbsence: true } });
  // The host receives the new worker fact before the broker sees the ordinary reply.
  expect(factAtReply).toBe(1);
  await store!.close();
  for (const reply of replies) {
    expect(reply).not.toHaveProperty("databaseAdmissions");
  }
});

it("bootstraps complete host facts before any exchange", async () => {
  const location = path.join(tempDirs.make("sqlite-bootstrap-host-facts-"), "shared.sqlite");
  const database = openDatabase(location);
  publishSqliteDatabaseAdmission(database, hostFactKey, 42);
  const worker = readerWorker(
    location,
    `
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
  `,
  );
  try {
    const [[facts], [code]] = await Promise.all([once(worker, "message"), once(worker, "exit")]);
    expect(code).toBe(0);
    expect(facts).toEqual({ absent: undefined, value: 42, exchanges: 0 });
  } finally {
    await worker.terminate();
  }
});

it("joins host admission created after a worker's operation context before its first DDL", async () => {
  const root = tempDirs.make("sqlite-late-host-admission-");
  const location = path.join(root, "target.sqlite");
  createDatabase(location, 1);
  const broker = createBroker();
  let reader: ReturnType<typeof openNodeSqliteDatabase> | undefined;

  const store = await openStore(broker, path.join(root, "control.sqlite"));
  expect(
    await broker.runOperation(
      store!,
      (scope) => scope.execute({ type: "mutateAfterHostAdmission", input: { path: location } }),
      undefined,
      undefined,
      hostAdmission(location, (_request, grant) => {
        reader = openDatabase(location, { readOnly: true });
        admitSqliteSchema(reader);
        expect(getAdmittedSqliteSchemaFacts(reader)?.tables.has("worker_publication")).toBe(false);
        grant();
      }),
    ),
  ).toEqual({ native: true, admitted: true });
  expect(getAdmittedSqliteSchemaFacts(reader!)?.tables.has("worker_publication")).toBe(true);
});

it("settles scoped writes without host metadata round trips after peer registrations", async () => {
  const location = path.join(tempDirs.make("sqlite-scoped-receipts-"), "shared.sqlite");
  const database = openDatabase(location);
  database.exec("CREATE TABLE original(value)");
  admitSqliteSchema(database);
  const broker = createBroker();
  const token = (key: string) => readSqliteDatabaseScopedWriteToken(database, key);

  const store = await openStore(broker, location);
  const predecessor = store!.execute({ type: "admitted", input: undefined });
  let first = token("first");
  const second = token("second");
  let current = true;
  const refused = new Error("Queued scope lost authority");
  const rejected = broker.runOperation(
    store!,
    (scope) =>
      scope.execute({ type: "writeRows", input: { sql: "INSERT INTO original VALUES (-1)" } }),
    undefined,
    () => {
      if (!current) {
        throw refused;
      }
    },
  );
  current = false;
  const outcomes = await Promise.allSettled([predecessor, rejected]);
  expect(outcomes[0]!.status).toBe("fulfilled");
  expect(outcomes[1]).toEqual({ status: "rejected", reason: refused });
  // A new publication must not acknowledge scopes captured by a refused dispatch.
  token("after-rejection");
  await store!.execute({
    type: "writeRows",
    input: { sql: "INSERT INTO original VALUES (2)", sessionKeys: ["second"] },
  });
  expect(token("first")).toBe(first);
  expect(token("second")).not.toBe(second);
  let secondCommitted = token("second");

  const writeAfterPublication = async (
    value: number,
    sessionKey: string,
    publish: () => string | undefined,
  ) => {
    let published: string | undefined;
    const result = await broker.runOperation(
      store!,
      (scope) =>
        scope.execute({
          type: "writeRows",
          input: {
            sql: `INSERT INTO original VALUES (${value})`,
            sessionKeys: [sessionKey],
            awaitPublication: true,
          },
        }),
      undefined,
      undefined,
      hostAdmission(location, (request, grant) => {
        if (request.stage === "transaction") {
          published = publish();
        }
        grant();
      }),
    );
    expect(result).toEqual({ lookupMessages: 0 });
    expect(published).toBeTypeOf("string");
    return published;
  };

  // Publish after dispatch so the accepted writer cannot already have the new scope.
  const late = await writeAfterPublication(3, "late", () => token("late"));
  expect(token("late")).not.toBe(late);
  expect(token("first")).not.toBe(first);
  expect(token("second")).not.toBe(secondCommitted);
  first = token("first");
  secondCommitted = token("second");

  // A new unrelated scope does not prevent a known shared cell from settling exactly.
  const unrelated = await writeAfterPublication(5, "second", () => token("unrelated"));
  expect(token("unrelated")).toBe(unrelated);
  expect(token("first")).toBe(first);
  expect(token("second")).not.toBe(secondCommitted);

  const retired = await writeAfterPublication(7, "second", () => {
    retireSqliteDatabaseWriteScopes(database, ["second"]);
    return token("second");
  });
  expect(token("second")).not.toBe(retired);
  first = token("first");

  // Pressure evicts the writer's cell; settlement must invalidate its replacement too.
  const replacement = await writeAfterPublication(6, "second", () => {
    for (let index = 0; index < 160; index++) {
      token(`${index}:${"x".repeat(4096)}`);
    }
    return token("second");
  });
  expect(token("second")).not.toBe(replacement);
  expect(token("first")).not.toBe(first);
  first = token("first");
  secondCommitted = token("second");

  await store!.execute({ type: "writeRows", input: { sql: "INSERT INTO original VALUES (4)" } });
  expect(token("first")).not.toBe(first);
  expect(token("second")).not.toBe(secondCommitted);
  expect(database.prepare("SELECT value FROM original ORDER BY value").all()).toEqual([
    { value: 2 },
    { value: 3 },
    { value: 4 },
    { value: 5 },
    { value: 6 },
    { value: 7 },
  ]);
});
it("keeps one shared generation when the host opens a newly created worker database before publication", async () => {
  const location = path.join(tempDirs.make("sqlite-created-generation-"), "created.sqlite");
  const broker = createBroker();
  let reader: ReturnType<typeof openNodeSqliteDatabase> | undefined;

  const store = await broker.open<AdmissionOperations>(
    {
      moduleUrl,
      databasePath: location,
      input: { hostBeforeAdmission: true },
    },
    undefined,
    undefined,
    {
      createAdmission: hostAdmission(location, (request, grant) => {
        if (request.stage === "prepare") {
          reader = openDatabase(location, { readOnly: true });
        }
        grant();
      }),
    },
  );
  expect(reader).toBeDefined();
  admitSqliteSchema(reader!);
  expect(getAdmittedSqliteSchemaFacts(reader!)?.tables.has("worker_publication")).toBe(false);
  await store!.execute({ type: "mutate", input: undefined });
  expect(getAdmittedSqliteSchemaFacts(reader!)?.tables.has("worker_publication")).toBe(true);
});

function createDatabase(location: string, value: number): void {
  using database = new DatabaseSync(location);
  database.exec("CREATE TABLE proof (value INTEGER NOT NULL)");
  database.prepare("INSERT INTO proof VALUES (?)").run(value);
}

it("publishes through a retained physical database after its original pathname is replaced", async () => {
  const root = tempDirs.make("sqlite-retained-admission-");
  const location = path.join(root, "original.sqlite");
  const retainedPath = path.join(root, "retained.sqlite");
  const replacementPath = path.join(root, "replacement.sqlite");
  createDatabase(location, 42);
  const reader = openDatabase(location);
  admitSqliteSchema(reader);
  linkSync(location, retainedPath);
  const broker = createBroker();

  // The worker's own filename stays valid; only the shared admission's first pathname changes.
  const store = await openStore(broker, retainedPath);
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
  using replacement = openDatabase(location, { readOnly: true });
  admitSqliteSchema(replacement);
  expect(getAdmittedSqliteSchemaFacts(replacement)?.tables.has("worker_publication")).toBe(false);
  expect(replacement.prepare("SELECT value FROM proof").get()).toEqual({ value: 99 });
});
it("preserves a sibling writer's POSIX lock when an unhosted worker retires", async () => {
  const location = path.join(tempDirs.make("sqlite-unhosted-lock-"), "shared.sqlite");
  createDatabase(location, 1);
  const writer = new DatabaseSync(location);
  writer.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE");
  const worker = readerWorker(
    location,
    `
      const { admitSqliteSchema } = await import(workerData.schema);
      const database = openNodeSqliteDatabase(workerData.location, { readOnly: true });
      admitSqliteSchema(database);
      database.close();
      unregister();
  `,
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

it("scopes admission replies to one database, shares them across isolates, and revalidates replacements", async () => {
  const root = tempDirs.make("sqlite-admission-workers-");
  const location = path.join(root, "shared.sqlite");
  createDatabase(location, 42);
  const brokers = [createBroker(), createBroker()];
  const stores = await Promise.all(
    ["first", "second"].map(async (name, index) => {
      const databasePath = path.join(root, `${name}.sqlite`);
      createDatabase(databasePath, 0);
      return openStore(brokers[index]!, databasePath);
    }),
  );

  const [first, second] = stores;
  const unrelated = path.join(root, "unrelated.sqlite");
  createDatabase(unrelated, 0);
  admitSqliteSchema(openDatabase(unrelated));
  const replies: string[][] = [];
  // oxlint-disable-next-line typescript/unbound-method -- call retains the sending port.
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
  const firstRead = await brokers[0]!.runOperation(
    first!,
    (scope) => scope.execute({ type: "read", input: { path: location, awaitPublication: true } }),
    undefined,
    undefined,
    hostAdmission(location, (_request, grant) => {
      const database = openDatabase(location);
      admitSqliteSchema(database);
      grant();
    }),
  );
  post.mockRestore();
  expect(replies.flat()).toContain(location);
  expect(replies.flat()).not.toContain(unrelated);
  const secondRead = await second!.execute({ type: "read", input: { path: location } });
  expect(firstRead.threadId).not.toBe(secondRead.threadId);
  for (const read of [firstRead, secondRead]) {
    expect(read).toMatchObject({ values: [42], sql: [] });
  }
  expect(
    await brokers[0]!.runOperation(
      first!,
      (scope) => scope.execute({ type: "hostFacts", input: { path: location } }),
      undefined,
      undefined,
      hostAdmission(location, (_request, grant) => {
        const database = openDatabase(location);

        publishSqliteDatabaseAdmission(database, hostFactKey, 42);

        grant();
      }),
    ),
  ).toEqual({ value: 42, lookupMessages: 0 });

  renameSync(location, path.join(root, "old.sqlite"));
  createDatabase(location, 43);
  const replacement = await second!.execute({ type: "read", input: { path: location } });
  expect(replacement.values).toEqual([43]);
  expect(replacement.sql.length).toBeGreaterThan(0);
  const sharedReplacement = await first!.execute({ type: "read", input: { path: location } });
  expect(sharedReplacement).toMatchObject({ values: [43], sql: [] });

  const holder = openDatabase(location);
  admitSqliteSchema(holder);
  const replacementRecord = captureSqliteDatabaseAdmissions().findLast(
    (record) => record.location === location,
  )!;
  holder.close();
  await second!.execute({ type: "retirePath", input: { path: location } });
  {
    using readmitted = openDatabase(location, { readOnly: true });
    using sibling = openDatabase(location, { readOnly: true });
    admitSqliteSchema(readmitted);
    admitSqliteSchema(sibling);
    expect(getAdmittedSqliteSchemaFacts(sibling)?.admissionId).toBe(
      getAdmittedSqliteSchemaFacts(readmitted)?.admissionId,
    );
  }
  await second!.execute({ type: "retirePath", input: { path: location } });
  expect(
    captureSqliteDatabaseAdmissions().some(
      (record) => record.identity === replacementRecord.identity,
    ),
  ).toBe(false);
});

it("serializes simultaneous first admissions across independent worker brokers", async () => {
  const location = path.join(tempDirs.make("sqlite-first-admission-"), "shared.sqlite");
  createDatabase(location, 1);
  const brokers = [createBroker(), createBroker()];

  const stores = await Promise.all(brokers.map((broker) => openStore(broker, location)));
  const admissions = await Promise.all(
    stores.map((store) => store!.execute({ type: "admitted", input: undefined })),
  );
  expect(new Set(admissions.map((result) => result.threadId)).size).toBe(2);
  expect(admissions.filter((result) => result.sql.length > 0)).toHaveLength(1);
  expect(admissions.some((result) => result.sql.some((sql) => sql.includes("sqlite_schema")))).toBe(
    true,
  );
});

it("shares facts with retained task workers across awaited host exchanges", async () => {
  const root = tempDirs.make("sqlite-admission-tasks-");
  const location = path.join(root, "shared.sqlite");
  createDatabase(location, 1);
  const pools = Array.from({ length: 2 }, () => createTaskPool(true));
  try {
    const ready = await Promise.all(pools.map((pool) => pool.run({}, {})));
    expect(new Set(ready.map((result) => result.threadId)).size).toBe(2);
    const first = await pools[0]!.run(
      { path: location, awaitPublication: true },
      {
        async onRequest() {
          admitSqliteSchema(openDatabase(location));
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

it("keeps 5,000 task messages bounded while unrelated session receipts change", async () => {
  const location = path.join(tempDirs.make("sqlite-task-payload-"), "unrelated.sqlite");
  const database = openDatabase(location);
  const pool = createTaskPool();
  let taskMessages = 0;
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply preserves the actual worker receiver.
  const postMessage = Worker.prototype.postMessage;
  const messages = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    ...args: Parameters<Worker["postMessage"]>
  ) {
    const message: unknown = args[0];
    if (typeof message === "object" && message !== null && "taskId" in message) {
      const payload = JSON.stringify(message, (_key, value: unknown) =>
        value instanceof Map || value instanceof Set
          ? [...value]
          : value instanceof SharedArrayBuffer
            ? [...new Uint8Array(value)]
            : value,
      );
      expect(Buffer.byteLength(payload)).toBeLessThan(16 * 1024);
      taskMessages += 1;
    }
    Reflect.apply(postMessage, this, args);
  });
  try {
    readSqliteDatabaseScopedWriteToken(
      database,
      Array.from({ length: 5_000 }, (_, index) => `session-${index}`),
    );
    for (let index = 0; index < 5_000; index += 1) {
      publishSqliteDatabaseAdmission(database, hostFactKey, index);
      await pool.run({}, {});
    }
    expect(taskMessages).toBe(5_000);
  } finally {
    messages.mockRestore();
    await pool.close();
  }
});
