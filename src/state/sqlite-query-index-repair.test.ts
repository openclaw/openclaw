import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.test-support.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { openOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly.js";
import { AGENT_SCHEMA_COMPATIBILITY } from "./openclaw-agent-db-schema-compatibility.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "./openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openExistingOpenClawStateDatabaseReadOnly,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import {
  getOpenClawStateRuntimeSchema,
  OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY,
} from "./openclaw-state-schema-compatibility.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function closeDatabases() {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
}
afterEach(closeDatabases);

const cases = [
  {
    role: "state",
    version: OPENCLAW_STATE_SCHEMA_VERSION,
    schema: () => getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables: false }),
    compatibility: OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY,
    indexes: [
      {
        name: "idx_worker_session_placements_environment",
        table: "worker_session_placements",
        primaryKey: "session_id",
        query:
          "SELECT session_id AS id FROM worker_session_placements WHERE environment_id = 'environment' ORDER BY session_id",
      },
    ],
    seed(db: EngineConnection) {
      db.exec(`INSERT INTO worker_session_placements
          (session_id, agent_id, session_key, state, environment_id, created_at_ms, updated_at_ms, state_changed_at_ms) VALUES
          ('a', 'main', 'agent:main:a', 'provisioning', 'environment', 1, 1, 1),
          ('b', 'main', 'agent:main:b', 'provisioning', 'environment', 2, 2, 2),
          ('c', 'main', 'agent:main:c', 'local', NULL, 3, 3, 3);`);
    },
  },
  {
    role: "agent",
    version: OPENCLAW_AGENT_SCHEMA_VERSION,
    schema: () => OPENCLAW_AGENT_SCHEMA_SQL,
    compatibility: AGENT_SCHEMA_COMPATIBILITY,
    indexes: [
      {
        name: "idx_agent_session_nodes_entry_not_valid",
        table: "session_nodes",
        primaryKey: "session_key",
        query:
          "SELECT current_session_id AS id FROM session_nodes WHERE entry_valid != 1 ORDER BY session_key",
      },
      {
        name: "idx_agent_voice_session_open_scope",
        table: "cache_entries",
        primaryKey: "key",
        query: `SELECT key AS id FROM cache_entries WHERE scope = 'talk-client-voice-sessions'
          AND CASE WHEN json_valid(value_json) THEN json_extract(value_json, '$.status') END = 'open'
          AND CASE WHEN json_valid(value_json) THEN json_extract(value_json, '$.agentId') END = 'main'
          AND CASE WHEN json_valid(value_json) THEN json_extract(value_json, '$.sessionKey') END = 'agent:main:main'
          AND CASE WHEN json_valid(value_json) THEN json_extract(value_json, '$.origin') END = 'client'`,
      },
      {
        name: "idx_agent_voice_session_open_updated",
        table: "cache_entries",
        primaryKey: "key",
        query: `SELECT key AS id FROM cache_entries WHERE scope = 'talk-client-voice-sessions'
          AND CASE WHEN json_valid(value_json) THEN json_extract(value_json, '$.status') END = 'open'
          AND updated_at <= 2`,
      },
    ],
    seed(db: EngineConnection) {
      const insert = db.prepare(`INSERT INTO session_nodes
        (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, 1)`);
      const cache = db.prepare(
        "INSERT INTO cache_entries(scope, key, value_json, updated_at) VALUES ('talk-client-voice-sessions', ?, ?, 1)",
      );
      const voiceScope = { agentId: "main", sessionKey: "agent:main:main", origin: "client" };
      for (const key of ["a", "b", "c"]) {
        insert.run(
          `agent:main:${key}`,
          key,
          key === "c" ? JSON.stringify({ sessionId: key, updatedAt: 1 }) : `{invalid-${key}`,
        );
        cache.run(key, JSON.stringify({ ...voiceScope, status: key === "c" ? "closed" : "open" }));
      }
      cache.run("malformed", "{broken");
      db.exec(`
        UPDATE session_nodes SET entry_valid = -1 WHERE session_key != 'agent:main:c';
        UPDATE session_nodes SET entry_valid = 1 WHERE session_key = 'agent:main:c';
      `);
    },
  },
] as const;

type IndexCase = (typeof cases)[number];

