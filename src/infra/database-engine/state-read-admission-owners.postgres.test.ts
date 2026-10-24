import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { getEnvironmentData } from "node:worker_threads";
import { expect, it } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
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
type Result = {
  ok: boolean;
  value?: unknown;
  message?: string;
  stack?: string;
  callbackCalls: number;
  transactions: number;
};

it.skipIf(!connection).each(["open", "ensure", "raw-fragment"] as const)(
  "keeps %s admission owned across a sibling publication gap",
  async (operation) => {
    const prefix = `state_owners_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    try {
      await withOpenClawTestState({ label: "state-admission-owners" }, async (state) => {
        installDatabaseEngineSelection({
          effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
          postgres: { connection: connection!, schemaPrefix: prefix },
        });
        const owner = withEngineStoreAdmission(() => openOpenClawStateDatabase({ env: state.env }));
        const publisherGate = new Int32Array(
          new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT),
        );
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
            twoPublications: operation === "open",
            pauseCommit: operation !== "open",
          },
        );
        publisher.worker.postMessage({ admissionPort: publisherRelay.port }, [publisherRelay.port]);
        const published = conformanceWorkerResult<{ ok: boolean }>(publisher.worker, "Publisher");
        const phase = async (
          worker: typeof publisher.worker,
          result: Promise<object>,
          name: string,
        ) => {
          expect(
            await awaitGateBeforeSettlement(
              once(worker, "message").then(([message]) => message),
              result,
              `Worker exited before ${name}`,
            ),
          ).toMatchObject({ phase: name });
        };
        await phase(publisher.worker, published, "publisher-ready");
        if (operation !== "open") {
          const committed = phase(publisher.worker, published, "publisher-committed");
          release(publisherGate, 0);
          await committed;
        }
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
            operation,
          },
        );
        reader.worker.postMessage({ admissionPort: readerRelay.port }, [readerRelay.port]);
        const read = conformanceWorkerResult<Result>(reader.worker, "Admission owner");
        try {
          if (operation === "open") {
            await phase(reader.worker, read, "opener-ready");
            const pending = phase(publisher.worker, published, "publication-pending");
            release(publisherGate, 0);
            await pending;
            const admitted = phase(reader.worker, read, "opener-admitted");
            release(readerGate, 0);
            await admitted;
            const firstPublished = phase(publisher.worker, published, "first-published");
            release(publisherGate, 1);
            await firstPublished;
            const secondPending = phase(publisher.worker, published, "publication-pending");
            release(publisherGate, 2);
            await secondPending;
            release(readerGate, 1);
          } else {
            await phase(reader.worker, read, "reader-begun");
            const pending = phase(publisher.worker, published, "publication-pending");
            release(publisherGate, 2);
            await pending;
            release(readerGate, 0);
          }
          await delay(50);
          release(publisherGate, operation === "open" ? 3 : 1);
          const result = await read;
          if (operation === "raw-fragment") {
            expect(result).toMatchObject({
              ok: false,
              admissionError: true,
              callbackCalls: 1,
              transactions: 1,
            });
            expect(result.message).toContain("Missing PostgreSQL state admission");
            expect(result.stack).toContain("ensureStatePostgresFragment");
          } else {
            expect(result, result.stack).toMatchObject({
              ok: true,
              value: operation === "open" ? { admitted: 1 } : { count: 0 },
            });
            if (operation === "ensure") {
              expect(result.transactions).toBe(2);
            }
          }
        } finally {
          for (let index = 0; index < publisherGate.length; index++) {
            release(publisherGate, index);
          }
          for (let index = 0; index < readerGate.length; index++) {
            release(readerGate, index);
          }
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
  },
);
