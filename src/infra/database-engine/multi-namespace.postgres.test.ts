import { randomUUID } from "node:crypto";
import path from "node:path";
import { getEnvironmentData, Worker } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import {
  resolveRuntimeWorkerThreadExecArgv,
  resolveRuntimeWorkerUrl,
} from "../runtime-worker-url.js";
import { captureSqliteDatabaseAdmissions } from "../sqlite-database-admission.js";
import {
  multiNamespaceEntrypoint,
  type NamespaceCommand,
  type NamespaceIdentity,
} from "./multi-namespace.test-support.js";
import { pgSearchName } from "./postgres-search-schema.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterAll);

function launch(prefix: string, dsn = connection) {
  const databasePath = path.join(dirs.make("pg-multi-namespace-"), "anchor.sqlite");
  const anchor = openNodeSqliteDatabase(databasePath);
  const gates = new Int32Array(new SharedArrayBuffer(8));
  const events = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>();
  for (const name of ["booting", "ready", "holding"]) {
    events.set(name, Promise.withResolvers());
  }
  const url = resolveRuntimeWorkerUrl(multiNamespaceEntrypoint);
  const worker = new Worker(url, {
    execArgv: resolveRuntimeWorkerThreadExecArgv(url),
    workerData: {
      connection: dsn,
      prefix,
      path: databasePath,
      gates: gates.buffer,
      admissions: captureSqliteDatabaseAdmissions(undefined, { location: databasePath }),
    },
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
  const exited = new Promise<void>((resolve, reject) => {
    worker.on("exit", (code) => {
      anchor.close();
      if (code) {
        reject(new Error(`Namespace worker exited ${code}`));
      } else {
        resolve();
      }
    });
  });
  void exited.catch(() => {});
  return {
    exited,
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
  let databaseWorker: ReturnType<typeof launch> | undefined;
  let databaseIdentity: NamespaceIdentity;
  let databaseCreated = false;
  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${pgSearchName(separateDatabase)}`);
    databaseCreated = true;
    const separateDsn = new URL(connection!);
    separateDsn.pathname = `/${separateDatabase}`;
    const setup = new Client({ connectionString: separateDsn.href });
    await setup.connect();
    try {
      await setup.query(
        "CREATE EXTENSION unaccent WITH SCHEMA public; CREATE EXTENSION pg_trgm WITH SCHEMA public; CREATE EXTENSION vector WITH SCHEMA public",
      );
    } finally {
      await setup.end();
    }
    workers.push(launch("installation_a"), launch("installation_b"));
    databaseWorker = launch("installation_a", separateDsn.href);
    const booting = [...workers, databaseWorker];
    await Promise.all(booting.map((worker) => worker.event("booting")));
    booting.forEach((worker) => worker.release(0));
    const opened = await Promise.all(
      booting.map(async (worker) => (await worker.event("ready")) as NamespaceIdentity),
    );
    identities.push(...opened.slice(0, 2));
    databaseIdentity = opened[2]!;
  });
  afterAll(async () => {
    for (const worker of [...workers, ...(databaseWorker ? [databaseWorker] : [])]) {
      worker.release(0);
      worker.release(1);
      await worker.run({ op: "close" });
      await worker.exited;
    }
    for (const { namespace } of identities) {
      await admin.query(`DROP SCHEMA ${pgSearchName(namespace)} CASCADE`);
    }
    if (databaseCreated) {
      await admin.query(`DROP DATABASE ${pgSearchName(separateDatabase)}`);
    }
    await admin.end();
  });

  it("boots distinct identities concurrently and holds independent writer locks without waiting", async () => {
    const [a, b] = identities;
    expect(a!.storeId).not.toBe(b!.storeId);
    expect(a!.namespace).toMatch(/^installation_a_isolation_/);
    expect(b!.namespace).toMatch(/^installation_b_isolation_/);
    const seals = await admin.query(
      `SELECT ddl_hash FROM ${pgSearchName(a!.namespace)}.openclaw_schema_meta
       UNION SELECT ddl_hash FROM ${pgSearchName(b!.namespace)}.openclaw_schema_meta`,
    );
    expect(seals.rows).toHaveLength(1);
    const writes = workers.map((worker, i) =>
      worker.run({ op: "write", id: "same-id", text: i ? "café beta" : "café alpha", hold: true }),
    );
    await Promise.all(workers.map((worker) => worker.event("holding")));
    const locks = await admin.query(
      "SELECT pid, classid::text, objid::text, granted FROM pg_locks WHERE locktype = 'advisory' AND pid = ANY($1::int[]) ORDER BY pid",
      [identities.map(({ pid }) => pid)],
    );
    expect(locks.rows).toHaveLength(2);
    expect(locks.rows.every((row) => row.granted)).toBe(true);
    expect(new Set(locks.rows.map((row) => `${row.classid}:${row.objid}`)).size).toBe(2);
    workers.forEach((worker) => worker.release(1));
    await Promise.all(writes);
    for (const worker of [workers[1]!, workers[0]!]) {
      await worker.run({ op: "write", id: "second-id", text: "café second" });
    }
  });

  it("shares public extensions while isolating full text, generated columns and vector projections", async () => {
    for (const [i, worker] of workers.entries()) {
      expect(await worker.run({ op: "search", text: "cafe", withoutSearchPath: true })).toEqual([
        { id: "same-id", snippet: i ? "café beta" : "café alpha" },
        { id: "second-id", snippet: "café second" },
      ]);
      const namespace = identities[i]!.namespace;
      expect(
        (
          await admin.query(
            `SELECT id, embedding::text FROM ${pgSearchName(namespace)}.vectors ORDER BY id`,
          )
        ).rows,
      ).toEqual([
        { id: "same-id", embedding: "[1,0,0]" },
        { id: "second-id", embedding: "[1,0,0]" },
      ]);
      const dependency = await admin.query(
        `SELECT n.nspname FROM pg_depend d JOIN pg_attrdef a ON a.oid = d.objid
         JOIN pg_ts_config c ON c.oid = d.refobjid JOIN pg_namespace n ON n.oid = c.cfgnamespace
         WHERE d.classid = 'pg_attrdef'::regclass AND d.refclassid = 'pg_ts_config'::regclass
         AND a.adrelid = $1::regclass`,
        [`${namespace}.notes`],
      );
      expect(dependency.rows).toEqual([{ nspname: namespace }]);
    }
  });

  it("isolates concurrent installations in separate databases on the same server", async () => {
    expect(databaseIdentity.database).toBe(separateDatabase);
    expect(identities[0]!.database).not.toBe(separateDatabase);
    const installations = [workers[0]!, databaseWorker!];
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
