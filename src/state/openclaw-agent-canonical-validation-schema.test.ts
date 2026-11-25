import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { constants, DatabaseSync } from "node:sqlite";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import {
  readPendingCanonicalSessionValidationBatch,
  validateCanonicalSessionValidationBatch,
} from "../config/sessions/session-canonical-validation.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import type { RuntimeWorkerGeneration } from "../infra/runtime-worker-generation.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import { captureRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import type { RetainedNativeWorker } from "../infra/worker-native-lifecycle.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  assertCanonicalSessionValidationSchema as assertSchema,
  canonicalSessionValidationSchemaSql,
} from "./openclaw-agent-canonical-validation-schema.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION as currentVersion } from "./openclaw-agent-db-contract.js";
import { withAgentDatabaseMaintenanceLease as withMaintenance } from "./openclaw-agent-db-maintenance-lease.js";
import { openOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly-open.js";
import { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
import { OPENCLAW_AGENT_SCHEMA_V21_SQL } from "./openclaw-agent-schema-v21.test-support.js";
import { OPENCLAW_AGENT_SCHEMA_V24_SQL } from "./openclaw-agent-schema-v24.test-support.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import {
  assertOpenClawMigrationWitnessPreserved as assertPreserved,
  captureOpenClawMigrationWitness as captureWitness,
} from "./openclaw-migration-witness.js";

const key = "agent:main:target";
const sibling = "agent:main:sibling";
const witnessOwner = { role: "agent", agentId: "main" } as const;
const nodeRows = "SELECT * FROM session_nodes ORDER BY session_key";
const schemaRows = "SELECT name, sql FROM sqlite_schema ORDER BY name";
const pendingTable = "session_canonical_validation_pending";
const trigger = (name: string, table: string, event = "UPDATE", body = "SELECT 1") =>
  `CREATE TRIGGER ${name} AFTER ${event} ON ${table} BEGIN ${body}; END`;
const driftTrigger = trigger("unexpected_node_validation", "session_nodes");

const readVersion = (db: DatabaseSync) => ({
  user: db.prepare("PRAGMA user_version").get()?.user_version,
  schema: db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get()
    ?.schema_version,
});

function denyVersionPublication(db: DatabaseSync) {
  db.setAuthorizer((action, name, value) =>
    action === constants.SQLITE_PRAGMA &&
    name === "user_version" &&
    value === String(currentVersion)
      ? constants.SQLITE_DENY
      : constants.SQLITE_OK,
  );
}

type MigrationFixture = {
  db: DatabaseSync;
  migrate: () => void;
  env: NodeJS.ProcessEnv;
  pathname: string;
};

function withMigrationDatabase(
  version: 20 | 24,
  run: (fixture: MigrationFixture) => Promise<void>,
) {
  return withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const pathname = state.path("migration.sqlite");
    const db = new DatabaseSync(pathname);
    try {
      if (version === 24) {
        db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
      }
      db.exec(version === 20 ? schema20 : OPENCLAW_AGENT_SCHEMA_V24_SQL);
      db.exec(`PRAGMA user_version = ${version};
        INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
        VALUES ('primary', 'agent', ${version}, 'main', 1, 1)`);
      const options = { agentId: "main", env: state.env, path: pathname };
      await run({
        db,
        env: state.env,
        pathname,
        migrate: () => ensureOpenClawAgentDatabaseSchema(db, options),
      });
    } finally {
      db.setAuthorizer(null);
      db.close();
    }
  });
}

const schema20 = OPENCLAW_AGENT_SCHEMA_V21_SQL.replace(
  canonicalSessionValidationSchemaSql(OPENCLAW_AGENT_SCHEMA_V21_SQL),
  "",
);

function pendingKeys(db: DatabaseSync) {
  return db
    .prepare(`SELECT session_key FROM ${pendingTable} ORDER BY session_key`)
    .all()
    .map((row) => row.session_key);
}

function insertNode(db: DatabaseSync, sessionKey: string, sessionId: string) {
  db.prepare(`INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
      VALUES (?, ?, ?, 1)`).run(
    sessionKey,
    sessionId,
    JSON.stringify({ sessionId, updatedAt: 1, delivery: { kind: "none" } }),
  );
  db.prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?").run(sessionKey);
}

function insertMalformedSibling(db: DatabaseSync) {
  insertNode(db, sibling, "sibling");
  db.prepare("UPDATE session_nodes SET entry_json = '{' WHERE session_key = ?").run(sibling);
}

function withDatabase(run: (db: DatabaseSync) => void, admitted = false) {
  using db = admitted ? openNodeSqliteDatabase(":memory:") : new DatabaseSync(":memory:");
  db.exec(OPENCLAW_AGENT_SCHEMA_SQL);
  if (admitted) {
    admitSqliteSchema(db);
  }
  run(db);
}

