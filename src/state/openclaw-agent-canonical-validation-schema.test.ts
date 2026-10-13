import assert from "node:assert/strict";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { constants, DatabaseSync } from "node:sqlite";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  readPendingCanonicalSessionValidationBatch,
  validateCanonicalSessionValidationBatch,
} from "../config/sessions/session-canonical-validation.js";
import { maintenanceLane } from "../config/sessions/session-transcript-worker-resources.js";
import { retainSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import type { RuntimeWorkerGeneration } from "../infra/runtime-worker-generation.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { sqliteWorkerPreloadEnv } from "../infra/sqlite-worker-preload.test-support.js";
import { captureRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import type { RetainedNativeWorker } from "../infra/worker-native-lifecycle.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  assertCanonicalSessionValidationSchema,
  captureCanonicalSessionValidationSchema,
  withoutCanonicalSessionValidationSchema,
} from "./openclaw-agent-canonical-validation-schema.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import { openOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly-open.js";
import { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
import { OPENCLAW_AGENT_SCHEMA_V21_SQL } from "./openclaw-agent-schema-v21.test-support.js";
import { OPENCLAW_AGENT_SCHEMA_V24_SQL } from "./openclaw-agent-schema-v24.test-support.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import {
  assertOpenClawMigrationWitnessPreserved,
  captureOpenClawMigrationWitness,
} from "./openclaw-migration-witness.js";

const key = "agent:main:target";
const sibling = "agent:main:sibling";

function pendingKeys(database: DatabaseSync) {
  return database
    .prepare("SELECT session_key FROM session_canonical_validation_pending ORDER BY session_key")
    .all()
    .map((row) => row.session_key);
}

function insertNode(database: DatabaseSync, sessionKey: string, sessionId: string) {
  database
    .prepare(`INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
      VALUES (?, ?, ?, 1)`)
    .run(
      sessionKey,
      sessionId,
      JSON.stringify({ sessionId, updatedAt: 1, delivery: { kind: "none" } }),
    );
  database
    .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
    .run(sessionKey);
}

function withDatabase(run: (database: DatabaseSync) => void, admitted = false) {
  const database = admitted ? openNodeSqliteDatabase(":memory:") : new DatabaseSync(":memory:");
  try {
    database.exec(OPENCLAW_AGENT_SCHEMA_SQL);
    if (admitted) {
      admitSqliteSchema(database);
    }
    run(database);
  } finally {
    if (database.isOpen) {
      database.close();
    }
  }
}

describe("canonical validation schema admission", () => {
  const missingTable = expect.objectContaining({
    name: "SessionMetadataUnavailableError",
    reason: "table-missing",
    missingTables: ["session_canonical_validation_pending"],
    cause: expect.objectContaining({ message: expect.stringMatching(/missing or drifted/u) }),
  });
  it("carries expected definitions to a fresh retention reader without trusting its actual schema", async ({
    signal,
  }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pathname = state.path("canonical-handoff.sqlite");
      const seed = new DatabaseSync(pathname);
      try {
        seed.exec(OPENCLAW_AGENT_SCHEMA_SQL);
        seed.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};
          INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
          VALUES ('primary', 'agent', ${OPENCLAW_AGENT_SCHEMA_VERSION}, 'main', 1, 1);`);
        assertCanonicalSessionValidationSchema(seed);
      } finally {
        seed.close();
      }
      const host = observeHostDataSql();
      let contract: ReturnType<typeof captureCanonicalSessionValidationSchema>;
      try {
        contract = captureCanonicalSessionValidationSchema();
        expect(host.queries).toEqual([]);
      } finally {
        host.restore();
      }
      assert(contract);
      const log = state.path("expected-definitions.log");
      const preload = state.path("observe-expected-definitions.cjs");
      writeFileSync(
        preload,
        `const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const comparisons = new WeakSet();
const record = (kind) => fs.appendFileSync(${JSON.stringify(log)}, kind + '\\n');
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) {
  const result = exec.call(this, sql);
  if (this.location() === null && sql.includes('CREATE TABLE IF NOT EXISTS session_canonical_validation_pending')) {
    comparisons.add(this);
    record('comparison-ddl');
  }
  return result;
};
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql) {
  const statement = prepare.call(this, sql);
  if (comparisons.has(this) && sql.startsWith('SELECT name, sql FROM main.sqlite_schema')) {
    const all = statement.all;
    statement.all = function(...bindings) {
      const rows = all.apply(this, bindings);
      record('expected-definitions');
      return rows;
    };
  }
  return statement;
};`,
      );
      const preloadEnv = sqliteWorkerPreloadEnv(preload);
      const expectedIdentity = readDatabasePathIdentitySync(pathname);
      await withEnvAsync(preloadEnv, async () => {
        for (const carry of [false, true]) {
          writeFileSync(log, "");
          // Each fresh history worker starts without an inherited expected-contract cache.
          await maintenanceLane.pool.rotate();
          const factKey = "openclaw.agentCanonicalValidationSchemaDefinitions";
          const inherited = getEnvironmentData(factKey);
          setEnvironmentData(factKey, undefined);
          const reader = retainSessionHistoryWorkerDatabase(
            { agentId: "main", path: pathname, env: state.env },
            maintenanceLane,
          );
          const read = () =>
            reader.owner.readTrajectoryRetention(
              {
                input: { sessionId: "retained" },
                now: 1,
                schemaContract: carry ? contract : undefined,
                expectedIdentity,
                env: { ...state.env, ...preloadEnv },
              },
              { signal, timeoutMs: 60_000 },
            );
          try {
            await expect(read()).resolves.toMatchObject({ sessionId: "retained", runs: [] });
            expect(readFileSync(log, "utf8")).toBe(
              carry ? "" : "comparison-ddl\nexpected-definitions\n",
            );
            if (carry) {
              const driftedPath = state.path("canonical-handoff-drifted.sqlite");
              copyFileSync(pathname, driftedPath);
              const changed = new DatabaseSync(driftedPath);
              try {
                changed.exec(
                  "CREATE TRIGGER unexpected_node_validation AFTER UPDATE ON session_nodes BEGIN SELECT 1; END",
                );
              } finally {
                changed.close();
              }
              const driftedReader = retainSessionHistoryWorkerDatabase(
                { agentId: "main", path: driftedPath, env: state.env },
                maintenanceLane,
              );
              try {
                await expect(
                  driftedReader.owner.readTrajectoryRetention(
                    {
                      input: { sessionId: "retained" },
                      now: 1,
                      schemaContract: contract,
                      expectedIdentity: readDatabasePathIdentitySync(driftedPath),
                      env: { ...state.env, ...preloadEnv },
                    },
                    { signal, timeoutMs: 60_000 },
                  ),
                ).rejects.toThrow(/canonical validation schema is missing or drifted/u);
              } finally {
                driftedReader.release();
              }
            }
          } finally {
            setEnvironmentData(factKey, inherited);
            reader.release();
            await maintenanceLane.pool.rotate();
          }
        }
      });
    });
  });
  it("reuses admitted comparison and runtime facts through an older worker carrier without hiding schema drift", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const factKeys = [
        "openclaw.sqliteNativeRuntimeAdmission",
        "openclaw.agentCanonicalValidationSchemaDefinitions",
      ] as const;
      const originalFacts = factKeys.map((name) => getEnvironmentData(name));
      const installFacts = (values: Parameters<typeof setEnvironmentData>[1][]) =>
        factKeys.forEach((name, index) => setEnvironmentData(name, values[index]));
      let closeSource: Parameters<RuntimeWorkerGeneration["retain"]>[1] | undefined;
      const source = captureRetainedNativeWorkerSource({
        runtimeGeneration: {
          resolve: (url) => url,
          retain: (_owner, close) => {
            closeSource = close;
          },
        },
      });
      const children: RetainedNativeWorker[] = [];
      source.retain({}, async () => {
        await Promise.all(children.map((child) => child.terminate()));
      });
      const pathname = state.path("worker-admission.sqlite");
      const spawn = () => {
        const worker = source.create(
          `
          const { parentPort, workerData } = require("node:worker_threads");
          const { DatabaseSync, StatementSync } = require("node:sqlite");
          const reads = [], executions = [];
          for (const method of ["get", "all", "run", "iterate"]) {
            const original = StatementSync.prototype[method];
            StatementSync.prototype[method] = function(...args) {
              reads.push(this.sourceSQL);
              return Reflect.apply(original, this, args);
            };
          }
          const originalExec = DatabaseSync.prototype.exec;
          DatabaseSync.prototype.exec = function(sql) {
            executions.push(sql);
            return Reflect.apply(originalExec, this, [sql]);
          };
          let database, canonical;
          parentPort.on("message", async (command) => {
            if (command === "ping") {
              parentPort.postMessage({ ready: true });
              return;
            }
            reads.length = executions.length = 0;
            let error;
            try {
              if (!database) {
                const { register } = await import(workerData.loader);
                register();
                const native = await import(workerData.native);
                canonical = await import(workerData.canonical);
                database = native.openNodeSqliteDatabase(workerData.pathname, { readOnly: true });
              }
              canonical.assertCanonicalSessionValidationSchema(database);
            } catch (caught) {
              error = caught.message;
            }
            parentPort.postMessage({
              error,
              nativeProbes: reads.filter((sql) => /sqlite_(?:version|compileoption_used)\\(/u.test(sql)).length,
              comparisonBootstraps: executions.filter((sql) => sql !== workerData.schemaSql && sql.includes("CREATE TABLE IF NOT EXISTS session_canonical_validation_pending")).length,
              diagnosticBootstraps: executions.filter((sql) => sql === workerData.schemaSql).length,
              catalogReads: reads.filter((sql) => sql.includes("FROM main.sqlite_schema")).length,
            });
          });
        `,
          {
            eval: true,
            execArgv: [],
            workerData: {
              pathname,
              schemaSql: OPENCLAW_AGENT_SCHEMA_SQL,
              loader: import.meta.resolve("tsx/esm/api"),
              native: new URL("../infra/node-sqlite.ts", import.meta.url).href,
              canonical: new URL("./openclaw-agent-canonical-validation-schema.ts", import.meta.url)
                .href,
            },
          },
        );
        children.push(worker);
        let pending: ReturnType<typeof createDeferredCore<unknown>>;
        worker.on("message", (value) => pending.resolve(value));
        worker.on("error", (error) => pending.reject(error));
        return (command = "read") => {
          pending = createDeferredCore<unknown>();
          worker.postMessage(command, []);
          return pending.promise;
        };
      };
      let database: DatabaseSync | undefined;
      try {
        installFacts([]);
        await spawn()("ping");
        installFacts(originalFacts);
        database = openNodeSqliteDatabase(pathname);
        database.exec(OPENCLAW_AGENT_SCHEMA_SQL);
        assertCanonicalSessionValidationSchema(database);
        const admittedFacts = factKeys.map((name) => getEnvironmentData(name));
        const read = spawn();
        const admitted = await read();
        database.exec(
          "CREATE TRIGGER unexpected_node_validation AFTER UPDATE ON session_nodes BEGIN SELECT 1; END",
        );
        const drifted = await read();
        database.exec("DROP TRIGGER unexpected_node_validation");
        installFacts([]);
        const absent = await spawn()();
        const canonicalFact = admittedFacts[1];
        installFacts([
          admittedFacts[0],
          {
            ...(canonicalFact && typeof canonicalFact === "object" ? canonicalFact : {}),
            sourceHash: "another schema",
          },
        ]);
        const differentSource = await spawn()();
        expect(admitted).toMatchObject({
          error: undefined,
          nativeProbes: 0,
          comparisonBootstraps: 0,
          diagnosticBootstraps: 0,
        });
        assert(admitted && typeof admitted === "object" && "catalogReads" in admitted);
        expect(admitted.catalogReads).toBeLessThanOrEqual(1);
        expect(drifted).toMatchObject({
          error: expect.stringMatching(/canonical validation schema is missing or drifted/u),
          nativeProbes: 0,
          comparisonBootstraps: 0,
        });
        assert(drifted && typeof drifted === "object" && "catalogReads" in drifted);
        expect(drifted.catalogReads).toBeGreaterThan(0);
        expect(absent).toMatchObject({
          error: undefined,
          comparisonBootstraps: 1,
        });
        assert(absent && typeof absent === "object" && "nativeProbes" in absent);
        expect(absent.nativeProbes).toBeGreaterThan(0);
        expect(differentSource).toMatchObject({
          error: undefined,
          nativeProbes: 0,
          comparisonBootstraps: 1,
        });
      } finally {
        database?.close();
        installFacts(originalFacts);
        const retire = await closeSource?.();
        if (retire) {
          await retire();
        }
      }
    });
  });
  it("refuses a drifted canonical trigger at read-only open", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pathname = state.path("drifted.sqlite");
      const seed = new DatabaseSync(pathname);
      try {
        seed.exec(OPENCLAW_AGENT_SCHEMA_SQL);
        seed.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};
          INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
          VALUES ('primary', 'agent', ${OPENCLAW_AGENT_SCHEMA_VERSION}, 'main', 1, 1);
          CREATE TRIGGER unexpected_node_validation AFTER UPDATE ON session_nodes BEGIN SELECT 1; END;`);
      } finally {
        seed.close();
      }
      expect(() => {
        const opened = openOpenClawAgentDatabaseReadOnly({
          agentId: "main",
          path: pathname,
          env: state.env,
        });
        if (opened.found) {
          opened.database.close();
        }
      }).toThrow(/canonical validation schema is missing or drifted.*openclaw doctor --fix/u);
    });
  });
  it.each(
    [
      "DROP TABLE session_canonical_validation_pending",
      "CREATE TRIGGER unexpected_node_validation AFTER UPDATE ON session_nodes BEGIN SELECT 1; END",
      "CREATE TRIGGER unexpected_window_validation AFTER DELETE ON session_windows BEGIN SELECT 1; END",
      "CREATE TRIGGER unexpected_key_validation AFTER UPDATE ON session_key_contract BEGIN SELECT 1; END",
      `CREATE TRIGGER clear_canonical_pending AFTER INSERT ON session_canonical_validation_pending
      BEGIN DELETE FROM session_canonical_validation_pending; END`,
      `CREATE TRIGGER session_canonical_validation_pending AFTER INSERT ON conversations
      BEGIN DELETE FROM session_canonical_validation_pending; END`,
    ].flatMap((change) => [false, true].map((admitted) => ({ change, admitted }))),
  )(
    "rejects changed required schema after cached admission, admitted=$admitted (%#)",
    ({ change, admitted }) => {
      withDatabase((database) => {
        assertCanonicalSessionValidationSchema(database);
        database.exec(change);
        expect(() => assertCanonicalSessionValidationSchema(database)).toThrow(
          change.startsWith("DROP TABLE")
            ? missingTable
            : /canonical validation schema is missing or drifted/u,
        );
      }, admitted);
    },
  );

  it("does not reuse validation performed inside a rolled-back schema transaction", () => {
    withDatabase((database) => {
      database.exec("BEGIN; CREATE TABLE temporary_shape (id INTEGER)");
      assertCanonicalSessionValidationSchema(database);
      database.exec(
        "ROLLBACK; CREATE TRIGGER unexpected_node_validation AFTER DELETE ON session_nodes BEGIN SELECT 1; END",
      );
      expect(() => assertCanonicalSessionValidationSchema(database)).toThrow(/missing or drifted/u);
    });
  });
});

