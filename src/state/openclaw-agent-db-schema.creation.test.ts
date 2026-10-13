import { describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { assertCanonicalSessionValidationSchema } from "./openclaw-agent-canonical-validation-schema.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { ensureOpenClawAgentSchema } from "./openclaw-agent-db-schema.js";
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
      ensureOpenClawAgentSchema(database, "fresh", ":memory:");
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
    expect(() =>
      runSqliteImmediateTransactionSync(database, () => {
        ensureOpenClawAgentSchema(database, "fresh", ":memory:");
        throw new Error("cancel creation");
      }),
    ).toThrow("cancel creation");
    expect(database.prepare("SELECT name FROM sqlite_schema").all()).toEqual([]);
    expect(() => assertCanonicalSessionValidationSchema(database)).toThrow(
      /Session metadata unavailable \(table-missing:/u,
    );

    ensureOpenClawAgentSchema(database, "fresh", ":memory:");
    expect(() => assertCanonicalSessionValidationSchema(database)).not.toThrow();
  });
});