describe("canonical validation schema admission", () => {
  const missingTable = expect.objectContaining({
    name: "SessionMetadataUnavailableError",
    reason: "table-missing",
    missingTables: ["session_canonical_validation_pending"],
    cause: expect.objectContaining({ message: expect.stringMatching(/missing or drifted/u) }),
  });
  it("avoids comparison SQL in fresh workers while forwarding runtime facts and detecting schema drift", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const factKey = "openclaw.sqliteNativeRuntimeAdmission";
      const originalFacts = getEnvironmentData(factKey);
      const installFacts = (value?: Parameters<typeof setEnvironmentData>[1]) =>
        setEnvironmentData(factKey, value);
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
      let db: DatabaseSync | undefined;
      try {
        installFacts();
        await spawn()("ping");
        installFacts(originalFacts);
        // Native runtime facts are ready; canonical admission has not run in the host.
        db = openNodeSqliteDatabase(pathname);
        db.exec(OPENCLAW_AGENT_SCHEMA_SQL);
        const read = spawn();
        const admitted = await read();
        db.exec(driftTrigger);
        const drifted = await read();
        db.exec("DROP TRIGGER unexpected_node_validation");
        installFacts();
        const absent = await spawn()();
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
          comparisonBootstraps: 0,
        });
        assert(absent && typeof absent === "object" && "nativeProbes" in absent);
        expect(absent.nativeProbes).toBeGreaterThan(0);
      } finally {
        db?.close();
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
        seed.exec(`PRAGMA user_version = ${currentVersion};
          INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
          VALUES ('primary', 'agent', ${currentVersion}, 'main', 1, 1);
          ${driftTrigger};`);
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
      `DROP TABLE ${pendingTable}`,
      driftTrigger,
      trigger("unexpected_window_validation", "session_windows", "DELETE"),
      trigger("unexpected_key_validation", "session_key_contract"),
      trigger("clear_canonical_pending", pendingTable, "INSERT", `DELETE FROM ${pendingTable}`),
      trigger(pendingTable, "conversations", "INSERT", `DELETE FROM ${pendingTable}`),
    ].flatMap((change) => [false, true].map((admitted) => ({ change, admitted }))),
  )(
    "rejects changed required schema after cached admission, admitted=$admitted (%#)",
    ({ change, admitted }) => {
      withDatabase((db) => {
        assertSchema(db);
        db.exec(change);
        expect(() => assertSchema(db)).toThrow(
          change.startsWith("DROP TABLE")
            ? missingTable
            : /canonical validation schema is missing or drifted/u,
        );
      }, admitted);
    },
  );

  it("does not reuse validation performed inside a rolled-back schema transaction", () => {
    withDatabase((db) => {
      db.exec("BEGIN; CREATE TABLE temporary_shape (id INTEGER)");
      assertSchema(db);
      db.exec(`ROLLBACK; ${trigger("unexpected_node_validation", "session_nodes", "DELETE")}`);
      expect(() => assertSchema(db)).toThrow(/missing or drifted/u);
    });
  });
});

it.each([false, true])(
  "migrates schema 20 without parsing rows (rollback first: %s)",
  async (rollback) => {
    await withMigrationDatabase(20, async ({ db, migrate, env }) => {
      insertNode(db, key, "target");
      if (!rollback) {
        insertMalformedSibling(db);
      }
      const before = db
        .prepare("SELECT *, 0 AS snapshot_revision FROM session_nodes ORDER BY session_key")
        .all();
      await withMaintenance({ env }, async () => {
        if (rollback) {
          denyVersionPublication(db);
          try {
            expect(migrate).toThrow(/authoriz/u);
          } finally {
            db.setAuthorizer(null);
          }
          expect(readVersion(db)).toEqual({ user: 20, schema: 20 });
          expect(
            db.prepare(`SELECT name FROM sqlite_schema WHERE name = '${pendingTable}'`).get(),
          ).toBeUndefined();
        }
        migrate();
      });
      expect(
        db
          .prepare(nodeRows)
          .all()
          .map(
            ({
              session_started_at: _sessionStartedAt,
              has_optional_references: _hasOptionalReferences,
              ...row
            }) => row,
          ),
      ).toEqual(before);
      expect(pendingKeys(db)).toEqual(rollback ? [key] : [key, sibling].toSorted());
      expect(readVersion(db)).toEqual({
        user: currentVersion,
        schema: currentVersion,
      });
      assertSchema(db);
    });
  },
);

