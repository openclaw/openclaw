import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "../infra/node-sqlite.js";
import { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
import * as schemaContract from "../infra/sqlite-schema-contract.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { ensureOpenClawAgentStandingIntentsSchema as ensure } from "./openclaw-agent-standing-intents-schema.js";

const schemaSql = extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, "standing_intents", {
  endMarker: "CREATE TABLE IF NOT EXISTS session_transcript_index_state (",
  includeEndMarker: false,
});
const databases: DatabaseSync[] = [];

function open(admitted = true) {
  const db = openNodeSqliteDatabase(":memory:");
  databases.push(db);
  if (admitted) {
    admitSqliteSchema(db);
  }
  return db;
}

function managed<T>(db: DatabaseSync, run: () => T) {
  return withSqlitePostCommitPublications(db, () => runSqliteImmediateTransactionSync(db, run));
}

function expectHotEnsure(db: DatabaseSync) {
  const exec = vi.spyOn(db, "exec");
  const reads = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
  try {
    managed(db, () => ensure(db));
    managed(db, () => ensure(db));
    expect(exec.mock.calls.filter(([sql]) => /CREATE|ALTER|DROP/iu.test(sql))).toEqual([]);
    expect(
      reads.queries.filter((sql) => /sqlite_schema|table_info|index_list|index_xinfo/iu.test(sql)),
    ).toEqual([]);
  } finally {
    reads.restore();
    exec.mockRestore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) {
    if (db.isOpen) {
      db.close();
    }
  }
});

