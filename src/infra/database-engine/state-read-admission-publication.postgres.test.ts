import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { getEnvironmentData } from "node:worker_threads";
import { expect, it } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSqliteDatabaseAdmissionRelay } from "../sqlite-worker-operation-admission.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { conformanceWorkerResult, spawnConformanceWorker } from "./conformance.test-support.js";
import { getDatabaseEngineSelection, installDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { withPostgresConnection } from "./postgres-store-metadata.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const scenarios = [
  { name: "read after staggered schema publication", release: true },
  { name: "startup ledger after staggered schema publication", release: true, startupLedger: true },
  { name: "unpublished schema reaches its bounded deadline" },
  { name: "shorter caller deadline", admissionTimeoutMs: 150 },
  { name: "caller cancellation", cancellable: true },
] as const;
type ReadResult = {
  ok: boolean;
  value?: unknown;
  message?: string;
  admissionError?: boolean;
  callbackCalls: number;
  transactions: number;
  admissionRefreshes: number;
  errors?: string[];
  elapsedMs: number;
};

it.skipIf(!connection).each(scenarios)("settles $name", async (scenario) => {
  const options = {
    release: false,
    startupLedger: false,
    admissionTimeoutMs: undefined as number | undefined,
    cancellable: false,
    ...scenario,
  };
  const prefix = `state_pending_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  try {
    await withOpenClawTestState({ label: "state-pending-admission" }, async (state) => {
      installDatabaseEngineSelection({
        effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
        postgres: { connection: connection!, schemaPrefix: prefix },
      });
      const owner = withEngineStoreAdmission(() => {
        const database = openOpenClawStateDatabase({ env: state.env });
        runOpenClawStateWriteTransaction(
          ({ db }) =>
            db
              .prepare(
                "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
              )
              .run("admission.fixture", "retained", 1),
          { database, env: state.env },
        );
        return database;
      });
      const publisherGate = new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT));
      const readerGate = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
      const release = (gate: Int32Array, index: number) => {
        Atomics.store(gate, index, 1);
        Atomics.notify(gate, index);
      };
      const publisherRelay = createSqliteDatabaseAdmissionRelay(() => {});
      const readerRelay = createSqliteDatabaseAdmissionRelay(() => {});
      const publisher = spawnConformanceWorker(
        {
          currentModuleUrl: import.meta.url,
          sourceWorkerName: "state-read-admission-publication.worker.test-support",
          distWorkerPath:
            "infra/database-engine/state-read-admission-publication.worker.test-support.js",
        },
        owner.path,
        {
          environment: { ...state.env, OPENCLAW_STATE_DIR: state.stateDir },
          selection: getDatabaseEngineSelection(),
          gate: publisherGate.buffer,
          splitPublication: options.release,
        },
      );
      publisher.worker.postMessage({ admissionPort: publisherRelay.port }, [publisherRelay.port]);
      const published = conformanceWorkerResult<{ ok: boolean }>(publisher.worker, "Publisher");
      expect(
        await awaitGateBeforeSettlement(
          once(publisher.worker, "message").then(([message]) => message),
          published,
          "Publisher exited before ready",
        ),
      ).toMatchObject({ phase: "publisher-ready" });
      const reader = spawnConformanceWorker(
        {
          currentModuleUrl: import.meta.url,
          sourceWorkerName: "state-read-admission.worker.test-support",
          distWorkerPath: "infra/database-engine/state-read-admission.worker.test-support.js",
        },
        owner.path,
        {
          path: owner.path,
          environment: { ...state.env, OPENCLAW_STATE_DIR: state.stateDir },
          selection: getDatabaseEngineSelection(),
          gate: readerGate.buffer,
          startupLedger: options.startupLedger,
          admissionTimeoutMs: options.admissionTimeoutMs,
          observeRefresh: true,
          cancellable: options.cancellable,
        },
      );
      reader.worker.postMessage({ admissionPort: readerRelay.port }, [readerRelay.port]);
      const read = conformanceWorkerResult<ReadResult>(reader.worker, "Reader");
      try {
        expect(
          await awaitGateBeforeSettlement(
            once(reader.worker, "message").then(([message]) => message),
            read,
            "Reader exited before BEGIN",
          ),
        ).toMatchObject({ phase: "reader-begun" });
        const pending = once(publisher.worker, "message").then(([message]) => message);
        release(publisherGate, 0);
        expect(
          await awaitGateBeforeSettlement(
            pending,
            published,
            "Publisher exited before publication",
          ),
        ).toMatchObject({ phase: "publication-pending" });
        const refreshed = once(reader.worker, "message").then(([message]) => message);
        release(readerGate, 0);
        expect(
          await awaitGateBeforeSettlement(
            refreshed,
            read,
            "Reader exited before refreshing admission",
          ),
        ).toMatchObject({ phase: "reader-refreshed" });
        if (options.release || options.cancellable) {
          // Real worker clocks prove bounded waiting while the publication transport stays held.
          await delay(50);
          const physical = options.release
            ? once(publisher.worker, "message").then(([message]) => message)
            : undefined;
          const retried = options.release
            ? once(reader.worker, "message").then(([message]) => message)
            : undefined;
          release(options.release ? publisherGate : readerGate, 1);
          if (physical && retried) {
            // Physical facts can arrive before the version facts required inside the read.
            expect(
              await awaitGateBeforeSettlement(
                physical,
                published,
                "Publisher exited before physical facts",
              ),
            ).toMatchObject({ phase: "physical-published" });
            expect(
              await awaitGateBeforeSettlement(
                retried,
                read,
                "Reader exited before partial-publication retry",
              ),
            ).toMatchObject({ phase: "reader-retried" });
            await delay(50);
            release(publisherGate, 2);
          }
        }
        const result = await read;
        expect(result.elapsedMs).toBeLessThan(
          options.admissionTimeoutMs === undefined ? 1800 : 600,
        );
        if (options.release) {
          expect(result, JSON.stringify(result)).toMatchObject({
            ok: true,
            callbackCalls: 1,
            value: options.startupLedger
              ? { type: "legacySessionMigration.readLedger", row: undefined }
              : "retained",
          });
          expect(result.elapsedMs).toBeGreaterThanOrEqual(40);
        } else {
          expect(result).toMatchObject({ ok: false, callbackCalls: 0 });
          if (options.cancellable) {
            expect(result.errors).toContain("State admission fixture cancelled");
            expect(result.admissionError).toBe(false);
          } else if (options.admissionTimeoutMs !== undefined) {
            expect(result.elapsedMs).toBeGreaterThanOrEqual(100);
          } else {
            expect(result).toMatchObject({
              message: "Missing PostgreSQL physical schema admission",
              admissionError: true,
            });
            expect(result.elapsedMs).toBeGreaterThanOrEqual(900);
            expect(result.admissionRefreshes).toBeGreaterThan(1);
          }
        }
      } finally {
        release(publisherGate, 0);
        release(publisherGate, 1);
        release(publisherGate, 2);
        release(readerGate, 0);
        await Promise.allSettled([published, read]);
        publisherRelay.finish();
        readerRelay.finish();
        publisher.anchor.close();
        reader.anchor.close();
      }
    });
  } finally {
    closeOpenClawStateDatabaseForTest();
    resetDatabaseEngineSelectionForTest();
    await withPostgresConnection(
      { connection: connection!, schemaPrefix: prefix },
      async (client) => {
        const schemas = await client.query<{ nspname: string }>(
          "SELECT nspname FROM pg_namespace WHERE starts_with(nspname, $1)",
          [`${prefix}_`],
        );
        for (const { nspname } of schemas.rows) {
          await client.query(`DROP SCHEMA "${nspname}" CASCADE`);
        }
      },
    );
  }
});