describe("agent schema 21 migration", () => {
  it("seeds all rows without parsing their contents when migrating schema 20", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pathname = state.path("pre-validation.sqlite");
      const database = new DatabaseSync(pathname);
      try {
        database.exec(withoutCanonicalSessionValidationSchema(OPENCLAW_AGENT_SCHEMA_V21_SQL));
        database.exec(`PRAGMA user_version = 20;
          INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
          VALUES ('primary', 'agent', 20, 'main', 1, 1)`);
        insertNode(database, key, "target");
        insertNode(database, sibling, "sibling");
        database
          .prepare("UPDATE session_nodes SET entry_json = '{' WHERE session_key = ?")
          .run(sibling);
        const before = database
          .prepare("SELECT *, 0 AS snapshot_revision FROM session_nodes ORDER BY session_key")
          .all();
        await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
          ensureOpenClawAgentDatabaseSchema(database, {
            agentId: "main",
            env: state.env,
            path: pathname,
          });
        });
        expect(
          database
            .prepare("SELECT * FROM session_nodes ORDER BY session_key")
            .all()
            .map(
              ({
                session_started_at: _sessionStartedAt,
                has_optional_references: _hasOptionalReferences,
                ...row
              }) => row,
            ),
        ).toEqual(before);
        expect(pendingKeys(database)).toEqual([key, sibling].toSorted());
        expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(
          OPENCLAW_AGENT_SCHEMA_VERSION,
        );
        expect(
          database
            .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
            .get()?.schema_version,
        ).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
        assertCanonicalSessionValidationSchema(database);
      } finally {
        database.close();
      }
    });
  });

  it("rolls back schema installation, pending seed and version publication together", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pathname = state.path("interrupted-validation.sqlite");
      const database = new DatabaseSync(pathname);
      try {
        database.exec(withoutCanonicalSessionValidationSchema(OPENCLAW_AGENT_SCHEMA_V21_SQL));
        database.exec(`PRAGMA user_version = 20;
          INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
          VALUES ('primary', 'agent', 20, 'main', 1, 1)`);
        insertNode(database, key, "target");
        await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
          database.setAuthorizer((action, name, value) =>
            action === constants.SQLITE_PRAGMA &&
            name === "user_version" &&
            value === String(OPENCLAW_AGENT_SCHEMA_VERSION)
              ? constants.SQLITE_DENY
              : constants.SQLITE_OK,
          );
          try {
            expect(() =>
              ensureOpenClawAgentDatabaseSchema(database, {
                agentId: "main",
                env: state.env,
                path: pathname,
              }),
            ).toThrow(/authoriz/u);
          } finally {
            database.setAuthorizer(null);
          }
          expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(20);
          expect(
            database
              .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
              .get()?.schema_version,
          ).toBe(20);
          expect(
            database
              .prepare(
                "SELECT name FROM sqlite_schema WHERE name = 'session_canonical_validation_pending'",
              )
              .get(),
          ).toBeUndefined();
          ensureOpenClawAgentDatabaseSchema(database, {
            agentId: "main",
            env: state.env,
            path: pathname,
          });
          expect(pendingKeys(database)).toEqual([key]);
          assertCanonicalSessionValidationSchema(database);
        });
      } finally {
        database.close();
      }
    });
  });
});

