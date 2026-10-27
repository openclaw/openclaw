import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  conformanceWorkerResult,
  createConformanceWorker,
} from "../database-engine/conformance.test-support.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { resolveRuntimeWorkerUrl } from "../runtime-worker-url.js";
import {
  captureSqliteDatabaseAdmissions,
  readSqliteDatabaseWriteTokenForPath,
} from "../sqlite-database-admission.js";
import { postgresLockTestEntrypoint } from "./locks-runtime.test-support.js";
import type { PostgresLockWorkerInput } from "./locks-worker.test-support.js";
import { usePostgresTestHarness } from "./postgres.test-support.js";

const { connection, client: admin, directories, prefix } = usePostgresTestHarness("locks");
type Event = "ready" | "admission" | "statement" | "read" | "done";
type Message = { event: Event; before?: string; after?: string; value?: number; error?: string };

function launch(options: Omit<PostgresLockWorkerInput, "connection" | "gates">) {
  const gates = new Int32Array(new SharedArrayBuffer(16));
  const events = {
    ready: Promise.withResolvers<Message>(),
    admission: Promise.withResolvers<Message>(),
    statement: Promise.withResolvers<Message>(),
    read: Promise.withResolvers<Message>(),
    done: Promise.withResolvers<Message>(),
  };
  const url = resolveRuntimeWorkerUrl(postgresLockTestEntrypoint);
  const worker = createConformanceWorker(
    url,
    { ...options, connection, gates: gates.buffer },
    { connection: connection! },
  );
  const fail = (error: Error) => Object.values(events).forEach((event) => event.reject(error));
  // Some events intentionally remain unobserved in the other scenario.
  for (const event of Object.values(events)) {
    void event.promise.catch(() => {});
  }
  worker.on("message", (message: Message) =>
    message.error ? fail(new Error(message.error)) : events[message.event].resolve(message),
  );
  worker.on("error", fail);
  const exited = conformanceWorkerResult<Message>(worker, "PostgreSQL regression");
  void exited.catch(() => {});
  return {
    wait: (event: Event) => events[event].promise,
    exited,
    release(index: number) {
      Atomics.store(gates, index, 1);
      Atomics.notify(gates, index);
    },
  };
}

describe.skipIf(!connection)("PostgreSQL transaction lock ordering", () => {
  const workers: ReturnType<typeof launch>[] = [];
  const anchors: ReturnType<typeof openNodeSqliteDatabase>[] = [];
  afterEach(async () => {
    await admin.query("ROLLBACK");
    await admin.query("SELECT pg_advisory_unlock_all()");
    const closing = workers.splice(0);
    for (const worker of closing) {
      for (const index of [0, 1, 2, 3]) {
        worker.release(index);
      }
    }
    await Promise.all(closing.map((worker) => worker.exited));
    for (const anchor of anchors.splice(0)) {
      anchor.close();
    }
  });

  const rows = async (sql: string) => (await admin.query(sql)).rows;
  async function lockIsFree(key: string) {
    const result = await admin.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [key],
    );
    const acquired = result.rows[0]?.acquired;
    if (acquired) {
      await admin.query("SELECT pg_advisory_unlock($1::bigint)", [key]);
    }
    return acquired;
  }

  async function fixture() {
    const storeId = randomUUID();
    const schema = `${prefix}_${storeId.replaceAll("-", "")}`;
    const databasePath = path.join(directories.make("postgres-locks-"), "anchor.sqlite");
    const anchor = openNodeSqliteDatabase(databasePath);
    // Final close revokes the shared admission; retain its owner until the workers exit.
    anchors.push(anchor);
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
    await writer.wait("ready");
    writer.release(0);
    await admin.query("COMMIT");
    await writer.wait("statement");
    // This is a live lock check while the actual statement callback is gated, not a timing guess.
    expect(await lockIsFree(identity.key)).toBe(false);
    writer.release(2);
    const committed = await writer.wait("done");
    expect(before).toBeDefined();
    expect(readSqliteDatabaseWriteTokenForPath(identity.path)).not.toBe(before);
    expect(committed.before).toBeDefined();
    expect(committed.after).not.toBe(committed.before);
    expect(await rows(`SELECT id FROM "${identity.schema}".events ORDER BY id`)).toEqual([
      { id: "first" },
      { id: "second" },
    ]);
  });

  it("admits concurrent worker writers before locking, so host admission cannot deadlock them", async () => {
    const identity = await fixture();
    const first = launch({ ...identity, mode: "worker", id: "first", holdAdmission: true });
    const second = launch({ ...identity, mode: "worker", id: "second" });
    workers.push(first, second);
    await Promise.all([first.wait("ready"), second.wait("ready")]);
    first.release(0);
    await first.wait("admission");
    const freeDuringAdmission = await lockIsFree(identity.key);
    // Old order holds the lock here. Drain it before asserting, rather than hanging on the cycle.
    if (!freeDuringAdmission) {
      first.release(1);
    }
    second.release(0);
    const secondCommit = await second.wait("done");
    const afterSecondCommit = readSqliteDatabaseWriteTokenForPath(identity.path);
    first.release(1);
    const firstCommit = await first.wait("done");
    expect(freeDuringAdmission).toBe(true);
    expect(secondCommit).toMatchObject({ before: expect.any(String), after: expect.any(String) });
    expect(secondCommit.after).not.toBe(secondCommit.before);
    expect(afterSecondCommit).toBe(secondCommit.after);
    expect(firstCommit).toMatchObject({ before: expect.any(String), after: expect.any(String) });
    expect(firstCommit.after).not.toBe(firstCommit.before);
    expect(firstCommit.after).not.toBe(secondCommit.after);
    expect(readSqliteDatabaseWriteTokenForPath(identity.path)).toBe(firstCommit.after);
    expect(await rows(`SELECT count(*)::int AS count FROM "${identity.schema}".events`)).toEqual([
      { count: 2 },
    ]);
  });

  it("locks deferred transactions before reading so concurrent increments cannot lose updates", async () => {
    const identity = await fixture();
    await admin.query(
      `CREATE TABLE "${identity.schema}".counter (value INTEGER); INSERT INTO "${identity.schema}".counter VALUES (0)`,
    );
    const first = launch({
      ...identity,
      mode: "deferred",
      id: "first",
      holdStatement: true,
      holdRead: true,
    });
    const second = launch({ ...identity, mode: "deferred", id: "second" });
    workers.push(first, second);
    await Promise.all([first.wait("ready"), second.wait("ready")]);
    first.release(0);
    await first.wait("statement");
    const lockedBeforeRead = (await lockIsFree(identity.key)) === false;
    first.release(2);
    const firstRead = await first.wait("read");
    second.release(0);
    await second.wait("admission");
    first.release(3);
    await Promise.all([first.wait("done"), second.wait("done")]);
    expect(lockedBeforeRead).toBe(true);
    expect(firstRead.value).toBe(0);
    expect((await second.wait("read")).value).toBe(1);
    expect(await rows(`SELECT value FROM "${identity.schema}".counter`)).toEqual([{ value: 2 }]);
  });
});
