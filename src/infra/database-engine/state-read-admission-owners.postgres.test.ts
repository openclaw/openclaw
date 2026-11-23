import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { getEnvironmentData } from "node:worker_threads";
import { expect, it } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { installPostgresStateFixture } from "../../state/openclaw-state-db.postgres-fixture.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { usePostgresTestHarness } from "../postgres-sync/postgres.test-support.js";
import { dropPostgresTestSchemas } from "../postgres-sync/schema-cleanup.test-support.js";
import { createSqliteDatabaseAdmissionRelay } from "../sqlite-worker-operation-admission.js";
import { createUpdateRun } from "../update-run-ledger.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { conformanceWorkerResult, spawnConformanceWorker } from "./conformance.test-support.js";
import { getDatabaseEngineSelection, installDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { getPostgresPhysicalFacts } from "./physical-facts.js";
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

it
  .skipIf(!connection)
  .each(["open", "ensure", "raw-fragment", "write", "schema-read", "existing-write"] as const)(
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
              value:
                operation === "open"
                  ? { admitted: 1 }
                  : operation === "schema-read"
                    ? { present: true, column: true, key: ["state_key"] }
                    : operation === "write" || operation === "existing-write"
                      ? { present: true }
                      : { count: 0 },
            });
            if (operation === "ensure" || operation === "write" || operation === "existing-write") {
              expect(result.transactions).toBe(2);
              if (operation === "write" || operation === "existing-write") {
                expect(result.callbackCalls).toBe(1);
              }
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
          await Promise.all([publisherRelay.finish(), readerRelay.finish()]);
          publisher.anchor.close();
          reader.anchor.close();
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

const fragmentHarness = usePostgresTestHarness("state_fragments");
const { prefix, client } = fragmentHarness;
it.skipIf(!connection).each([false, true])(
  "accepts a peer update ledger without hiding drift (drift: %s)",
  async (drift) => {
    await withOpenClawTestState({ label: "state-fragments" }, async (state) => {
      const pathname = state.statePath("state", "openclaw.sqlite");
      const env = state.env;
      installPostgresStateFixture(connection!, prefix);
      const options = { path: pathname, env };
      const database = withEngineStoreAdmission(() => openOpenClawStateDatabase(options));
      expect(withEngineStoreAdmission(() => tableExists(database.db, "update_runs"))).toBe(false);
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          "./scripts/tsx.mjs",
          "src/infra/database-engine/state-fragments.process.test-support.ts",
        ],
        {
          encoding: "utf8",
          env: { ...process.env, ...env },
          timeout: 30_000,
          input: JSON.stringify({ connection, prefix, pathname }),
        },
      );
      expect(child.status, child.stderr).toBe(0);
      const namespace = withEngineStoreAdmission(
        () => getPostgresPhysicalFacts(database.db)!.namespace,
      );
      const create = () =>
        withEngineStoreAdmission(() =>
          createUpdateRun({ trigger: "chat", preview: true }, options),
        );
      if (drift) {
        await client.query(`ALTER TABLE "${namespace}".update_runs ADD COLUMN unexpected text`);
        expect(create).toThrow(/schema drift/);
      } else {
        create();
      }
      const rows = await client.query(`SELECT run_id FROM "${namespace}".update_runs`);
      expect(rows.rows).toHaveLength(drift ? 1 : 2);
      closeOpenClawStateDatabaseForTest();
    });
  },
);
