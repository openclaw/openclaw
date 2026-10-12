import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { getEnvironmentData, Worker } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import {
  resolveRuntimeWorkerThreadExecArgv,
  resolveRuntimeWorkerUrl,
} from "../runtime-worker-url.js";
import {
  captureSqliteDatabaseAdmissions,
  readSqliteDatabaseWriteTokenForPath,
  type SqliteDatabaseAdmissions,
} from "../sqlite-database-admission.js";
import { postgresLockTestEntrypoint } from "./locks-runtime.test-support.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type Event = "ready" | "admission" | "statement" | "done";
type Message = { event: Event; before?: string; after?: string; error?: string };

function launch(options: {
  path: string;
  schema: string;
  storeId: string;
  id: string;
  mode: "single" | "worker";
  admissions: SqliteDatabaseAdmissions;
  holdAdmission?: boolean;
  holdStatement?: boolean;
}) {
  const gates = new Int32Array(new SharedArrayBuffer(12));
  const events = {
    ready: Promise.withResolvers<Message>(),
    admission: Promise.withResolvers<Message>(),
    statement: Promise.withResolvers<Message>(),
    done: Promise.withResolvers<Message>(),
  };
  const url = resolveRuntimeWorkerUrl(postgresLockTestEntrypoint);
  const worker = new Worker(url, {
    execArgv: resolveRuntimeWorkerThreadExecArgv(url),
    workerData: { ...options, connection, gates: gates.buffer },
  });
  const fail = (error: Error) => {
    for (const event of Object.values(events)) {
      event.reject(error);
    }
  };
  // Some events intentionally remain unobserved in the other scenario.
  for (const event of Object.values(events)) {
    void event.promise.catch(() => {});
  }
  worker.on("message", (message: Message) => {
    if (message.error) {
      fail(new Error(message.error));
    } else {
      events[message.event].resolve(message);
    }
  });
  worker.on("error", fail);
  const exited = new Promise<void>((resolve, reject) => {
    worker.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`PostgreSQL regression worker exited ${code}`));
      }
    });
  });
  void exited.catch(() => {});
  return {
    events,
    exited,
    release(index: number) {
      Atomics.store(gates, index, 1);
      Atomics.notify(gates, index);
    },
  };
}

describe.skipIf(!connection)("PostgreSQL transaction lock ordering", () => {
  const admin = new Client({ connectionString: connection });
  const workers: ReturnType<typeof launch>[] = [];
  const schemas: string[] = [];
  beforeAll(async () => {
    await admin.connect();
  });
  afterEach(async () => {
    await admin.query("ROLLBACK");
    await admin.query("SELECT pg_advisory_unlock_all()");
    const closing = workers.splice(0);
    for (const worker of closing) {
      for (const index of [0, 1, 2]) {
        worker.release(index);
      }
    }
    await Promise.all(closing.map((worker) => worker.exited));
    for (const schema of schemas.splice(0)) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });
  afterAll(async () => {
    await admin.end();
  });

  async function fixture() {
    const storeId = randomUUID();
    const schema = `openclaw_lock_test_${storeId.replaceAll("-", "")}`;
    schemas.push(schema);
    const databasePath = path.join(tempDirs.make("postgres-locks-"), "anchor.sqlite");
    using anchor = openNodeSqliteDatabase(databasePath);
    anchor.exec("CREATE TABLE anchor (id TEXT)");
    await admin.query(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".events (id TEXT)`);
    return {
      path: databasePath,
      schema,
      storeId,
      admissions: captureSqliteDatabaseAdmissions(undefined, { location: databasePath }),
      key: createHash("sha256").update(storeId).digest().readBigInt64BE().toString(),
    };
  }

  it("envelopes a single statement with the store lock and advances its anchor token", async () => {
    const identity = await fixture();
    await admin.query("BEGIN");
    await admin.query("SELECT pg_advisory_xact_lock($1::bigint)", [identity.key]);
    await admin.query(`INSERT INTO "${identity.schema}".events VALUES ('first')`);
    const before = readSqliteDatabaseWriteTokenForPath(identity.path);
    const writer = launch({ ...identity, mode: "single", id: "second", holdStatement: true });
    workers.push(writer);
    await writer.events.ready.promise;
    writer.release(0);
    await admin.query("COMMIT");
    await writer.events.statement.promise;
    // This is a live lock check while the actual statement callback is gated, not a timing guess.
    const lock = await admin.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [identity.key],
    );
    expect(lock.rows[0]?.acquired).toBe(false);
    writer.release(2);
    const committed = await writer.events.done.promise;
    expect(before).toBeDefined();
    expect(readSqliteDatabaseWriteTokenForPath(identity.path)).not.toBe(before);
    expect(committed.before).toBeDefined();
    expect(committed.after).not.toBe(committed.before);
    expect(
      (await admin.query(`SELECT id FROM "${identity.schema}".events ORDER BY id`)).rows,
    ).toEqual([{ id: "first" }, { id: "second" }]);
  });

  it("admits concurrent worker writers before locking, so host admission cannot deadlock them", async () => {
    const identity = await fixture();
    const first = launch({ ...identity, mode: "worker", id: "first", holdAdmission: true });
    const second = launch({ ...identity, mode: "worker", id: "second" });
    workers.push(first, second);
    await Promise.all([first.events.ready.promise, second.events.ready.promise]);
    first.release(0);
    await first.events.admission.promise;
    const lock = await admin.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [identity.key],
    );
    const freeDuringAdmission = lock.rows[0]?.acquired === true;
    if (freeDuringAdmission) {
      await admin.query("SELECT pg_advisory_unlock($1::bigint)", [identity.key]);
    }
    // Old order holds the lock here. Drain it before asserting, rather than hanging on the cycle.
    if (!freeDuringAdmission) {
      first.release(1);
    }
    second.release(0);
    const secondCommit = await second.events.done.promise;
    first.release(1);
    const firstCommit = await first.events.done.promise;
    expect(freeDuringAdmission).toBe(true);
    expect(secondCommit.after).not.toBe(secondCommit.before);
    expect(firstCommit.after).not.toBe(firstCommit.before);
    expect(
      (await admin.query(`SELECT count(*)::int AS count FROM "${identity.schema}".events`)).rows,
    ).toEqual([{ count: 2 }]);
  });
});
