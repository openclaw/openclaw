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

it.skipIf(!connection).for([false, true])(
  "services a worker commit with an idle contender (transaction timeout: %s)",
  { timeout: 15_000 },
  async (expireBody, { skip }) => {
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
      const schema = `${prefix}_${expireBody ? "timeout" : "commit"}`;
      const storeId = `${prefix}-${expireBody}`;
      const anchor = openNodeSqliteDatabase(filename);
      cleanups.push(() => anchor.close());
      anchor.exec("CREATE TABLE anchor (id TEXT)");
      await client.query(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".events (id TEXT)`);
      const contender = withEngineStoreAdmission(
        () =>
          new PostgresSyncConnection(connection!, schema, anchor, storeId, {
            lockTimeoutMs: 1000,
            statementTimeoutMs: 2000,
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
          contender.runTransaction(() => {
            bodyCalls++;
            expect(serviceCalls).toBeGreaterThan(0);
            expect(contender.prepare("SHOW lock_timeout").get()).toEqual({ lock_timeout: "1s" });
            if (hasTransactionTimeout) {
              expect(contender.prepare("SHOW transaction_timeout").get()).toEqual({
                transaction_timeout: expireBody ? "400ms" : "10s",
              });
            }
            contender.prepare("INSERT INTO events VALUES (?)").run("host");
            if (expireBody) {
              contender.exec("SELECT pg_sleep(0.3)");
            }
          }),
        );
      if (expireBody) {
        expect(write).toThrow("transaction rolled back");
        expect(contender.isOpen).toBe(false);
      } else {
        write();
        expect(contender.isOpen).toBe(true);
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
