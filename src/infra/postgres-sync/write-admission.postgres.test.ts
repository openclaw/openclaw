import { once } from "node:events";
import path from "node:path";
import { expect, it } from "vitest";
import { withEngineStoreAdmission } from "../database-engine/admission-scope.js";
import { createConformanceWorker } from "../database-engine/conformance.test-support.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { resolveRuntimeWorkerUrl } from "../runtime-worker-url.js";
import { captureSqliteDatabaseAdmissions } from "../sqlite-database-admission.js";
import { createSqliteWorkerOperationAdmission } from "../sqlite-worker-operation-admission.js";
import { retainSqliteWriteAdmissionService } from "../sqlite-write-admission.js";
import { PostgresSyncConnection } from "./connection.js";
import { usePostgresTestHarness } from "./postgres.test-support.js";

const harness = usePostgresTestHarness("write_admission");
const { connection, client, prefix, directories } = harness;

async function bounded<T>(value: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Write admission fixture did not settle")), 8000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

it.skipIf(!connection).for([
  {
    name: "configured",
    statementTimeoutMs: 2000,
    statement: "2s",
    maintenance: false,
    expireBody: false,
  },
  {
    name: "default",
    statementTimeoutMs: undefined,
    statement: "90s",
    maintenance: false,
    expireBody: false,
  },
  { name: "zero", statementTimeoutMs: 0, statement: "0", maintenance: false, expireBody: false },
  {
    name: "maintenance",
    statementTimeoutMs: 0,
    statement: "0",
    maintenance: true,
    expireBody: false,
  },
  {
    name: "transaction_timeout",
    statementTimeoutMs: 2000,
    statement: "2s",
    maintenance: false,
    expireBody: true,
  },
])(
  "services a worker commit with an idle $name contender",
  { timeout: 15_000 },
  async (mode, { skip }) => {
    const { expireBody } = mode;
    const hasTransactionTimeout =
      (await client.query("SELECT 1 FROM pg_settings WHERE name = 'transaction_timeout'"))
        .rowCount === 1;
    if (expireBody && !hasTransactionTimeout) {
      skip("PostgreSQL 17 transaction_timeout required");
    }
    const cleanups: Array<() => void | Promise<unknown>> = [];
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        const failures: unknown[] = [];
        for (const close of cleanups.toReversed()) {
          try {
            await bounded(Promise.resolve().then(close));
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length) {
          throw new AggregateError(failures, "Write admission fixture cleanup failed");
        }
      })());
    harness.onClose(cleanup);
    try {
      const filename = path.join(directories.make("write-admission-"), "anchor.sqlite");
      const schema = `${prefix}_${mode.name}`;
      const storeId = `${prefix}-${mode.name}`;
      const anchor = openNodeSqliteDatabase(filename);
      cleanups.push(() => anchor.close());
      anchor.exec("CREATE TABLE anchor (id TEXT)");
      await client.query(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".events (id TEXT)`);
      const contender = withEngineStoreAdmission(
        () =>
          new PostgresSyncConnection(connection!, schema, anchor, storeId, {
            lockTimeoutMs: 1000,
            statementTimeoutMs: mode.statementTimeoutMs,
          }),
      );
      cleanups.push(() => withEngineStoreAdmission(() => contender.close()));
      const transactionTimeout = expireBody ? 400 : 10000;
      if (hasTransactionTimeout) {
        withEngineStoreAdmission(() =>
          contender.exec(`SET transaction_timeout = '${transactionTimeout}ms'`),
        );
      }
      const admission = createSqliteWorkerOperationAdmission((_request, grant) => grant());
      cleanups.push(() => admission.finish());
      const gate = new Int32Array(new SharedArrayBuffer(4));
      let serviceCalls = 0;
      const releaseService = retainSqliteWriteAdmissionService([filename], () => {
        expect(contender.isTransaction).toBe(false);
        expect(contender.isOpen).toBe(true);
        // Spend part of the logical transaction budget while the holder awaits this host.
        if (expireBody && serviceCalls === 0) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
        }
        serviceCalls++;
        admission.service();
      });
      cleanups.push(releaseService);
      const worker = createConformanceWorker(
        resolveRuntimeWorkerUrl({
          currentModuleUrl: import.meta.url,
          sourceWorkerName: "write-admission-worker.test-support",
          distWorkerPath: "infra/postgres-sync/write-admission-worker.test-support.js",
        }),
        {
          connection,
          path: filename,
          schema,
          storeId,
          gate: gate.buffer,
          admissions: captureSqliteDatabaseAdmissions(undefined, { location: filename }),
        },
        { connection: connection! },
      );
      cleanups.push(() => worker.terminate());
      cleanups.push(() => {
        Atomics.store(gate, 0, 1);
        Atomics.notify(gate, 0);
        admission.service();
      });
      const exited = once(worker, "exit");
      const ready = new Promise<void>((resolve, reject) => {
        worker.on("error", reject);
        worker.on("message", (message) => {
          if (message.event === "commit-ready") {
            resolve();
          }
        });
      });
      worker.postMessage({ admission: admission.port }, [admission.port]);
      await bounded(ready);
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
      let bodyCalls = 0;
      const write = () =>
        withEngineStoreAdmission(() =>
          contender.runTransaction(
            () => {
              bodyCalls++;
              expect(serviceCalls).toBeGreaterThan(0);
              expect(contender.prepare("SHOW lock_timeout").get()).toEqual({ lock_timeout: "1s" });
              expect(contender.prepare("SHOW statement_timeout").get()).toEqual({
                statement_timeout: mode.maintenance ? "1h" : mode.statement,
              });
              if (hasTransactionTimeout) {
                expect(contender.prepare("SHOW transaction_timeout").get()).toEqual({
                  transaction_timeout: expireBody ? "400ms" : "10s",
                });
              }
              contender.prepare("INSERT INTO events VALUES (?)").run("host");
              if (expireBody) {
                contender.exec("SELECT pg_sleep(0.3)");
              }
            },
            { maintenance: mode.maintenance },
          ),
        );
      if (expireBody) {
        expect(write).toThrow("transaction rolled back");
        expect(contender.isOpen).toBe(false);
      } else {
        write();
        expect(contender.isOpen).toBe(true);
        expect(
          withEngineStoreAdmission(() => contender.prepare("SHOW statement_timeout").get()),
        ).toEqual({ statement_timeout: mode.statement });
        if (hasTransactionTimeout) {
          expect(
            withEngineStoreAdmission(() => contender.prepare("SHOW transaction_timeout").get()),
          ).toEqual({ transaction_timeout: "10s" });
        }
      }
      expect(bodyCalls).toBe(1);
      expect(await bounded(exited)).toEqual([0]);
      admission.waitForSettlement(performance.now() + 8000);
      expect(admission.failure).toBeUndefined();
      expect(admission.settlement?.kind).toBe("completed");
      expect((await client.query(`SELECT id FROM "${schema}".events ORDER BY id`)).rows).toEqual(
        expireBody ? [{ id: "worker" }] : [{ id: "host" }, { id: "worker" }],
      );
    } finally {
      await cleanup();
    }
  },
);

