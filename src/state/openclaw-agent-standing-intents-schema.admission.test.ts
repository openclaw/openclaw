import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "../infra/node-sqlite.js";
import { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
import { collectSqliteSchemaIssues } from "../infra/sqlite-schema-contract.js";
import {
  admitSqliteSchema,
  adoptSqliteSchemaFacts,
  getAdmittedSqliteSchemaFacts,
  registerSqliteSchemaMutationListener,
} from "../infra/sqlite-schema-facts.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { ensureOpenClawAgentStandingIntentsSchema as ensure } from "./openclaw-agent-standing-intents-schema.js";

const schemaSql = extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, "standing_intents", {
  endMarker: "CREATE TABLE IF NOT EXISTS session_transcript_index_state (",
  includeEndMarker: false,
});
const creatorColumnSql =
  "  creator_sender TEXT CHECK (creator_sender IS NULL OR length(trim(creator_sender)) > 0),\n";
const databases: DatabaseSync[] = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function open(admitted = true, filename = ":memory:") {
  const db = openNodeSqliteDatabase(filename);
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
  // A genuine DDL commit starts a new admitted generation on its next use.
  ensure(db);
  const exec = vi.spyOn(db, "exec");
  const reads = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
  try {
    ensure(db, (run) => managed(db, run));
    ensure(db, (run) => managed(db, run));
    expect(exec).not.toHaveBeenCalled();
    expect(reads.queries).toEqual([]);
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
  it("reuses admitted schema facts across repeated bindings without SQL or write admission", () => {
    const filename = path.join(tempDirs.make("standing-intents-reopen-"), "agent.sqlite");
    const original = open(false, filename);
    original.exec(schemaSql);
    admitSqliteSchema(original);
    const facts = getAdmittedSqliteSchemaFacts(original)!;
    original.close();
    const db = open(true, filename);
    const schemaMutation = vi.fn();
    registerSqliteSchemaMutationListener(db, schemaMutation);
    const exec = vi.spyOn(db, "exec");
    const reads = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
    try {
      for (let index = 0; index < 3; index += 1) {
        expect(adoptSqliteSchemaFacts(db, structuredClone(facts))).toBe(true);
        ensure(db, (run) => managed(db, run));
      }
      expect(schemaMutation).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
      expect(reads.queries).toEqual([]);
    } finally {
      reads.restore();
      exec.mockRestore();
    }
  });

  it("retains the supplied write owner's refusal and retries first-use installation", () => {
    const db = open();
    const refused = new Error("schema owner revoked");
    expect(() =>
      ensure(db, (run) =>
        managed(db, () => {
          run();
          throw refused;
        }),
      ),
    ).toThrow(refused);
    expect(
      db.prepare("SELECT name FROM main.sqlite_schema WHERE name = 'standing_intents'").get(),
    ).toBeUndefined();
    ensure(db, (run) => managed(db, run));
    expect(collectSqliteSchemaIssues(db, schemaSql)).toEqual([]);
    expectHotEnsure(db);
  });

  it.each(["outer", "savepoint", "native DDL conflict"] as const)(
    "retries schema after %s rollback",
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
      if (owner === "native DDL conflict") {
        db.exec("CREATE TABLE idx_standing_intents_scope (id INTEGER)");
        expect(() => managed(db, () => ensure(db))).toThrow(/idx_standing_intents_scope/u);
      } else if (owner === "outer") {
        rolledBack();
      } else {
        managed(db, rolledBack);
      }
      expect(
        db.prepare("SELECT name FROM sqlite_schema WHERE name = 'standing_intents'").get(),
      ).toBeUndefined();
      if (owner === "native DDL conflict") {
        db.exec("DROP TABLE idx_standing_intents_scope");
      }
      managed(db, () => ensure(db));
      expect(collectSqliteSchemaIssues(db, schemaSql)).toEqual([]);
      expectHotEnsure(db);
    },
  );

  it.each([
    ["creator column", "ALTER TABLE standing_intents DROP COLUMN creator_sender", "transaction"],
    ["index", "DROP INDEX idx_standing_intents_scope", "later DDL"],
    ["trigger", "DROP TRIGGER standing_intents_fts_after_update", "later DDL"],
    ["creator column", "ALTER TABLE standing_intents DROP COLUMN creator_sender", "sibling DDL"],
    ["index", "DROP INDEX idx_standing_intents_scope", "sibling DDL"],
    ["trigger", "DROP TRIGGER standing_intents_fts_after_update", "sibling DDL"],
  ])("does not cache removal of the %s (%s, %s)", (_name, mutation, phase) => {
    const filename =
      phase === "sibling DDL"
        ? path.join(tempDirs.make("standing-intents-sibling-schema-"), "agent.sqlite")
        : ":memory:";
    const db = open(true, filename);
    if (phase === "sibling DDL") {
      ensure(db);
      const peer = open(true, filename);
      peer.exec(mutation);
    } else if (phase === "later DDL") {
      managed(db, () => ensure(db));
      db.exec(mutation);
    } else {
      managed(db, () => {
        ensure(db);
        db.exec(mutation);
      });
    }
    expect(collectSqliteSchemaIssues(db, schemaSql).length).toBeGreaterThan(0);
    ensure(db);
    expect(collectSqliteSchemaIssues(db, schemaSql)).toEqual([]);
    expectHotEnsure(db);
  });

  it.each(["missing table", "missing creator", "complete"] as const)(
    "keeps the %s repair in main when a TEMP table shadows its name",
    (shape) => {
      const db = open();
      if (shape !== "missing table") {
        db.exec(shape === "complete" ? schemaSql : schemaSql.replace(creatorColumnSql, ""));
      }
      db.exec("CREATE TEMP TABLE standing_intents (temp_only TEXT)");
      ensure(db);
      expect(collectSqliteSchemaIssues(db, schemaSql)).toEqual([]);
      expect(db.prepare("PRAGMA temp.table_info(standing_intents)").all()).toEqual([
        expect.objectContaining({ name: "temp_only" }),
      ]);
      expectHotEnsure(db);
    },
  );

  it("does not admit a generated creator column as the canonical writable column", () => {
    const db = open();
    db.exec(
      schemaSql.replace(
        creatorColumnSql,
        "  creator_sender TEXT GENERATED ALWAYS AS ('synthetic') VIRTUAL,\n",
      ),
    );
    expect(() => ensure(db)).toThrow(/duplicate column name: creator_sender/u);
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
          sql.includes("CREATE TABLE IF NOT EXISTS main.standing_intents"),
        ),
      ).toBe(true);
    } finally {
      exec.mockRestore();
    }
  });
});
