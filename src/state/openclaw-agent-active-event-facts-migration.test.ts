import { constants, DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { AGENT_ACTIVE_EVENT_FACTS_SQL } from "./openclaw-agent-active-event-facts-schema.js";
import { migrateAgentColdNavigationInTransaction } from "./openclaw-agent-cold-navigation-schema.js";
import { AGENT_CREATION_OPERATIONS_SQL } from "./openclaw-agent-creation-operations-schema.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import {
  ensureOpenClawAgentDatabaseSchema,
  ensureOpenClawAgentSchema,
} from "./openclaw-agent-db-schema.js";
import { assertOpenClawMigrationWitnessPreserved } from "./openclaw-migration-witness.js";
import { resolveSchemaMigrationIntegrityCheck } from "./schema-migration-backup-scope.js";
import {
  agentWitness,
  expectVersion,
  migrationFixture,
  row,
  rows,
  seedAgentV38Schema,
} from "./schema-migration.test-support.js";

const table = "session_transcript_active_event_facts";
const scope = ["schema_meta", table];
function seed(db: DatabaseSync) {
  seedAgentV38Schema(db);
  runSqliteImmediateTransactionSync(db, () => migrateAgentColdNavigationInTransaction(db));
  db.exec(AGENT_CREATION_OPERATIONS_SQL);
  db.exec(`PRAGMA user_version=40; UPDATE schema_meta SET schema_version=40;
    PRAGMA foreign_keys=ON;
    INSERT INTO session_nodes (session_key,current_session_id,entry_json,updated_at)
      VALUES ('agent:main:retained','retained','{"sessionId":"retained","updatedAt":1}',1);
    INSERT INTO session_windows (session_id,session_key,created_at,updated_at)
      VALUES ('retained','agent:main:retained',1,1);
    INSERT INTO transcript_events (session_id,seq,event_json,created_at)
      VALUES ('retained',1,'{"type":"message","message":{"role":"user","content":"retained"}}',1);
    INSERT INTO session_transcript_active_events (session_id,active_position,event_seq,context_eligible)
      VALUES ('retained',0,1,1);
    INSERT INTO cache_entries (scope,key,blob,updated_at) VALUES ('unrelated','bytes',X'00FF01',1);
    ANALYZE;`);
}
const fixture = migrationFixture({ seed, predecessor: 40, target: 41, scope });

it.each(["commit", "rollback"])(
  "adds empty active facts atomically without changing existing data (%s)",
  async (outcome) => {
    await fixture("active-facts.sqlite", async ({ database, migrate }) => {
      const before = agentWitness(database);
      await migrate(outcome);
      expectVersion(database, outcome === "commit" ? 41 : 40);
      expect(assertOpenClawMigrationWitnessPreserved(before, agentWitness(database))).toEqual({
        warnings: [],
      });
      if (outcome === "rollback") {
        expect(row(database, "SELECT name FROM sqlite_schema WHERE name=?", table)).toBeUndefined();
        return;
      }
      expect(row(database, "SELECT strict,wr FROM pragma_table_list WHERE name=?", table)).toEqual({
        strict: 1,
        wr: 1,
      });
      expect(rows(database, `SELECT * FROM ${table}`)).toEqual([]);
      expect(() => ensureOpenClawAgentSchema(database, "main", database.location()!, 40)).toThrow(
        /expected at most 40/u,
      );
      database.exec(`INSERT INTO ${table} VALUES ('retained',1,79,'{}')`);
      expect(() => assertOpenClawMigrationWitnessPreserved(before, agentWitness(database))).toThrow(
        /content/u,
      );
      database.exec("DELETE FROM session_transcript_active_events WHERE session_id='retained'");
      expect(rows(database, `SELECT * FROM ${table}`)).toEqual([]);
      expect(rows(database, "PRAGMA foreign_key_check")).toEqual([]);
      expect(() => database.exec(`INSERT INTO ${table} VALUES ('retained',1,79,'{}')`)).toThrow(
        /FOREIGN KEY/u,
      );
    });
  },
);

it("restores the verified scoped predecessor without reverting unrelated later writes", async () => {
  await fixture(
    "active-facts-restore.sqlite",
    async ({ database, restore }) => {
      await restore(() => ({
        definition: row(database, "SELECT sql FROM sqlite_schema WHERE name=?", table),
        userVersion: row(database, "PRAGMA user_version"),
        schemaVersion: row(database, "SELECT schema_version FROM schema_meta"),
        active: rows(database, "SELECT * FROM session_transcript_active_events"),
        events: rows(database, "SELECT * FROM transcript_events"),
      }));
    },
    "state",
  );
});

it("admits the empty-table upgrade without scanning existing payload or active rows", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const pathname = state.statePath("active-facts-no-scan.sqlite");
    using database = new DatabaseSync(pathname);
    seed(database);
    database.setAuthorizer((action, name, argument) => {
      if (
        action === constants.SQLITE_READ &&
        ["transcript_events", "session_transcript_active_events"].includes(name ?? "")
      ) {
        return constants.SQLITE_DENY;
      }
      if (
        action === constants.SQLITE_PRAGMA &&
        ["quick_check", "integrity_check", "foreign_key_check"].includes(name ?? "") &&
        argument !== "schema_meta" &&
        argument !== table &&
        argument !== "agent_tool_usage"
      ) {
        return constants.SQLITE_DENY;
      }
      return constants.SQLITE_OK;
    });
    try {
      await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
        ensureOpenClawAgentDatabaseSchema(database, {
          agentId: "main",
          path: pathname,
          env: state.env,
        });
      });
    } finally {
      database.setAuthorizer(null);
    }
    expectVersion(database, 42);
    expect(
      resolveSchemaMigrationIntegrityCheck(
        { kind: "agent", foundVersion: 40, supportedVersion: 41 },
        "full",
      ),
    ).toEqual({ check: "full" });
  });
});

it("refuses a foreign-key violation in the new companion at migration finalization", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const pathname = state.statePath("active-facts-invalid.sqlite");
    using database = new DatabaseSync(pathname);
    seed(database);
    database.exec(`PRAGMA foreign_keys=OFF; ${AGENT_ACTIVE_EVENT_FACTS_SQL}
      INSERT INTO ${table} VALUES ('missing',1,1,'{}');`);
    await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
      expect(() =>
        ensureOpenClawAgentDatabaseSchema(database, {
          agentId: "main",
          path: pathname,
          env: state.env,
        }),
      ).toThrow(/foreign key validation/u);
    });
    expectVersion(database, 40);
  });
});

it.each(["earlier-crossing", "full"] as const)(
  "retains global foreign-key validation for %s",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pathname = state.statePath(`active-facts-${mode}.sqlite`);
      using database = new DatabaseSync(pathname);
      seed(database);
      database.exec("PRAGMA foreign_keys=OFF; DELETE FROM transcript_events");
      if (mode === "earlier-crossing") {
        database.exec(
          "DROP TABLE session_creation_operations; PRAGMA user_version=39; UPDATE schema_meta SET schema_version=39",
        );
      }
      await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
        expect(() =>
          mode === "full"
            ? ensureOpenClawAgentDatabaseSchema(database, {
                agentId: "main",
                path: pathname,
                env: state.env,
                integrityCheck: "full",
              })
            : ensureOpenClawAgentSchema(database, "main", pathname, 41),
        ).toThrow(/foreign.?key/iu);
      });
      expectVersion(database, mode === "full" ? 40 : 39);
    });
  },
);
