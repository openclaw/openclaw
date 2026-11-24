import { describe, expect, it, vi } from "vitest";
import {
  observeHostDataSql,
  observeSqliteReadSql,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "../infra/node-sqlite.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { assertCanonicalSessionValidationSchema } from "./openclaw-agent-canonical-validation-schema.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { ensureOpenClawAgentSchema } from "./openclaw-agent-db-schema.js";
import type { DB } from "./openclaw-agent-db.generated.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { hashSqliteSchema } from "./sqlite-schema-shape.test-support.js";

describe("fresh agent schema admission", () => {
  it("also creates the canonical schema on an independently managed connection", () => {
    const { DatabaseSync } = requireNodeSqlite();
    using database = new DatabaseSync(":memory:");
    using canonical = openNodeSqliteDatabase(":memory:");
    canonical.exec(OPENCLAW_AGENT_SCHEMA_SQL);
    ensureOpenClawAgentSchema(database, "fresh", ":memory:");
    expect(hashSqliteSchema(database)).toBe(hashSqliteSchema(canonical));
    expect(() => assertCanonicalSessionValidationSchema(database)).not.toThrow();
  });

  it("installs the complete canonical schema once and invalidates its proof after DDL", () => {
    using database = openNodeSqliteDatabase(":memory:");
    using canonical = openNodeSqliteDatabase(":memory:");
    canonical.exec(OPENCLAW_AGENT_SCHEMA_SQL);
    const exec = vi.spyOn(database, "exec");
    try {
      const admissionReads = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
      try {
        ensureOpenClawAgentSchema(database, "fresh", ":memory:");
        // One initial version read and one capture of the installed schema suffice.
        expect(
          admissionReads.queries.filter((sql) => /^PRAGMA user_version$/iu.test(sql)).length,
        ).toBeLessThanOrEqual(2);
      } finally {
        admissionReads.restore();
      }
      expect(exec.mock.calls.filter(([sql]) => sql === OPENCLAW_AGENT_SCHEMA_SQL)).toHaveLength(1);
      expect(hashSqliteSchema(database)).toBe(hashSqliteSchema(canonical));
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(
        OPENCLAW_AGENT_SCHEMA_VERSION,
      );
      expect(
        database.prepare("SELECT role, agent_id, schema_version FROM schema_meta").get(),
      ).toEqual({
        role: "agent",
        agent_id: "fresh",
        schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });

      const observed = observeHostDataSql();
      try {
        assertCanonicalSessionValidationSchema(database);
        expect(observed.queries).toEqual([]);
      } finally {
        observed.restore();
      }

      database.exec(
        "CREATE TRIGGER unexpected_validation AFTER UPDATE ON session_nodes BEGIN SELECT 1; END",
      );
      expect(() => assertCanonicalSessionValidationSchema(database)).toThrow(/missing or drifted/u);
    } finally {
      exec.mockRestore();
    }
  });

  it("does not retain creation facts after the containing transaction rolls back", () => {
    using database = openNodeSqliteDatabase(":memory:");
    admitSqliteSchema(database);
    expect(() =>
      runSqliteImmediateTransactionSync(database, () => {
        ensureOpenClawAgentSchema(database, "fresh", ":memory:");
        throw new Error("cancel creation");
      }),
    ).toThrow("cancel creation");
    expect(database.prepare("SELECT name FROM sqlite_schema").all()).toEqual([]);
    expect(getAdmittedSqliteSchemaFacts(database)?.userVersion).toBe(0);
    expect(getAdmittedSqliteSchemaFacts(database)?.tables.size).toBe(0);
    expect(() => assertCanonicalSessionValidationSchema(database)).toThrow(
      /Session metadata unavailable \(table-missing:/u,
    );

    ensureOpenClawAgentSchema(database, "fresh", ":memory:");
    expect(getAdmittedSqliteSchemaFacts(database)?.userVersion).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(() => assertCanonicalSessionValidationSchema(database)).not.toThrow();
  });
});

it("creates a nullable marker on fresh nodes without changing their entry JSON", () => {
  using db = openNodeSqliteDatabase(":memory:");
  ensureOpenClawAgentSchema(db, "main", ":memory:");
  db.exec(`INSERT INTO session_nodes (session_key, current_session_id, updated_at, entry_json, archived_at)
    VALUES ('archived', 'two', 2, '{ "sessionId": "two", "archivedAt": 2 }', 2)`);
  expect(
    db
      .prepare(
        "SELECT type, [notnull], dflt_value FROM pragma_table_info('session_nodes') WHERE name='archive_undo_marker'",
      )
      .get(),
  ).toEqual({ type: "TEXT", notnull: 0, dflt_value: null });
  const sql = getNodeSqliteKysely<DB>(db);
  const node = sql
    .selectFrom("session_nodes")
    .select(["entry_json", "archive_undo_marker"])
    .where("session_key", "=", "archived");
  const read = () => executeSqliteQuerySync(db, node).rows;
  const entry = '{ "sessionId": "two", "archivedAt": 2 }';
  expect(read()).toEqual([{ entry_json: entry, archive_undo_marker: null }]);
  executeSqliteQuerySync(
    db,
    sql
      .updateTable("session_nodes")
      .set({ archive_undo_marker: "occurrence" })
      .where("session_key", "=", "archived"),
  );
  expect(read()).toEqual([{ entry_json: entry, archive_undo_marker: "occurrence" }]);
});
