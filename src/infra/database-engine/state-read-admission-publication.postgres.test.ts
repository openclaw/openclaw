import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { createSqliteDatabaseAdmissionRelay } from "../sqlite-worker-operation-admission.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { conformanceWorkerResult, spawnConformanceWorker } from "./conformance.test-support.js";
import { getDatabaseEngineSelection } from "./context.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

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

async function expectPhase(gate: Promise<unknown>, operation: Promise<unknown>, phase: string) {
  expect(
    await awaitGateBeforeSettlement(gate, operation, `Worker settled before ${phase}`),
  ).toMatchObject({ phase });
}

describe.skipIf(!mixedAgentConnection).each(scenarios)("$name", (scenario) => {
  const pair = useMixedAgentPair("postgres", "postgres");
  it("settles the reader under the publication gate", async () => {
    const options = {
      release: false,
      startupLedger: false,
      admissionTimeoutMs: undefined as number | undefined,
      cancellable: false,
      ...scenario,
    };
    const env = { ...process.env, OPENCLAW_STATE_DIR: pair.root };
    const owner = withEngineStoreAdmission(() => {
      const database = openOpenClawStateDatabase({ env });
      runOpenClawStateWriteTransaction(
        ({ db }) =>
          db
            .prepare(
              "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
            )
            .run("admission.fixture", "retained", 1),
        { database, env },
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
        environment: env,
        selection: getDatabaseEngineSelection(),
        gate: publisherGate.buffer,
        splitPublication: options.release,
      },
    );
    publisher.worker.postMessage({ admissionPort: publisherRelay.port }, [publisherRelay.port]);
    const published = conformanceWorkerResult<{ ok: boolean }>(publisher.worker, "Publisher");
    await expectPhase(
      once(publisher.worker, "message").then(([message]) => message),
      published,
      "publisher-ready",
    );
    const reader = spawnConformanceWorker(
      {
        currentModuleUrl: import.meta.url,
        sourceWorkerName: "state-read-admission.worker.test-support",
        distWorkerPath: "infra/database-engine/state-read-admission.worker.test-support.js",
      },
      owner.path,
      {
        path: owner.path,
        environment: env,
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
      await expectPhase(
        once(reader.worker, "message").then(([message]) => message),
        read,
        "reader-begun",
      );
      const pending = once(publisher.worker, "message").then(([message]) => message);
      release(publisherGate, 0);
      await expectPhase(pending, published, "publication-pending");
      const refreshed = once(reader.worker, "message").then(([message]) => message);
      release(readerGate, 0);
      await expectPhase(refreshed, read, "reader-refreshed");
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
          await expectPhase(physical, published, "physical-published");
          await expectPhase(retried, read, "reader-retried");
          await delay(50);
          release(publisherGate, 2);
        }
      }
      const result = await read;
      expect(result.elapsedMs).toBeLessThan(options.admissionTimeoutMs === undefined ? 1800 : 600);
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
});
