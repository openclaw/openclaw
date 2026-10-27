import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { corruptSqliteIndexKey } from "../infra/sqlite-index-corruption.test-support.js";
import { recordSessionStateEventsInDatabase } from "../sessions/session-state-events.kernel.js";
import { readSessionStateSequence } from "../sessions/session-state-events.read.worker.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { withStateMigrationBackupForTest } from "./openclaw-state-schema.test-support.js";
import { assertSqliteMigrationScopePreserved } from "./sqlite-migration-scope.test-support.js";
import { migrateSqliteTableWithoutRowid } from "./sqlite-table-layout-migration.js";

// v25 changes only metadata; its physical schema is identical to v24.
const legacySchema = readFileSync(
  new URL("../../test/fixtures/sqlite/openclaw-state-schema-v24.sql", import.meta.url),
  "utf8",
);
const directories = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  });
});

function withMigrationCustody(
  options: Parameters<typeof withStateMigrationBackupForTest>[0],
  run: () => void | Promise<void>,
) {
  return withStateMigrationBackupForTest(options, async () => {
    try {
      await run();
    } finally {
      await closeOpenClawStateDatabaseAsync();
    }
  });
}

function record(db: EngineConnection, agentId: string, dedupeKey: string, now: number) {
  return recordSessionStateEventsInDatabase(db, [
    {
      event: {
        sessionKey: "global",
        agentId,
        kind: "human_direct_message",
        actorType: "human",
        summary: "synthetic event",
        dedupeKey,
      },
      now,
    },
  ]).rows[0];
}

function heads(db: EngineConnection) {
  return db.prepare("SELECT * FROM session_state_heads ORDER BY session_key, agent_id").all();
}

function head(
  agent_id: string,
  last_sequence: number,
  pruned_max_sequence: number,
  updated_at: number,
) {
  return { session_key: "global", agent_id, last_sequence, pruned_max_sequence, updated_at };
}

function legacyDatabase(refusePublication = false) {
  const env = { OPENCLAW_STATE_DIR: directories.make("head-layout-v25-") };
  const pathname = resolveOpenClawStateSqlitePath(env);
  mkdirSync(path.dirname(pathname), { recursive: true });
  using db = new DatabaseSync(pathname);
  db.exec(legacySchema);
  db.exec(`PRAGMA user_version = 25;
    INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
      VALUES ('primary', 'global', 25, 1, 1);
    CREATE INDEX local_head_updated ON session_state_heads(updated_at);`);
  record(db, "main", "main-before", 100);
  record(db, "other", "other-before", 110);
  db.exec(
    "UPDATE session_state_heads SET pruned_max_sequence = 1 WHERE agent_id = 'main'; ANALYZE;",
  );
  if (refusePublication) {
    db.exec(`CREATE TRIGGER refuse_schema_publication BEFORE UPDATE ON schema_meta
      BEGIN SELECT RAISE(ABORT, 'fixture publication refusal'); END;`);
  }
  return { options: { env, path: pathname }, pathname, before: heads(db) };
}

it.each([
  { schema: "pending", integrityCheck: undefined },
  { schema: "pending", integrityCheck: "full" },
  { schema: "current", integrityCheck: undefined },
] as const)(
  "reserves untouched index recovery for $integrityCheck verification with $schema schema",
  async ({ schema, integrityCheck }) => {
    const { options, pathname } = legacyDatabase();
    await withMigrationCustody(options, () => {
      if (schema === "current") {
        expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
      }
      const source = new DatabaseSync(pathname);
      source.exec(`
        CREATE TABLE untouched_payloads (value TEXT);
        CREATE INDEX idx_untouched_payload ON untouched_payloads(value);
        INSERT INTO untouched_payloads VALUES ('retained');
      `);
      source.close();
      corruptSqliteIndexKey(pathname, "idx_untouched_payload", "retained", "mismatch");
      const result = repairOpenClawStateDatabaseSchema({ ...options, integrityCheck });
      expect(result.warnings).toEqual([]);
      expect(result.changes.some((change) => change.includes("idx_untouched_payload"))).toBe(
        integrityCheck === "full",
      );
      using database = new DatabaseSync(pathname);
      expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check === "ok").toBe(
        integrityCheck === "full",
      );
      expect(database.prepare("SELECT value FROM untouched_payloads NOT INDEXED").all()).toEqual([
        { value: "retained" },
      ]);
    });
  },
);

