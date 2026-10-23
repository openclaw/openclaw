import { randomUUID } from "node:crypto";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { spawnConformanceWorker } from "./conformance.test-support.js";
import {
  multiNamespaceEntrypoint,
  type NamespaceCommand,
  type NamespaceIdentity,
} from "./multi-namespace.test-support.js";
import { pgSearchName } from "./postgres-search-schema.js";
import { withPostgresConnection } from "./postgres-store-metadata.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterAll);

function launch(prefix: string, dsn = connection) {
  const databasePath = path.join(dirs.make("pg-multi-namespace-"), "anchor.sqlite");
  const gates = new Int32Array(new SharedArrayBuffer(8));
  const events = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>();
  for (const name of ["booting", "ready", "holding"]) {
    events.set(name, Promise.withResolvers());
  }
  const { anchor, worker } = spawnConformanceWorker(multiNamespaceEntrypoint, databasePath, {
    connection: dsn,
    prefix,
    path: databasePath,
    gates: gates.buffer,
  });
  worker.on("message", (message: { event: string; result?: unknown; error?: string }) => {
    const pending = events.get(message.event)!;
    if (message.error) {
      pending.reject(new Error(message.error));
    } else {
      pending.resolve(message.result);
    }
  });
  worker.on("error", (error) => {
    for (const pending of events.values()) {
      pending.reject(error);
    }
  });
  for (const pending of events.values()) {
    void pending.promise.catch(() => {});
  }
  const exited = Promise.withResolvers<void>();
  worker.on("exit", (code) => {
    anchor.close();
    if (code) {
      exited.reject(new Error(`Namespace worker exited ${code}`));
    } else {
      exited.resolve();
    }
  });
  void exited.promise.catch(() => {});
  return {
    exited: exited.promise,
    event: (name: string) => events.get(name)!.promise,
    release(index: number) {
      Atomics.store(gates, index, 1);
      Atomics.notify(gates, index);
    },
    run(command: NamespaceCommand) {
      const pending = Promise.withResolvers<unknown>();
      events.set("done", pending);
      worker.postMessage(command, []);
      return pending.promise;
    },
  };
}

