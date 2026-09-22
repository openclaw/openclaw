import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  hasPersistedOpenClawAgentCanonicalValidation,
  recordOpenClawAgentCanonicalValidation,
} from "./openclaw-agent-canonical-validation-receipt.js";
import { assertOpenClawAgentSchemaContains } from "./openclaw-agent-db-schema-helpers.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "./openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

it("lazily records nullable generation proof at the same schema version and rolls back first use", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const options = { agentId: "main", env };
    const original = openOpenClawAgentDatabase(options);
    closeOpenClawAgentDatabaseByPath(original.path);
    const old = new DatabaseSync(original.path);
    try {
      old.exec("ALTER TABLE session_key_contract DROP COLUMN canonical_ready");
    } finally {
      old.close();
    }
    const database = openOpenClawAgentDatabase(options);
    const version = database.db.prepare("PRAGMA user_version").get();
    const previousSchema = OPENCLAW_AGENT_SCHEMA_SQL.replace(/^\s*canonical_ready TEXT,\n/mu, "");
    const schema = database.db.prepare("PRAGMA schema_version").get();
    expect(hasPersistedOpenClawAgentCanonicalValidation(database)).toBe(false);
    expect(() =>
      runOpenClawAgentWriteTransaction((current) => {
        recordOpenClawAgentCanonicalValidation(current);
        throw new Error("rollback first receipt");
      }, options),
    ).toThrow("rollback first receipt");
    expect(database.db.prepare("PRAGMA schema_version").get()).toEqual(schema);
    expect(hasPersistedOpenClawAgentCanonicalValidation(database)).toBe(false);

    runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
    expect(hasPersistedOpenClawAgentCanonicalValidation(database)).toBe(true);
    expect(
      database.db
        .prepare("PRAGMA table_info(session_key_contract)")
        .all()
        .find((column) => column.name === "canonical_ready"),
    ).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null, pk: 0 });
    expect(() =>
      assertOpenClawAgentSchemaContains(database.db, database.path, previousSchema),
    ).not.toThrow();
    const completeSchema = database.db.prepare("PRAGMA schema_version").get();
    runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
    expect(database.db.prepare("PRAGMA schema_version").get()).toEqual(completeSchema);
    expect(database.db.prepare("PRAGMA user_version").get()).toEqual(version);
  });
});

it("requires admitted physical identity and write admission for persisted canonical receipts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const options = { agentId: "main", env };
    const database = openOpenClawAgentDatabase(options);
    runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
    const raw = new DatabaseSync(database.path, { readOnly: true });
    try {
      expect(hasPersistedOpenClawAgentCanonicalValidation({ db: raw, agentId: "main" })).toBe(
        false,
      );
      expect(hasPersistedOpenClawAgentCanonicalValidation({ ...database, agentId: "other" })).toBe(
        false,
      );
      expect(() => recordOpenClawAgentCanonicalValidation(database)).toThrow("write admission");
    } finally {
      raw.close();
    }
  });
});