it.each(["runtime", "doctor"] as const)(
  "migrates v25 heads through %s within scope and preserves subsequent event writes",
  async (owner) => {
    const { options, pathname, before } = legacyDatabase();
    await withMigrationCustody(options, async () => {
      using scope = new DatabaseSync(pathname);
      const { db } = await assertSqliteMigrationScopePreserved(
        scope,
        [
          "schema_meta",
          "config_machine_state",
          "github_publication_requests",
          "github_personal_publication_requests",
          "github_repository_publication_requests",
          "session_state_heads",
          "acp_replay_events",
          "skill_usage",
          "state_leases",
          "device_identities",
          "device_auth_tokens",
          "gateway_origin_device_tokens",
          "exec_approvals_config",
          "local_workspace_projections",
          "local_workspace_manifest_nodes",
          "sqlite_stat1",
          "sqlite_stat4",
        ],
        () => {
          if (owner === "doctor") {
            expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
          }
          return openOpenClawStateDatabase(options);
        },
      );
      expect(db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(
        db.prepare("SELECT wr FROM pragma_table_list WHERE name = 'session_state_heads'").get(),
      ).toEqual({ wr: 1 });
      expect(heads(db)).toEqual(before);
      expect(
        db.prepare("SELECT name FROM sqlite_schema WHERE name = 'local_head_updated'").get(),
      ).toEqual({ name: "local_head_updated" });

      const inserted = runOpenClawStateWriteTransaction(
        ({ db: writer }) => record(writer, "main", "main-after", 200),
        options,
      );
      expect(readSessionStateSequence(db, "global", "main")).toBe(inserted?.sequence);
      expect(readSessionStateSequence(db, "global", "other")).toBe(2);
      expect(
        db
          .prepare("SELECT pruned_max_sequence FROM session_state_heads WHERE agent_id = 'main'")
          .get(),
      ).toEqual({ pruned_max_sequence: 1 });
      const after = heads(db);
      runOpenClawStateWriteTransaction(
        ({ db: writer }) => record(writer, "main", "main-after", 300),
        options,
      );
      expect(heads(db)).toEqual(after);
      await closeOpenClawStateDatabaseAsync();
      expect(heads(openOpenClawStateDatabase(options).db)).toEqual(after);
    });
  },
);

it("rolls back the rebuilt head table and version when publication fails", async () => {
  const { options, pathname, before } = legacyDatabase(true);
  await withMigrationCustody(options, () => {
    expect(() => openOpenClawStateDatabase(options)).toThrow("fixture publication refusal");
  });
  using db = new DatabaseSync(pathname, { readOnly: true });
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 25 });
  expect(
    db.prepare("SELECT wr FROM pragma_table_list WHERE name = 'session_state_heads'").get(),
  ).toEqual({ wr: 0 });
  expect(heads(db)).toEqual(before);
  expect(
    db.prepare("SELECT name FROM sqlite_schema WHERE name = 'local_head_updated'").get(),
  ).toEqual({ name: "local_head_updated" });
});

it("preserves local constraints, generated values, indexes, and triggers during layout conversion", () => {
  using db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE session_state_heads (
    session_key TEXT NOT NULL, agent_id TEXT NOT NULL,
    last_sequence INTEGER NOT NULL CHECK (last_sequence > 0),
    pruned_max_sequence INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
    label TEXT, doubled INTEGER GENERATED ALWAYS AS (last_sequence * 2) STORED,
    PRIMARY KEY(session_key, agent_id)
  ) STRICT;
  CREATE INDEX local_head_updated ON session_state_heads(updated_at);
  CREATE TABLE head_changes (sequence INTEGER);
  CREATE TRIGGER local_head_change AFTER UPDATE ON session_state_heads
    BEGIN INSERT INTO head_changes VALUES (new.last_sequence); END;
  INSERT INTO session_state_heads (session_key, agent_id, last_sequence, updated_at, label)
    VALUES ('global', 'main', 3, 100, 'kept');
  BEGIN IMMEDIATE;`);
  migrateSqliteTableWithoutRowid(db, "session_state_heads");
  db.exec("COMMIT");
  expect(heads(db)).toEqual([{ ...head("main", 3, 0, 100), label: "kept", doubled: 6 }]);
  db.exec("UPDATE session_state_heads SET last_sequence = 4");
  expect(db.prepare("SELECT * FROM head_changes").all()).toEqual([{ sequence: 4 }]);
  expect(() => db.exec("UPDATE session_state_heads SET last_sequence = 0")).toThrow(/CHECK/);
});

it("batches creation heads without rewinding replayed or shared-key agent heads", () => {
  const env = { OPENCLAW_STATE_DIR: directories.make("head-batch-") };
  const options = { env, path: resolveOpenClawStateSqlitePath(env) };
  const database = openOpenClawStateDatabase(options);
  const created = (agentId: string, dedupeKey: string) => ({
    sessionKey: "global",
    agentId,
    dedupeKey,
    kind: "created" as const,
    actorType: "system" as const,
    summary: "created",
  });
  const events = [
    created("main", "one"),
    created("other", "two"),
    created("main", "three"),
    created("main", "one"),
  ];
  const writeBatch = (batch: typeof events, now: number) =>
    runOpenClawStateWriteTransaction(
      ({ db }) =>
        recordSessionStateEventsInDatabase(
          db,
          batch.map((event) => ({ event, now })),
        ),
      options,
    );
  if (!(database.db instanceof DatabaseSync)) {
    throw new Error("SQLite fixture required");
  }
  const counter = trackSqliteStatementExecutions(database.db, ["heads"], (sql) =>
    /^insert into "session_state_heads"/i.test(sql) ? "heads" : null,
  );
  try {
    const first = writeBatch(events, 100);
    expect(first.rows.map((row) => row.sequence)).toEqual([1, 2, 3, 1]);
    expect(counter.counts.heads).toBe(1);
    database.db.exec(
      "UPDATE session_state_heads SET pruned_max_sequence = 1 WHERE agent_id = 'main'",
    );
    writeBatch([created("main", "four"), events[0]!], 200);
    const stored = heads(database.db);
    expect(stored).toEqual([head("main", 5, 1, 200), head("other", 2, 0, 100)]);
    expect(() =>
      runOpenClawStateWriteTransaction(() => {
        writeBatch([created("main", "rolled-back")], 300);
        throw new Error("rollback batch");
      }, options),
    ).toThrow("rollback batch");
    expect(heads(database.db)).toEqual(stored);
  } finally {
    counter.restore();
  }
});