describe("agent schema 25 migration", () => {
  it.each(["commit", "missing-column", "rollback", "drift"] as const)(
    "retires writer bookkeeping with pending validation and source preservation (%s)",
    async (outcome) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const pathname = state.path("canonical-v24.sqlite");
        const database = new DatabaseSync(pathname);
        try {
          database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
          database.exec(OPENCLAW_AGENT_SCHEMA_V24_SQL);
          database.exec(`PRAGMA user_version = 24;
            INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
            VALUES ('primary', 'agent', 24, 'main', 1, 1)`);
          insertNode(database, key, "target");
          insertNode(database, sibling, "sibling");
          database
            .prepare("UPDATE session_nodes SET entry_json = '{' WHERE session_key = ?")
            .run(sibling);
          database.exec(`UPDATE session_nodes SET entry_valid = 1;
            DELETE FROM session_canonical_validation_pending;
            UPDATE session_key_contract SET canonical_ready = 'old-physical-receipt' WHERE id = 1`);
          if (outcome === "missing-column") {
            database.exec("ALTER TABLE session_key_contract DROP COLUMN canonical_ready");
          }
          if (outcome === "drift") {
            database.exec("DROP TRIGGER session_nodes_canonical_pending_after_update");
          }
          database.exec(`
            INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
            VALUES ('target', '${key}', 1, 2), ('previous-target', '${key}', 1, 1);
            INSERT INTO transcript_rewrite_watermarks (session_id, generation, updated_at)
            VALUES ('target', 'current-generation', 2), ('previous-target', 'previous-generation', 1);
            INSERT INTO session_entry_snapshots (session_key, field, value_json)
            VALUES ('${key}', 'skillsSnapshot', '{"skills":[]}');
            CREATE VIEW retained_session_view AS SELECT session_key, current_session_id FROM session_nodes;
            PRAGMA wal_checkpoint(TRUNCATE);
            INSERT INTO transcript_events (session_id, seq, event_json, created_at)
            VALUES ('target', 1, '{"id":"migration-wal-sentinel","type":"message"}', 2),
              ('previous-target', 1, '{"id":"previous-generation-history","type":"message"}', 1);
            DELETE FROM session_canonical_validation_pending;
          `);
          expect(readFileSync(pathname).includes(Buffer.from("migration-wal-sentinel"))).toBe(
            false,
          );
          let original;
          const reader = new DatabaseSync(pathname, { readOnly: true });
          try {
            original =
              outcome === "drift"
                ? undefined
                : captureOpenClawMigrationWitness(reader, { role: "agent", agentId: "main" });
          } finally {
            reader.close();
          }
          if (outcome === "drift") {
            expect(() =>
              captureOpenClawMigrationWitness(database, { role: "agent", agentId: "main" }),
            ).toThrow(/trigger/u);
          }
          const before = {
            schema: database.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all(),
            nodes: database.prepare("SELECT * FROM session_nodes ORDER BY session_key").all(),
          };
          if (outcome === "rollback") {
            database.setAuthorizer((action, name, value) =>
              action === constants.SQLITE_PRAGMA &&
              name === "user_version" &&
              value === String(OPENCLAW_AGENT_SCHEMA_VERSION)
                ? constants.SQLITE_DENY
                : constants.SQLITE_OK,
            );
          }
          await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
            const migrate = () =>
              ensureOpenClawAgentDatabaseSchema(database, {
                agentId: "main",
                env: state.env,
                path: pathname,
              });
            if (outcome === "commit" || outcome === "missing-column") {
              migrate();
            } else {
              expect(migrate).toThrow(outcome === "rollback" ? /authoriz/u : /trigger/u);
            }
          });
          database.setAuthorizer(null);
          expect(
            database.prepare("SELECT * FROM session_nodes ORDER BY session_key").all(),
          ).toMatchObject(before.nodes);
          if (original) {
            const current = captureOpenClawMigrationWitness(database, {
              role: "agent",
              agentId: "main",
            });
            expect(assertOpenClawMigrationWitnessPreserved(original, current).warnings).toEqual([
              "Preexisting session history gap: missingWindows (1)",
            ]);
            expect(() =>
              assertOpenClawMigrationWitnessPreserved(original, { ...current, version: 2 }),
            ).toThrow();
            if (outcome === "commit") {
              for (const mutation of [
                "DELETE FROM transcript_events WHERE session_id = 'previous-target'",
                "UPDATE transcript_events SET event_json = '{}' WHERE session_id = 'target'",
                "DELETE FROM session_entry_snapshots",
                "UPDATE transcript_rewrite_watermarks SET generation = 'replacement-generation'",
                "DROP VIEW retained_session_view",
              ]) {
                database.exec("SAVEPOINT lost_history");
                database.exec(mutation);
                expect(() =>
                  assertOpenClawMigrationWitnessPreserved(
                    original,
                    captureOpenClawMigrationWitness(database, { role: "agent", agentId: "main" }),
                  ),
                ).toThrow(/changed or lost/u);
                database.exec("ROLLBACK TO lost_history; RELEASE lost_history");
              }
              database.exec(`SAVEPOINT retired_trigger;
                CREATE TRIGGER session_nodes_entry_valid_after_insert
                AFTER INSERT ON session_nodes BEGIN SELECT 1; END`);
              expect(() =>
                captureOpenClawMigrationWitness(database, { role: "agent", agentId: "main" }),
              ).toThrow(/trigger/u);
              database.exec("ROLLBACK TO retired_trigger; RELEASE retired_trigger");
            }
          }
          if (outcome === "rollback" || outcome === "drift") {
            expect(
              database.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all(),
            ).toEqual(before.schema);
            expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(24);
            expect(
              database.prepare("SELECT canonical_ready FROM session_key_contract").get()
                ?.canonical_ready,
            ).toBe("old-physical-receipt");
            expect(pendingKeys(database)).toEqual([]);
            return;
          }
          expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(
            OPENCLAW_AGENT_SCHEMA_VERSION,
          );
          expect(
            database.prepare("SELECT schema_version FROM schema_meta").get()?.schema_version,
          ).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
          expect(
            database.prepare("SELECT canonical_ready FROM session_key_contract").get()
              ?.canonical_ready,
          ).toBeNull();
          expect(pendingKeys(database)).toEqual([key, sibling].toSorted());
          assertCanonicalSessionValidationSchema(database);
          const batch = readPendingCanonicalSessionValidationBatch(
            { agentId: "main", db: database },
            { maxRows: 10, maxBytes: 100_000 },
          );
          expect(() => validateCanonicalSessionValidationBatch(batch)).toThrow(
            /invalid persisted session row/u,
          );
          database.exec("DELETE FROM session_canonical_validation_pending");
          database
            .prepare(
              "UPDATE session_nodes SET entry_json = ?, entry_valid = 1 WHERE session_key = ?",
            )
            .run(
              JSON.stringify({ sessionId: "target", updatedAt: 2, delivery: { kind: "none" } }),
              key,
            );
          expect(
            database.prepare("SELECT entry_valid FROM session_nodes WHERE session_key = ?").get(key)
              ?.entry_valid,
          ).toBe(1);
          expect(pendingKeys(database)).toEqual([]);
        } finally {
          database.setAuthorizer(null);
          database.close();
        }
      });
    },
  );
});
