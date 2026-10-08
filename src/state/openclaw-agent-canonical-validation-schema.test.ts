import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { constants, DatabaseSync } from "node:sqlite";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
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
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

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
    .run(sessionKey, sessionId, JSON.stringify({ sessionId, updatedAt: 1 }));
  database
    .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
    .run(sessionKey);
}

function insertWindow(database: DatabaseSync, sessionKey: string, sessionId: string) {
  database
    .prepare(`INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
      VALUES (?, ?, 1, 1)`)
    .run(sessionId, sessionKey);
}

function clearPending(database: DatabaseSync) {
  database.exec("DELETE FROM session_canonical_validation_pending");
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

describe("canonical session validation invalidation", () => {
  it.each([
    ["entry_json", '{"sessionId":"target","updatedAt":2}'],
    ["current_session_id", "replacement"],
    ["entry_valid", 0],
    ["parent_session_key", "agent:main:parent"],
    ["spawned_by", "agent:main:spawner"],
    ["fork_source_session_key", "agent:main:fork"],
    ["updated_at", 2],
  ] as const)("records a raw %s edit without invalidating a sibling", (column, value) => {
    withDatabase((database) => {
      insertNode(database, key, "target");
      insertNode(database, sibling, "sibling");
      clearPending(database);
      database
        .prepare(`UPDATE session_nodes SET ${column} = ? WHERE session_key = ?`)
        .run(value, key);
      expect(pendingKeys(database)).toEqual([key]);
      // An older writer can settle its validity flag, but cannot certify the newer contract.
      database.prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?").run(key);
      expect(pendingKeys(database)).toEqual([key]);
    });
  });

  it("records insertion and replaces a renamed marker without requiring foreign keys", () => {
    withDatabase((database) => {
      database.exec("PRAGMA foreign_keys = OFF");
      insertNode(database, key, "target");
      expect(pendingKeys(database)).toEqual([key]);
      database
        .prepare("UPDATE session_nodes SET session_key = ? WHERE session_key = ?")
        .run(sibling, key);
      expect(pendingKeys(database)).toEqual([sibling]);
      database.prepare("DELETE FROM session_nodes WHERE session_key = ?").run(sibling);
      expect(pendingKeys(database)).toEqual([]);
    });
  });

  it("preserves pending work under outer REPLACE and IGNORE conflict policies", () => {
    withDatabase((database) => {
      insertNode(database, key, "target");
      insertNode(database, sibling, "sibling");
      database
        .prepare("UPDATE OR REPLACE session_nodes SET session_key = ? WHERE session_key = ?")
        .run(sibling, key);
      expect(pendingKeys(database)).toEqual([sibling]);
      database
        .prepare("UPDATE OR IGNORE session_nodes SET spawned_by = ? WHERE session_key = ?")
        .run(key, sibling);
      expect(pendingKeys(database)).toEqual([sibling]);
      database
        .prepare(`INSERT OR REPLACE INTO session_nodes
        (session_key, current_session_id, entry_json, updated_at) VALUES (?, 'again', '{}', 2)`)
        .run(sibling);
      expect(pendingKeys(database)).toEqual([sibling]);
    });
  });

  it("invalidates both old and new retained-window associations", () => {
    withDatabase((database) => {
      insertNode(database, key, "old-window");
      insertNode(database, sibling, "new-window");
      clearPending(database);
      insertWindow(database, key, "old-window");
      expect(pendingKeys(database)).toEqual([key]);
      clearPending(database);
      database
        .prepare("UPDATE session_windows SET session_id = ?, session_key = ? WHERE session_id = ?")
        .run("new-window", sibling, "old-window");
      expect(pendingKeys(database)).toEqual([sibling, key].toSorted());
      clearPending(database);
      database
        .prepare("UPDATE session_windows SET session_key = ? WHERE session_id = ?")
        .run(key, "new-window");
      expect(pendingKeys(database)).toEqual([sibling]);
      clearPending(database);
      database.prepare("DELETE FROM session_windows WHERE session_id = ?").run("new-window");
      expect(pendingKeys(database)).toEqual([sibling]);
    });
  });

  it("does not dirty unrelated windows or unchanged lineage and policy values", () => {
    withDatabase((database) => {
      insertNode(database, key, "target");
      insertWindow(database, key, "target");
      clearPending(database);
      database.exec(`
        UPDATE session_nodes SET parent_session_key = parent_session_key, label = 'new label';
        UPDATE session_windows SET session_key = session_key, updated_at = 2;
        UPDATE session_key_contract SET main_key = main_key, updated_at = 2;
      `);
      insertWindow(database, key, "historical-window");
      database.prepare("DELETE FROM session_windows WHERE session_id = ?").run("historical-window");
      expect(pendingKeys(database)).toEqual([]);
    });
  });

  it.each(["insert", "update", "delete"] as const)(
    "invalidates every node on policy %s",
    (action) => {
      withDatabase((database) => {
        insertNode(database, key, "target");
        insertNode(database, sibling, "sibling");
        if (action === "insert") {
          database.exec("DELETE FROM session_key_contract");
        }
        clearPending(database);
        if (action === "insert") {
          database.exec(
            "INSERT INTO session_key_contract (id, main_key, updated_at) VALUES (1, 'work', 2)",
          );
        } else if (action === "update") {
          database.exec("UPDATE session_key_contract SET main_key = 'work'");
        } else {
          database.exec("DELETE FROM session_key_contract");
        }
        expect(pendingKeys(database)).toEqual([key, sibling].toSorted());
      });
    },
  );

  it("rolls back invalidation and marker removal with their data changes", () => {
    withDatabase((database) => {
      insertNode(database, key, "target");
      clearPending(database);
      database.exec("BEGIN IMMEDIATE");
      database
        .prepare("UPDATE session_nodes SET spawned_by = ? WHERE session_key = ?")
        .run(sibling, key);
      expect(pendingKeys(database)).toEqual([key]);
      database.exec("ROLLBACK");
      expect(pendingKeys(database)).toEqual([]);
      database
        .prepare("UPDATE session_nodes SET spawned_by = ? WHERE session_key = ?")
        .run(sibling, key);
      database.exec("BEGIN IMMEDIATE");
      clearPending(database);
      database.exec("ROLLBACK");
      expect(pendingKeys(database)).toEqual([key]);
    });
  });
});

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
              const changed = new DatabaseSync(pathname);
              try {
                changed.exec("DROP TRIGGER session_nodes_canonical_pending_after_update");
              } finally {
                changed.close();
              }
              await expect(read()).rejects.toThrow(
                /canonical validation schema is missing or drifted/u,
              );
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
        database.exec("DROP TRIGGER session_nodes_canonical_pending_after_update");
        const drifted = await read();
        database.exec(OPENCLAW_AGENT_SCHEMA_SQL);
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
          DROP TRIGGER session_nodes_canonical_pending_after_update;`);
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
      "DROP TRIGGER session_nodes_canonical_pending_after_update",
      "DROP TRIGGER session_windows_canonical_pending_after_delete",
      "DROP TRIGGER session_key_contract_canonical_pending_after_update",
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
      database.exec("ROLLBACK; DROP TRIGGER session_nodes_canonical_pending_after_delete");
      expect(() => assertCanonicalSessionValidationSchema(database)).toThrow(/missing or drifted/u);
    });
  });

  it.each(["close", "dispose"] as const)(
    "invalidates native %s before the same object reopens",
    (action) => {
      withDatabase((database) => {
        assertCanonicalSessionValidationSchema(database);
        const cookie = database.prepare("PRAGMA schema_version").get()?.schema_version;
        assert(typeof cookie === "number");
        if (action === "close") {
          database.close();
        } else {
          database[Symbol.dispose]();
        }
        database.open();
        database.exec(withoutCanonicalSessionValidationSchema(OPENCLAW_AGENT_SCHEMA_SQL));
        database.exec(`PRAGMA schema_version = ${cookie}`);
        expect(() => assertCanonicalSessionValidationSchema(database)).toThrow(missingTable);
      });
    },
  );

  it.runIf(typeof DatabaseSync.prototype.deserialize === "function")(
    "invalidates deserialized schema even when the cookie is unchanged",
    () => {
      withDatabase((database) => {
        assertCanonicalSessionValidationSchema(database);
        const cookie = database.prepare("PRAGMA schema_version").get()?.schema_version;
        assert(typeof cookie === "number");
        const replacement = new DatabaseSync(":memory:");
        try {
          replacement.exec(withoutCanonicalSessionValidationSchema(OPENCLAW_AGENT_SCHEMA_SQL));
          replacement.exec(`PRAGMA schema_version = ${cookie}`);
          database.deserialize(replacement.serialize());
          expect(() => assertCanonicalSessionValidationSchema(database)).toThrow(missingTable);
        } finally {
          replacement.close();
        }
      });
    },
  );
});

describe("agent schema 21 migration", () => {
  it("seeds all rows without parsing their contents and keeps already-open writers observable", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pathname = state.path("pre-validation.sqlite");
      const database = new DatabaseSync(pathname);
      let oldWriter: DatabaseSync | undefined;
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
        oldWriter = new DatabaseSync(pathname);
        const oldWrite = oldWriter.prepare(
          "UPDATE session_nodes SET parent_session_key = ? WHERE session_key = ?",
        );
        await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
          ensureOpenClawAgentDatabaseSchema(database, {
            agentId: "main",
            env: state.env,
            path: pathname,
          });
        });
        expect(database.prepare("SELECT * FROM session_nodes ORDER BY session_key").all()).toEqual(
          before,
        );
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
        clearPending(database);
        oldWrite.run(sibling, key);
        expect(pendingKeys(database)).toEqual([key]);
      } finally {
        oldWriter?.close();
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