describe("standing-intent schema admission", () => {
  it.each(["standalone", "managed"] as const)(
    "retains post-COMMIT facts after a %s first ensure",
    (owner) => {
      const db = open();
      if (owner === "managed") {
        managed(db, () => ensure(db));
      } else {
        ensure(db);
      }
      expectHotEnsure(db);
      expect(schemaContract.collectSqliteSchemaIssues(db, schemaSql)).toEqual([]);
    },
  );

  it("repairs legacy creator provenance and missing index/trigger before admitting the group", () => {
    const db = open();
    db.exec(
      schemaSql.replace(
        "  creator_sender TEXT CHECK (creator_sender IS NULL OR length(trim(creator_sender)) > 0),\n",
        "",
      ),
    );
    db.exec(
      "DROP INDEX idx_standing_intents_scope; DROP TRIGGER standing_intents_fts_after_update;",
    );
    managed(db, () => ensure(db));
    expect(
      db
        .prepare("PRAGMA table_info(standing_intents)")
        .all()
        .map((row) => row.name),
    ).toContain("creator_sender");
    expect(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE name IN (?, ?) ORDER BY name")
        .all("idx_standing_intents_scope", "standing_intents_fts_after_update"),
    ).toEqual([
      { name: "idx_standing_intents_scope" },
      { name: "standing_intents_fts_after_update" },
    ]);
    expectHotEnsure(db);
  });

  it.each(["outer", "savepoint"] as const)(
    "retries schema rolled back by its %s owner",
    (owner) => {
      const db = open();
      const failure = new Error("rollback the schema owner");
      const rolledBack = () =>
        expect(() =>
          managed(db, () => {
            ensure(db);
            throw failure;
          }),
        ).toThrow(failure);
      if (owner === "outer") {
        rolledBack();
      } else {
        managed(db, rolledBack);
      }
      expect(
        db.prepare("SELECT name FROM sqlite_schema WHERE name = 'standing_intents'").get(),
      ).toBeUndefined();
      managed(db, () => ensure(db));
      expect(schemaContract.collectSqliteSchemaIssues(db, schemaSql)).toEqual([]);
      expectHotEnsure(db);
    },
  );

  it.each([
    ["creator column", "ALTER TABLE standing_intents DROP COLUMN creator_sender"],
    ["index", "DROP INDEX idx_standing_intents_scope"],
    ["trigger", "DROP TRIGGER standing_intents_fts_after_update"],
  ])("does not cache post-ensure removal of the %s", (_name, mutation) => {
    const db = open();
    managed(db, () => {
      ensure(db);
      db.exec(mutation);
    });
    expect(schemaContract.collectSqliteSchemaIssues(db, schemaSql).length).toBeGreaterThan(0);
    managed(db, () => ensure(db));
    expect(schemaContract.collectSqliteSchemaIssues(db, schemaSql)).toEqual([]);
    expectHotEnsure(db);
  });

  it("revokes a warmed admission after later DDL", () => {
    const db = open();
    managed(db, () => ensure(db));
    db.exec("DROP INDEX idx_standing_intents_scope");
    managed(db, () => ensure(db));
    expect(schemaContract.collectSqliteSchemaIssues(db, schemaSql)).toEqual([]);
    expectHotEnsure(db);
  });

  it("does not publish facts changed after the post-commit schema inspection", () => {
    const db = open();
    const collect = schemaContract.collectSqliteSchemaIssues;
    const inspection = vi
      .spyOn(schemaContract, "collectSqliteSchemaIssues")
      .mockImplementationOnce((...args) => {
        const issues = collect(...args);
        db.exec("DROP INDEX idx_standing_intents_scope");
        return issues;
      });
    try {
      managed(db, () => ensure(db));
      expect(inspection).toHaveBeenCalledOnce();
    } finally {
      inspection.mockRestore();
    }
    expect(schemaContract.collectSqliteSchemaIssues(db, schemaSql).length).toBeGreaterThan(0);
    managed(db, () => ensure(db));
    expect(schemaContract.collectSqliteSchemaIssues(db, schemaSql)).toEqual([]);
    expectHotEnsure(db);
  });

  it("preserves a native first-use DDL failure and retries after the conflict is removed", () => {
    const db = open();
    db.exec("CREATE TABLE idx_standing_intents_scope (id INTEGER)");
    expect(() => managed(db, () => ensure(db))).toThrow(/idx_standing_intents_scope/u);
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE name = 'standing_intents'").get(),
    ).toBeUndefined();
    db.exec("DROP TABLE idx_standing_intents_scope");
    managed(db, () => ensure(db));
    expect(schemaContract.collectSqliteSchemaIssues(db, schemaSql)).toEqual([]);
    expectHotEnsure(db);
  });

  it("leaves cache admission unrecorded when the optional post-commit inspection throws", () => {
    const db = open();
    const inspection = vi
      .spyOn(schemaContract, "collectSqliteSchemaIssues")
      .mockImplementationOnce(() => {
        throw new Error("synthetic native inspection failure");
      });
    try {
      expect(() => managed(db, () => ensure(db))).not.toThrow();
      expect(inspection).toHaveBeenCalledOnce();
    } finally {
      inspection.mockRestore();
    }
    expect(schemaContract.collectSqliteSchemaIssues(db, schemaSql)).toEqual([]);
    const exec = vi.spyOn(db, "exec");
    try {
      managed(db, () => ensure(db));
      expect(
        exec.mock.calls.some(([sql]) =>
          sql.includes("CREATE TABLE IF NOT EXISTS standing_intents"),
        ),
      ).toBe(true);
    } finally {
      exec.mockRestore();
    }
    expectHotEnsure(db);
  });

  it("does not persist cache state from an unmanaged transaction or unadmitted connection", () => {
    const db = open();
    db.exec("BEGIN");
    ensure(db);
    db.exec("ROLLBACK");
    ensure(db);
    expectHotEnsure(db);
    const unadmitted = open(false);
    ensure(unadmitted);
    const exec = vi.spyOn(unadmitted, "exec");
    try {
      ensure(unadmitted);
      expect(
        exec.mock.calls.some(([sql]) =>
          sql.includes("CREATE TABLE IF NOT EXISTS standing_intents"),
        ),
      ).toBe(true);
    } finally {
      exec.mockRestore();
    }
  });
});