it.each(["commit", "missing-column", "rollback", "drift"] as const)(
  "retires writer bookkeeping with pending validation and source preservation (%s)",
  async (outcome) => {
    await withMigrationDatabase(24, async ({ db, migrate, env, pathname }) => {
      insertNode(db, key, "target");
      insertMalformedSibling(db);
      db.exec(`UPDATE session_nodes SET entry_valid = 1;
            DELETE FROM session_canonical_validation_pending;
            UPDATE session_key_contract SET canonical_ready = 'old-physical-receipt' WHERE id = 1`);
      if (outcome === "missing-column") {
        db.exec("ALTER TABLE session_key_contract DROP COLUMN canonical_ready");
      }
      if (outcome === "drift") {
        db.exec("DROP TRIGGER session_nodes_canonical_pending_after_update");
      }
      db.exec(`
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
      expect(readFileSync(pathname).includes(Buffer.from("migration-wal-sentinel"))).toBe(false);
      const original = (() => {
        using reader = new DatabaseSync(pathname, { readOnly: true });
        return outcome === "drift" ? undefined : captureWitness(reader, witnessOwner);
      })();
      if (outcome === "drift") {
        expect(() => captureWitness(db, witnessOwner)).toThrow(/trigger/u);
      }
      const before = {
        schema: db.prepare(schemaRows).all(),
        nodes: db.prepare(nodeRows).all(),
      };
      if (outcome === "rollback") {
        denyVersionPublication(db);
      }
      await withMaintenance({ env }, async () => {
        if (outcome === "commit" || outcome === "missing-column") {
          migrate();
        } else {
          expect(migrate).toThrow(outcome === "rollback" ? /authoriz/u : /trigger/u);
        }
      });
      db.setAuthorizer(null);
      expect(db.prepare(nodeRows).all()).toMatchObject(before.nodes);
      if (original) {
        const current = captureWitness(db, witnessOwner);
        expect(assertPreserved(original, current).warnings).toEqual([
          "Preexisting session history gap: missingWindows (1)",
        ]);
        expect(() => assertPreserved(original, { ...current, version: 2 })).toThrow();
        if (outcome === "commit") {
          for (const mutation of [
            "DELETE FROM transcript_events WHERE session_id = 'previous-target'",
            "UPDATE transcript_events SET event_json = '{}' WHERE session_id = 'target'",
            "DELETE FROM session_entry_snapshots",
            "UPDATE session_windows SET transcript_updated_at = 42 WHERE session_id = 'target'",
            "UPDATE transcript_rewrite_watermarks SET generation = 'replacement-generation'",
            "DROP VIEW retained_session_view",
          ]) {
            db.exec("SAVEPOINT lost_history");
            db.exec(mutation);
            expect(() => assertPreserved(original, captureWitness(db, witnessOwner))).toThrow(
              /changed or lost/u,
            );
            db.exec("ROLLBACK TO lost_history; RELEASE lost_history");
          }
          db.exec(
            `SAVEPOINT retired_trigger; ${trigger("session_nodes_entry_valid_after_insert", "session_nodes", "INSERT")}`,
          );
          expect(() => captureWitness(db, witnessOwner)).toThrow(/trigger/u);
          db.exec("ROLLBACK TO retired_trigger; RELEASE retired_trigger");
        }
      }
      if (outcome === "rollback" || outcome === "drift") {
        expect(db.prepare(schemaRows).all()).toEqual(before.schema);
        expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(24);
        expect(
          db.prepare("SELECT canonical_ready FROM session_key_contract").get()?.canonical_ready,
        ).toBe("old-physical-receipt");
        expect(pendingKeys(db)).toEqual([]);
        return;
      }
      expect(readVersion(db)).toEqual({
        user: currentVersion,
        schema: currentVersion,
      });
      expect(
        db.prepare("SELECT canonical_ready FROM session_key_contract").get()?.canonical_ready,
      ).toBeNull();
      expect(pendingKeys(db)).toEqual([key, sibling].toSorted());
      assertSchema(db);
      const batch = readPendingCanonicalSessionValidationBatch(
        { agentId: "main", db },
        { maxRows: 10, maxBytes: 100_000 },
      );
      expect(() => validateCanonicalSessionValidationBatch(batch)).toThrow(
        /invalid persisted session row/u,
      );
      db.exec("DELETE FROM session_canonical_validation_pending");
      db.prepare(
        "UPDATE session_nodes SET entry_json = ?, entry_valid = 1 WHERE session_key = ?",
      ).run(JSON.stringify({ sessionId: "target", updatedAt: 2, delivery: { kind: "none" } }), key);
      expect(
        db.prepare("SELECT entry_valid FROM session_nodes WHERE session_key = ?").get(key)
          ?.entry_valid,
      ).toBe(1);
      expect(pendingKeys(db)).toEqual([]);
    });
  },
);
