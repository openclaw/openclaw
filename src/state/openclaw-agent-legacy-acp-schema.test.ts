import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
import { assertSqliteSchemaContains as assertSchema } from "../infra/sqlite-schema-contract.test-support.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION as version } from "./openclaw-agent-db-contract.js";
import { AGENT_SCHEMA_COMPATIBILITY } from "./openclaw-agent-db-schema-compatibility.js";
import {
  ensureLegacyAcpMigrationProvenanceColumn as ensureProvenance,
  hasLegacyAcpMigrationProvenanceColumn as hasProvenance,
} from "./openclaw-agent-legacy-acp-schema.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

const current = extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, "session_nodes");
const previous = current.replace(/^\s*legacy_acp_migration_json[^\n]*\n/mu, "");
const row = (db: DatabaseSync, sql: string) => db.prepare(sql).get();
const provenance = (db: DatabaseSync) =>
  row(db, "SELECT legacy_acp_migration_json FROM session_nodes");

function install(db: DatabaseSync, afterInstall = () => {}) {
  withSqlitePostCommitPublications(db, () =>
    runSqliteImmediateTransactionSync(db, () => {
      ensureProvenance(db);
      afterInstall();
    }),
  );
}

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`${previous}
    PRAGMA user_version = ${version};
    INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
      VALUES ('key', 'session', '{"sessionId":"session"}', 1);`);
  return db;
}

it("keeps first-use provenance compatible, idempotent and rollback-safe", () => {
  using db = fixture();
  const original = row(db, "SELECT entry_json FROM session_nodes");
  const before = row(db, "PRAGMA schema_version");
  expect(() =>
    install(db, () => {
      expect(hasProvenance(db)).toBe(true);
      throw new Error("abort provenance first use");
    }),
  ).toThrow("abort provenance first use");
  expect(row(db, "PRAGMA schema_version")).toEqual(before);
  expect(hasProvenance(db)).toBe(false);
  install(db);
  const committed = row(db, "PRAGMA schema_version");
  ensureProvenance(db);
  expect(row(db, "PRAGMA schema_version")).toEqual(committed);
  expect(() => assertSchema(db, ":memory:", current)).not.toThrow();
  expect(provenance(db)).toEqual({ legacy_acp_migration_json: null });
  expect(() =>
    assertSchema(db, ":memory:", previous, { allowCompatibleAdditiveColumns: true }),
  ).not.toThrow();
  const value = '{"sourceKey":"fixture-source"}';
  db.prepare("UPDATE session_nodes SET legacy_acp_migration_json = ?").run(value);
  db.prepare("UPDATE session_nodes SET label = ?").run("older-reader-edit");
  expect(provenance(db)).toEqual({ legacy_acp_migration_json: value });
  expect(row(db, "SELECT entry_json FROM session_nodes")).toEqual(original);
  expect(row(db, "PRAGMA user_version")).toEqual({ user_version: version });
});

it("accepts the absent lazy column without mutating an old schema during reads", () => {
  using db = fixture();
  const contents = () =>
    [
      "SELECT sql FROM sqlite_schema ORDER BY name",
      "SELECT * FROM session_nodes",
      "PRAGMA user_version",
    ].map((sql) => db.prepare(sql).all());
  const before = contents();
  db.exec("PRAGMA query_only = ON");
  expect(hasProvenance(db)).toBe(false);
  expect(() => assertSchema(db, ":memory:", current, AGENT_SCHEMA_COMPATIBILITY)).not.toThrow();
  expect(contents()).toEqual(before);
});