it.skipIf(!connection).for([false, true])(
  "restores the outer statement timeout after nested maintenance (refused: %s)",
  async (refused) => {
    const schema = `${prefix}_nested_${refused}`;
    await client.query(`CREATE SCHEMA "${schema}"`);
    const anchor = openNodeSqliteDatabase(":memory:");
    const run = withEngineStoreAdmission;
    try {
      const db = run(
        () =>
          new PostgresSyncConnection(connection!, schema, anchor, schema, {
            statementTimeoutMs: 1234,
          }),
      );
      try {
        const failure = new Error("nested maintenance refusal");
        const statementTimeout = () => db.prepare("SHOW statement_timeout").get();
        run(() =>
          db.runTransaction(() => {
            expect(statementTimeout()).toEqual({ statement_timeout: "1234ms" });
            const nested = () =>
              db.runTransaction(
                () => {
                  expect(statementTimeout()).toEqual({ statement_timeout: "1h" });
                  if (refused) {
                    throw failure;
                  }
                },
                { maintenance: true },
              );
            if (refused) {
              let nestedFailure: unknown;
              try {
                nested();
              } catch (error) {
                nestedFailure = error;
              }
              expect(nestedFailure).toBe(failure);
            } else {
              nested();
            }
            expect(db.isTransaction).toBe(true);
            expect(statementTimeout()).toEqual({ statement_timeout: "1234ms" });
          }),
        );
        expect(db.isTransaction).toBe(false);
        expect(run(statementTimeout)).toEqual({ statement_timeout: "1234ms" });
      } finally {
        run(() => db.close());
      }
    } finally {
      anchor.close();
    }
  },
);