describe.skipIf(!connection)("independent PostgreSQL installation namespaces", () => {
  const admin = new Client({ connectionString: connection });
  const workers: ReturnType<typeof launch>[] = [];
  const identities: NamespaceIdentity[] = [];
  const separateDatabase = `pgprep_isolation_${randomUUID().replaceAll("-", "")}`;
  const rows = async (sql: string, values?: unknown[]) => (await admin.query(sql, values)).rows;
  let databaseCreated = false;
  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${pgSearchName(separateDatabase)}`);
    databaseCreated = true;
    const separateDsn = new URL(connection!);
    separateDsn.pathname = `/${separateDatabase}`;
    await withPostgresConnection(
      { connection: separateDsn.href, schemaPrefix: "installation_a" },
      async (setup) => {
        await setup.query(
          "CREATE EXTENSION unaccent WITH SCHEMA public; CREATE EXTENSION pg_trgm WITH SCHEMA public; CREATE EXTENSION vector WITH SCHEMA public",
        );
      },
    );
    workers.push(launch("installation_a"), launch("installation_b"));
    workers.push(launch("installation_a", separateDsn.href));
    await Promise.all(workers.map((worker) => worker.event("booting")));
    workers.forEach((worker) => worker.release(0));
    identities.push(
      ...(await Promise.all(
        workers.map(async (worker) => (await worker.event("ready")) as NamespaceIdentity),
      )),
    );
  });
  afterAll(async () => {
    for (const worker of workers) {
      worker.release(0);
      worker.release(1);
      await worker.run({ op: "close" });
      await worker.exited;
    }
    for (const { namespace } of identities.slice(0, 2)) {
      await admin.query(`DROP SCHEMA ${pgSearchName(namespace)} CASCADE`);
    }
    if (databaseCreated) {
      await admin.query(`DROP DATABASE ${pgSearchName(separateDatabase)}`);
    }
    await admin.end();
  });

  it("boots distinct identities concurrently and holds independent writer locks without waiting", async () => {
    const [a, b] = identities;
    const writers = workers.slice(0, 2);
    expect(a!.storeId).not.toBe(b!.storeId);
    expect(a!.namespace).toMatch(/^installation_a_isolation_/);
    expect(b!.namespace).toMatch(/^installation_b_isolation_/);
    const seals = await rows(
      `SELECT ddl_hash FROM ${pgSearchName(a!.namespace)}.openclaw_schema_meta
       UNION SELECT ddl_hash FROM ${pgSearchName(b!.namespace)}.openclaw_schema_meta`,
    );
    expect(seals).toHaveLength(1);
    const writes = writers.map((worker, i) =>
      worker.run({ op: "write", id: "same-id", text: i ? "café beta" : "café alpha", hold: true }),
    );
    await Promise.all(writers.map((worker) => worker.event("holding")));
    const locks = await rows(
      "SELECT pid, classid::text, objid::text, granted FROM pg_locks WHERE locktype = 'advisory' AND pid = ANY($1::int[]) ORDER BY pid",
      [identities.slice(0, 2).map(({ pid }) => pid)],
    );
    expect(locks).toHaveLength(2);
    expect(locks.every((row) => row.granted)).toBe(true);
    expect(new Set(locks.map((row) => `${row.classid}:${row.objid}`)).size).toBe(2);
    writers.forEach((worker) => worker.release(1));
    await Promise.all(writes);
    for (const worker of [workers[1]!, workers[0]!]) {
      await worker.run({ op: "write", id: "second-id", text: "café second" });
    }
  });

  it("shares public extensions while isolating full text, generated columns and vector projections", async () => {
    for (const [i, worker] of workers.slice(0, 2).entries()) {
      expect(await worker.run({ op: "search", text: "cafe", withoutSearchPath: true })).toEqual([
        { id: "same-id", snippet: i ? "café beta" : "café alpha" },
        { id: "second-id", snippet: "café second" },
      ]);
      const namespace = identities[i]!.namespace;
      expect(
        await rows(
          `SELECT id, embedding::text FROM ${pgSearchName(namespace)}.vectors ORDER BY id`,
        ),
      ).toEqual([
        { id: "same-id", embedding: "[1,0,0]" },
        { id: "second-id", embedding: "[1,0,0]" },
      ]);
      const dependency = await rows(
        `SELECT n.nspname FROM pg_depend d JOIN pg_attrdef a ON a.oid = d.objid
         JOIN pg_ts_config c ON c.oid = d.refobjid JOIN pg_namespace n ON n.oid = c.cfgnamespace
         WHERE d.classid = 'pg_attrdef'::regclass AND d.refclassid = 'pg_ts_config'::regclass
         AND a.adrelid = $1::regclass`,
        [`${namespace}.notes`],
      );
      expect(dependency).toEqual([{ nspname: namespace }]);
    }
  });

  it("isolates concurrent installations in separate databases on the same server", async () => {
    expect(identities[2]!.database).toBe(separateDatabase);
    expect(identities[0]!.database).not.toBe(separateDatabase);
    const installations = [workers[0]!, workers[2]!];
    await Promise.all(
      installations.map((worker, i) =>
        worker.run({
          op: "write",
          id: "database-note",
          text: i ? "databasebeta café" : "databasealpha café",
        }),
      ),
    );
    for (const [i, worker] of installations.entries()) {
      const own = i ? "databasebeta" : "databasealpha";
      const other = i ? "databasealpha" : "databasebeta";
      expect(await worker.run({ op: "search", text: own, withoutSearchPath: true })).toEqual([
        { id: "database-note", snippet: `${own} café` },
      ]);
      expect(await worker.run({ op: "search", text: other })).toEqual([]);
    }
  });

  it("refuses drift only in its own namespace, including the scratch admission path", async () => {
    await admin.query(
      `ALTER TABLE ${pgSearchName(identities[0]!.namespace)}.notes ALTER COLUMN text SET DEFAULT 'drift'`,
    );
    await expect(workers[0]!.run({ op: "reopen" })).rejects.toThrow("schema drift");
    await admin.query(
      `UPDATE ${pgSearchName(identities[1]!.namespace)}.openclaw_schema_meta SET server_major = 0`,
    );
    await expect(workers[1]!.run({ op: "reopen" })).resolves.toBeUndefined();
    expect(await workers[1]!.run({ op: "search", text: "beta" })).toEqual([
      { id: "same-id", snippet: "café beta" },
    ]);
  });

  it("refuses installation A's anchor paired with installation B's namespace", async () => {
    await expect(
      workers[0]!.run({ op: "reopen", namespace: identities[1]!.namespace }),
    ).rejects.toThrow("identity mismatch");
  });
});
