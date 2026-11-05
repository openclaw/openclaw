import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { getEnvironmentData } from "node:worker_threads";
import { expect, it } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { ensureUserBackgroundSchema } from "../../state/user-background.store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { dropPostgresTestSchemas } from "../postgres-sync/schema-cleanup.test-support.js";
import { getSqliteDatabaseSchemaRevision } from "../sqlite-database-admission.js";
import { createSqliteDatabaseAdmissionRelay } from "../sqlite-worker-operation-admission.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { conformanceWorkerResult, spawnConformanceWorker } from "./conformance.test-support.js";
import { getDatabaseEngineSelection, installDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { getPostgresPhysicalFacts } from "./physical-facts.js";
import { withPostgresConnection } from "./postgres-store-metadata.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const value = JSON.stringify({ result: "retained" });
type ReadResult = {
  ok: boolean;
  value?: unknown;
  message?: string;
  callbackCalls: number;
  transactions: number;
};

it.skipIf(!connection).each([false, true])(
  "settles a PostgreSQL read across schema publication (imported snapshot: %s)",
  async (importedSnapshot) => {
    const prefix = `state_read_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    try {
      await withOpenClawTestState({ label: "state-read-admission" }, async (state) => {
        installDatabaseEngineSelection({
          effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
          postgres: { connection: connection!, schemaPrefix: prefix },
        });
        const owner = withEngineStoreAdmission(() => {
          const database = openOpenClawStateDatabase({ env: state.env });
          runOpenClawStateWriteTransaction(
            ({ db }) => {
              db.prepare(
                "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
              ).run("admission.fixture", value, 1);
            },
            { database, env: state.env },
          );
          return database;
        });
        const read = async (
          publish: () => void,
          options?: { snapshot?: string; throwFromCallback?: boolean },
        ): Promise<ReadResult> => {
          let active = true;
          const relay = createSqliteDatabaseAdmissionRelay(() => {
            if (!active) {
              throw new Error("State admission fixture has finished");
            }
          });
          const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
          const { anchor, worker } = spawnConformanceWorker(
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
              gate,
              ...options,
            },
          );
          worker.postMessage({ admissionPort: relay.port }, [relay.port]);
          const result = conformanceWorkerResult<ReadResult>(worker, "State admission");
          try {
            const first: unknown = await awaitGateBeforeSettlement(
              once(worker, "message").then(([message]) => message),
              result,
              "State reader settled before reaching its read-only BEGIN",
            );
            expect(first).toMatchObject({ phase: "reader-begun" });
            publish();
            Atomics.store(new Int32Array(gate), 0, 1);
            Atomics.notify(new Int32Array(gate), 0);
            return await result;
          } finally {
            Atomics.store(new Int32Array(gate), 0, 1);
            Atomics.notify(new Int32Array(gate), 0);
            await result.catch(() => {});
            active = false;
            relay.finish();
            anchor.close();
          }
        };
        const before = await read(() => {});
        const publish = () => {
          withEngineStoreAdmission(() => {
            const beforeFacts = getPostgresPhysicalFacts(owner.db);
            expect(
              beforeFacts?.catalog.some((fact) => fact.table === "user_background_images"),
            ).toBe(false);
            const beforeRevision = getSqliteDatabaseSchemaRevision(owner.db);
            ensureUserBackgroundSchema({ env: state.env });
            const afterFacts = getPostgresPhysicalFacts(owner.db);
            expect(
              afterFacts?.catalog.some((fact) => fact.table === "user_background_images"),
            ).toBe(true);
            const afterRevision = getSqliteDatabaseSchemaRevision(owner.db);
            expect(afterRevision).toBeGreaterThan(beforeRevision!);
          });
        };
        const during = importedSnapshot
          ? await withPostgresConnection(
              { connection: connection!, schemaPrefix: prefix },
              async (client) => {
                await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
                try {
                  const exported = await client.query<{ snapshot: string }>(
                    "SELECT pg_export_snapshot() AS snapshot",
                  );
                  const snapshot = exported.rows[0]?.snapshot;
                  if (!snapshot) {
                    throw new Error("State admission fixture could not export its snapshot");
                  }
                  return await read(publish, { snapshot });
                } finally {
                  await client.query("ROLLBACK");
                }
              },
            )
          : await read(publish);
        const after = await read(() => {});
        expect(before).toMatchObject({ ok: true, value, callbackCalls: 1, transactions: 1 });
        expect(after).toMatchObject({ ok: true, value, callbackCalls: 1, transactions: 1 });
        expect(during).toMatchObject(
          importedSnapshot
            ? {
                ok: false,
                message: "Missing PostgreSQL physical schema admission",
                callbackCalls: 0,
                transactions: 1,
              }
            : { ok: true, value, callbackCalls: 1, transactions: 2 },
        );
        if (!importedSnapshot) {
          const callbackFailure = await read(() => {}, { throwFromCallback: true });
          expect(callbackFailure).toMatchObject({
            ok: false,
            message: "Callback admission failed",
            callbackCalls: 1,
            transactions: 1,
          });
        }
      });
    } finally {
      closeOpenClawStateDatabaseForTest();
      resetDatabaseEngineSelectionForTest();
      await withPostgresConnection({ connection: connection!, schemaPrefix: prefix }, (client) =>
        dropPostgresTestSchemas(client, prefix),
      );
    }
  },
);
