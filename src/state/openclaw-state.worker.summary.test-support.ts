import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isMainThread, type MessagePort } from "node:worker_threads";
import { readConfigHealthStateInDatabase } from "../config/io.health-state.kernel.js";
import {
  createSqliteAuditRecordKernel,
  prepareSqliteAuditRecord,
} from "../infra/sqlite-audit-record.kernel.js";
import { SQLITE_WORKER_PREPARE_COMMAND } from "../infra/sqlite-worker-contract.js";
import { withSqliteWorkerOperationAdmissionAsync } from "../infra/sqlite-worker-operation-admission.js";
import {
  runWithSqliteWorkerStateContext,
  type SqliteWorkerStateContext,
} from "../infra/sqlite-worker-state-context.js";
import { serveWorkerTasks } from "../infra/worker-task-server.js";
import { pluginStateLookup } from "../plugin-state/plugin-state-store.sqlite.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import {
  createSqliteWorkerBackend,
  openExistingSqliteWorkerBackend,
} from "./openclaw-state.worker.js";

export type SummaryScenario =
  | { kind: "promotion"; firstToClose: "kv" | "health" }
  | { kind: "existing"; operation: "config.health.patch" | "diagnostic.register" };
export type SummaryInput = {
  scenario: SummaryScenario;
  context: SqliteWorkerStateContext;
  databasePath: string;
  identity: string;
  port: MessagePort;
};
export type SummaryResult = { completed: SummaryScenario; isMainThread: boolean };

const pluginKey = { pluginId: "native-borrow-fixture", namespace: "shared", key: "answer" };

serveWorkerTasks<SummaryResult, SummaryInput>(async (input, _channel, control) => {
  assert.equal(isMainThread, false);
  const { databasePath, context, scenario } = input;
  const backends = new Set<ReturnType<typeof createSqliteWorkerBackend>>();
  const openDatabase = () =>
    openOpenClawStateDatabase({ path: databasePath, env: context.environment });
  const lookup = () => pluginStateLookup({ ...pluginKey, env: context.environment });
  function createBackend(existing = false) {
    const backend = existing
      ? openExistingSqliteWorkerBackend(undefined, {
          databasePath,
          existingIdentity: input.identity,
        })
      : createSqliteWorkerBackend(undefined, { databasePath });
    backends.add(backend);
    return {
      ...backend,
      patch(configPath: string, signature: string, previous?: string) {
        return backend.execute({
          type: "config.health.patch",
          input: {
            configPath,
            patch: { last_observed_suspicious_signature: signature },
            expected:
              previous === undefined
                ? null
                : {
                    lastKnownGoodJson: null,
                    lastPromotedGoodJson: null,
                    suspiciousSignature: previous,
                    updatedAtMs: 100,
                  },
            updatedAtMs: previous === undefined ? 100 : 200,
          },
        });
      },
      register(value: { value: number }) {
        return backend.execute({
          type: "pluginState.register",
          input: {
            ...pluginKey,
            valueJson: JSON.stringify(value),
            maxEntries: 4,
            overflowPolicy: "reject-new",
          },
        });
      },
    };
  }
  return control
    .runNativeSection(() =>
      runWithSqliteWorkerStateContext(context, () =>
        withSqliteWorkerOperationAdmissionAsync({ port: input.port }, async () => {
          try {
            if (scenario.kind === "promotion") {
              const kv = createBackend(true);
              await kv[SQLITE_WORKER_PREPARE_COMMAND]?.("pluginState.register");
              assert.equal(lookup(), undefined);
              assert.deepEqual(readFileSync(databasePath), Buffer.alloc(0));
              assert.deepEqual(kv.register({ value: 42 }), { ok: true, value: undefined });
              const health = createBackend();
              await health[SQLITE_WORKER_PREPARE_COMMAND]?.("config.health.patch");
              const database = openDatabase();
              const configPath = "/synthetic-native-borrow.json";
              assert.equal(health.patch(configPath, "first"), true);
              await (scenario.firstToClose === "kv" ? kv : health).close();
              assert.equal(database.db.isOpen, true);
              if (scenario.firstToClose === "kv") {
                assert.equal(health.patch(configPath, "second", "first"), true);
              } else {
                assert.deepEqual(lookup(), { value: 42 });
              }
              await (scenario.firstToClose === "kv" ? health : kv).close();
              assert.equal(database.db.isOpen, false);
              createBackend();
              assert.deepEqual(lookup(), { value: 42 });
              assert.equal(
                readConfigHealthStateInDatabase(openDatabase().db).entries?.[configPath]
                  ?.lastObservedSuspiciousSignature,
                scenario.firstToClose === "kv" ? "second" : "first",
              );
            } else {
              const initialBytes = readFileSync(databasePath);
              const first = createBackend(true);
              const second = createBackend(true);
              await first[SQLITE_WORKER_PREPARE_COMMAND]?.("templates.install-schema-versions");
              await second[SQLITE_WORKER_PREPARE_COMMAND]?.(scenario.operation);
              assert.deepEqual(
                first.execute({
                  type: "templates.install-schema-versions",
                  input: { artifactPreservingReadOnly: false },
                }),
                [],
              );
              assert.deepEqual(readFileSync(databasePath), initialBytes);
              const scope = "tests/health-native-borrow";
              const write = (backend: typeof first, key: string) =>
                scenario.operation === "config.health.patch"
                  ? backend.patch(`/${key}.json`, key)
                  : backend.execute({
                      type: "diagnostic.register",
                      input: {
                        scope,
                        maxEntries: 10,
                        record: prepareSqliteAuditRecord(scope, {
                          key,
                          value: { marker: key },
                          createdAt: 100,
                        }),
                      },
                    });
              const expectedResult =
                scenario.operation === "config.health.patch" ? true : undefined;
              assert.equal(write(first, "first"), expectedResult);
              assert.equal(write(second, "second"), expectedResult);
              const database = openDatabase();
              await first.close();
              assert.equal(database.db.isOpen, true);
              assert.equal(write(second, "third"), expectedResult);
              await second.close();
              assert.equal(database.db.isOpen, false);
              const reopened = createBackend();
              await reopened[SQLITE_WORKER_PREPARE_COMMAND]?.("templates.install-schema-versions");
              const reopenedDatabase = openDatabase();
              if (scenario.operation === "config.health.patch") {
                const health = readConfigHealthStateInDatabase(reopenedDatabase.db);
                for (const key of ["first", "second", "third"]) {
                  assert.equal(
                    health.entries?.[`/${key}.json`]?.lastObservedSuspiciousSignature,
                    key,
                  );
                }
              } else {
                assert.deepEqual(
                  createSqliteAuditRecordKernel(reopenedDatabase.db, {
                    scope,
                    maxEntries: 10,
                  }).entries(),
                  [
                    { key: "first", value: { marker: "first" }, createdAt: 100 },
                    { key: "second", value: { marker: "second" }, createdAt: 100 },
                    { key: "third", value: { marker: "third" }, createdAt: 100 },
                  ],
                );
              }
              await reopened.close();
              assert.equal(reopenedDatabase.db.isOpen, false);
            }
            return { completed: scenario, isMainThread };
          } finally {
            try {
              for (const backend of backends) {
                await backend.close();
              }
            } finally {
              await closeOpenClawStateDatabaseAsync();
            }
          }
        }),
      ),
    )
    .finally(() => input.port.close());
});
