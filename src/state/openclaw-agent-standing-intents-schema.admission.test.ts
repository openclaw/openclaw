import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "../infra/node-sqlite.js";
import { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
import { collectSqliteSchemaIssues } from "../infra/sqlite-schema-contract.test-support.js";
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
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function open(admitted = true, filename = ":memory:") {
  const db = openNodeSqliteDatabase(filename);
  if (admitted) {
    admitSqliteSchema(db);
  }
  return db;
}

function managed<T>(db: DatabaseSync, run: () => T) {
  return withSqlitePostCommitPublications(db, () => runSqliteImmediateTransactionSync(db, run));
}

function expectNoSql(db: DatabaseSync, run: () => void) {
  const exec = vi.spyOn(db, "exec");
  const reads = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
  try {
    run();
    expect(exec).not.toHaveBeenCalled();
    expect(reads.queries).toEqual([]);
  } finally {
    reads.restore();
    exec.mockRestore();
  }
}

function expectHotEnsure(db: DatabaseSync) {
  ensure(db); // A genuine DDL commit starts a new admitted generation on its next use.
  expectNoSql(db, () => {
    ensure(db, (run) => managed(db, run));
    ensure(db, (run) => managed(db, run));
  });
}
afterEach(() => vi.restoreAllMocks());

describe("standing-intent schema admission", () => {
  it("reuses admitted schema facts across repeated bindings without SQL or write admission", () => {
    const filename = path.join(tempDirs.make("standing-intents-reopen-"), "agent.sqlite");
    using original = open(false, filename);
    original.exec(schemaSql);
    admitSqliteSchema(original);
    const facts = getAdmittedSqliteSchemaFacts(original)!;
    original.close();
    using db = open(true, filename);
    const schemaMutation = vi.fn();
    registerSqliteSchemaMutationListener(db, schemaMutation);
    expectNoSql(db, () => {
      for (let index = 0; index < 3; index += 1) {
        expect(adoptSqliteSchemaFacts(db, structuredClone(facts))).toBe(true);
        ensure(db, (run) => managed(db, run));
      }
      expect(schemaMutation).not.toHaveBeenCalled();
    });
  });

  it.each(["supplied owner", "outer", "savepoint", "native DDL conflict"] as const)(
    "retries schema after %s rollback",
    (owner) => {
      using db = open();
      const failure = new Error("rollback the schema owner");
      const rolledBack = () =>
        expect(() =>
          managed(db, () => {
            ensure(db);
            throw failure;
          }),
        ).toThrow(failure);
      if (owner === "supplied owner") {
        expect(() =>
          ensure(db, (run) =>
            managed(db, () => {
              run();
              throw failure;
            }),
          ),
        ).toThrow(failure);
      } else if (owner === "native DDL conflict") {
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
      if (owner === "supplied owner") {
        ensure(db, (run) => managed(db, run));
      } else {
        managed(db, () => ensure(db));
      }
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
    using db = open(true, filename);
    if (phase === "sibling DDL") {
      ensure(db);
    }
    using peer = phase === "sibling DDL" ? open(true, filename) : undefined;
    if (peer) {
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
      using db = open();
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
    using db = open();
    db.exec(
      schemaSql.replace(
        creatorColumnSql,
        "  creator_sender TEXT GENERATED ALWAYS AS ('synthetic') VIRTUAL,\n",
      ),
    );
    expect(() => ensure(db)).toThrow(/duplicate column name: creator_sender/u);
  });

  it("does not persist cache state from an unmanaged transaction or unadmitted connection", () => {
    using db = open();
    db.exec("BEGIN");
    ensure(db);
    db.exec("ROLLBACK");
    ensure(db);
    expectHotEnsure(db);
    using unadmitted = open(false);
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