it.skipIf(!connection).for([
  { name: "lock", lockTimeoutMs: 100, statementTimeoutMs: 0, code: "55P03" },
  { name: "statement", lockTimeoutMs: 0, statementTimeoutMs: 100, code: "57014" },
])("bounds repeated lock slices by the real $name GUC", async (mode) => {
  const schema = `${prefix}_budget_${mode.name}`;
  await client.query(`CREATE SCHEMA "${schema}"`);
  const filename = path.join(directories.make("admission-budget-"), "anchor.sqlite");
  const anchor = openNodeSqliteDatabase(filename);
  const run = withEngineStoreAdmission;
  try {
    const db = run(
      () =>
        new PostgresSyncConnection(connection!, schema, anchor, schema, {
          lockTimeoutMs: mode.lockTimeoutMs,
          statementTimeoutMs: mode.statementTimeoutMs,
        }),
    );
    try {
      let serviceCalls = 0;
      let bodyCalls = 0;
      const releaseService = retainSqliteWriteAdmissionService([filename], () => {
        expect(db.isTransaction).toBe(false);
        serviceCalls++;
      });
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
          db.advisoryLockKey.toString(),
        ]);
        let failure: unknown;
        try {
          run(() =>
            db.runTransaction(() => {
              bodyCalls++;
            }),
          );
        } catch (error) {
          failure = error;
        }
        expect(failure).toMatchObject(
          mode.code === "55P03"
            ? { code: "ERR_SQLITE_ERROR", errcode: 5, cause: { code: "55P03" } }
            : { code: "57014", name: "PostgresQueryCanceledError" },
        );
        expect(serviceCalls).toBeGreaterThan(0);
        expect(bodyCalls).toBe(0);
        expect(db.isOpen).toBe(true);
        expect(db.isTransaction).toBe(false);
        await client.query("ROLLBACK");
        expect(run(() => db.prepare("SHOW lock_timeout").get())).toEqual({
          lock_timeout: mode.lockTimeoutMs === 0 ? "0" : "100ms",
        });
        expect(run(() => db.prepare("SHOW statement_timeout").get())).toEqual({
          statement_timeout: mode.statementTimeoutMs === 0 ? "0" : "100ms",
        });
      } finally {
        try {
          await client.query("ROLLBACK");
        } finally {
          releaseService();
        }
      }
    } finally {
      run(() => db.close());
    }
  } finally {
    anchor.close();
  }
});

it.skipIf(!connection)(
  "retires a server-terminated idle transaction without publishing its write",
  async () => {
    const schema = `${prefix}_idle_timeout`;
    await client.query(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".events (id TEXT)`);
    const anchor = openNodeSqliteDatabase(":memory:");
    const run = withEngineStoreAdmission;
    try {
      const db = run(() => new PostgresSyncConnection(connection!, schema, anchor, schema));
      let bodyCalls = 0;
      try {
        expect(() =>
          run(() =>
            db.runTransaction(() => {
              bodyCalls++;
              db.exec("SET LOCAL idle_in_transaction_session_timeout = '50ms'");
              db.prepare("INSERT INTO events VALUES (?)").run("rolled-back");
              // Let the server's real idle timer terminate the transaction while this host is idle.
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
              db.exec("SELECT 1");
            }),
          ),
        ).toThrow("transaction rolled back");
        expect(bodyCalls).toBe(1);
        expect(db.isOpen).toBe(false);
        expect(db.isTransaction).toBe(false);
        expect(() => run(() => db.exec("SELECT 1"))).toThrow("transaction rolled back");
        expect((await client.query(`SELECT id FROM "${schema}".events`)).rows).toEqual([]);
      } finally {
        run(() => db.close());
      }
    } finally {
      anchor.close();
    }
  },
);
