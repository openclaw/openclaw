import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import {
  observeHostDataSql,
  observeSqliteReadSql,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "../infra/node-sqlite.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { assertCanonicalSessionValidationSchema } from "./openclaw-agent-canonical-validation-schema.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { ensureOpenClawAgentSchema } from "./openclaw-agent-db-schema.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { hashSqliteSchema } from "./sqlite-schema-shape.test-support.js";

const fixtures = createFixtureLifetime();
afterAll(() => fixtures.cleanup());

describe("fresh agent schema admission", () => {
  it("also creates the canonical schema on an independently managed connection", () => {
    const { DatabaseSync } = requireNodeSqlite();
    using database = new DatabaseSync(":memory:");
    using canonical = openNodeSqliteDatabase(":memory:");
    canonical.exec(OPENCLAW_AGENT_SCHEMA_SQL);
    database.exec("PRAGMA foreign_keys = OFF;");
    ensureOpenClawAgentSchema(database, "fresh", ":memory:");
    expect(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
    expect(hashSqliteSchema(database)).toBe(hashSqliteSchema(canonical));
    expect(() => assertCanonicalSessionValidationSchema(database)).not.toThrow();
  });

  it.each(["owner", "newer version"] as const)(
    "refuses a concurrent %s committed before the initial writer lock",
    (change) => {
      const databasePath = path.join(fixtures.createTempDir("agent-schema-claim-"), "agent.sqlite");
      using database = openNodeSqliteDatabase(databasePath);
      using concurrent = openNodeSqliteDatabase(databasePath);
      database.exec("PRAGMA foreign_keys = ON;");
      const nativeExec = database.exec.bind(database);
      let changed = false;
      let foreignKeysAtBegin: unknown;
      const exec = vi.spyOn(database, "exec").mockImplementation((sql) => {
        if (!changed && sql.trimStart().startsWith("BEGIN IMMEDIATE")) {
          // Commit the competing write exactly after preparation but before lock acquisition.
          changed = true;
          foreignKeysAtBegin = database.prepare("PRAGMA foreign_keys").get()?.foreign_keys;
          if (change === "owner") {
            ensureOpenClawAgentSchema(concurrent, "winner", databasePath);
          } else {
            concurrent.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1};`);
          }
        }
        return nativeExec(sql);
      });
      try {
        expect(() => ensureOpenClawAgentSchema(database, "loser", databasePath)).toThrow(
          change === "owner"
            ? "belongs to agent winner"
            : `newer schema version ${OPENCLAW_AGENT_SCHEMA_VERSION + 1}`,
        );
        expect(changed).toBe(true);
        expect(foreignKeysAtBegin).toBe(0);
        expect(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
        if (change === "owner") {
          expect(concurrent.prepare("SELECT agent_id FROM schema_meta").get()?.agent_id).toBe(
            "winner",
          );
        } else {
          expect(concurrent.prepare("PRAGMA user_version").get()?.user_version).toBe(
            OPENCLAW_AGENT_SCHEMA_VERSION + 1,
          );
          expect(concurrent.prepare("SELECT name FROM sqlite_schema").all()).toEqual([]);
        }
      } finally {
        exec.mockRestore();
      }
    },
  );

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

  it("rolls back cold creation and its facts when the outer commit guard refuses", () => {
    using database = openNodeSqliteDatabase(":memory:");
    database.exec("PRAGMA foreign_keys = OFF;");
    admitSqliteSchema(database);
    let allowed = true;
    const withMutation = <T>(run: () => T): T => {
      if (!allowed) {
        throw new Error("creation authority revoked");
      }
      const result = run();
      allowed = false;
      return result;
    };
    expect(() =>
      ensureOpenClawAgentSchema(
        database,
        "fresh",
        ":memory:",
        OPENCLAW_AGENT_SCHEMA_VERSION,
        withMutation,
      ),
    ).toThrow("creation authority revoked");
    expect(database.isTransaction).toBe(false);
    expect(database.prepare("SELECT name FROM sqlite_schema").all()).toEqual([]);
    expect(getAdmittedSqliteSchemaFacts(database)?.userVersion).toBe(0);
    expect(getAdmittedSqliteSchemaFacts(database)?.tables.size).toBe(0);
    expect(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
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