function createFixture(testCase: IndexCase) {
  const options = {
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: tempDirs.make("sqlite-query-index-repair-") },
  };
  const open = () =>
    testCase.role === "state"
      ? openOpenClawStateDatabase(options)
      : openOpenClawAgentDatabase(options);
  const database = open();
  testCase.seed(database.db);
  return { options, open, database };
}

function readRows(db: EngineConnection, testCase: IndexCase) {
  return [...new Set(testCase.indexes.map((index) => index.table))].map((table) =>
    db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
  );
}

function readSchema(db: EngineConnection) {
  return {
    cookie: db.prepare("PRAGMA schema_version").get(),
    version: db.prepare("PRAGMA user_version").get(),
    metadata: db.prepare("SELECT * FROM schema_meta ORDER BY meta_key").all(),
    objects: db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all(),
  };
}

function snapshot(db: EngineConnection, testCase: IndexCase) {
  return { rows: readRows(db, testCase), schema: readSchema(db) };
}

it.each(["fresh", "missing", "drifted"] as const)(
  "opens %s query indexes without migrating or changing stored rows",
  (kind) => {
    for (const testCase of cases) {
      const fixture = createFixture(testCase);
      let database = fixture.database;
      const before = snapshot(database.db, testCase);
      if (kind !== "fresh") {
        closeDatabases();
        {
          using previous = new DatabaseSync(database.path);
          for (const index of testCase.indexes) {
            previous.exec(`DROP INDEX IF EXISTS ${index.name}`);
            if (kind === "drifted") {
              previous.exec(
                `CREATE INDEX ${index.name} ON ${index.table}(${index.primaryKey}, ${index.primaryKey})`,
              );
            }
          }
        }
        database = fixture.open();
      }

      expect(readRows(database.db, testCase)).toEqual(before.rows);
      const { metadata, version } = readSchema(database.db);
      expect({ metadata, version }).toEqual({
        metadata: before.schema.metadata,
        version: { user_version: testCase.version },
      });
      for (const index of testCase.indexes) {
        expect(database.db.prepare(index.query).all()).toEqual([{ id: "a" }, { id: "b" }]);
        const plan = database.db.prepare(`EXPLAIN QUERY PLAN ${index.query}`).all();
        expect(plan).toContainEqual(
          expect.objectContaining({ detail: expect.stringContaining(index.name) }),
        );
        expect(
          database.db
            .prepare('SELECT "unique" FROM pragma_index_list(?) WHERE name = ?')
            .get(index.table, index.name),
        ).toEqual({ unique: 0 });
      }

      const repaired = snapshot(database.db, testCase);
      closeDatabases();
      database = fixture.open();
      expect(snapshot(database.db, testCase)).toEqual(repaired);
      closeDatabases();
    }
  },
);

it.each(cases)(
  "admits $role readers on either side of the additive index upgrade",
  async (testCase) => {
    const { database, options } = createFixture(testCase);
    // The preceding same-version reader knows every current contract except these additions.
    const names = testCase.indexes.map((index) => index.name).join("|");
    const previousSchema = testCase
      .schema()
      .replace(new RegExp(`CREATE INDEX IF NOT EXISTS (?:${names})\\b[^;]*;`, "gu"), "");
    expect(() =>
      assertSqliteSchemaContains(
        requireNativeSqliteDatabase(database.db),
        database.path,
        previousSchema,
        testCase.compatibility,
      ),
    ).not.toThrow();
    const rows = readRows(database.db, testCase);
    closeDatabases();
    let before;
    {
      using previous = new DatabaseSync(database.path);
      for (const index of testCase.indexes) {
        previous.exec(`DROP INDEX IF EXISTS ${index.name}`);
      }
      before = readSchema(previous);
    }
    const expected = { rows, schema: before };

    if (testCase.role === "state") {
      const reader = await openExistingOpenClawStateDatabaseReadOnly(options);
      assert(reader);
      try {
        expect(snapshot(reader.db, testCase)).toEqual(expected);
      } finally {
        reader.walMaintenance.close();
      }
    } else {
      const result = openOpenClawAgentDatabaseReadOnly(options);
      assert(result.found);
      try {
        expect(snapshot(result.database.db, testCase)).toEqual(expected);
      } finally {
        result.database.close();
      }
    }
    using after = new DatabaseSync(database.path, { readOnly: true });
    expect(snapshot(after, testCase)).toEqual(expected);
  },
);
