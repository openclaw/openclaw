import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  OPENCLAW_AGENT_SCHEMA_V21_SQL,
  restoreEmptyV21StorageForHistoricalFixture,
} from "./openclaw-agent-schema-v21.test-support.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { collectSqliteSchemaShape } from "./sqlite-schema-shape.test-support.js";

function captureDatabase(database: DatabaseSync) {
  const schema = database
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
    .all();
  return {
    schema,
    rows: schema
      .filter((entry) => entry.type === "table")
      .map((entry) => ({
        table: entry.name,
        rows: database.prepare(`SELECT * FROM "${String(entry.name).replaceAll('"', '""')}"`).all(),
      })),
    foreignKeys: database.prepare("PRAGMA foreign_keys").get(),
    userVersion: database.prepare("PRAGMA user_version").get(),
  };
}

function seedCurrentFixture(database: DatabaseSync) {
  database.exec(OPENCLAW_AGENT_SCHEMA_SQL);
  database.exec(`
    INSERT INTO cache_entries (scope, key, value_json, updated_at)
      VALUES ('historical-fixture', 'preserved', '{"keep":true}', 7);
  `);
}

describe("historical schema-21 storage fixture", () => {
  it("restores the frozen outbox and trajectory storage", () => {
    using database = new DatabaseSync(":memory:");
    using historical = new DatabaseSync(":memory:");
    seedCurrentFixture(database);
    historical.exec(OPENCLAW_AGENT_SCHEMA_V21_SQL);
    const cacheRows = database.prepare("SELECT * FROM cache_entries").all();

    restoreEmptyV21StorageForHistoricalFixture(database);

    const outbox = collectSqliteSchemaShape(database).context_engine_turn_outbox;
    assert(outbox, "Historical fixture must contain the outbox");
    expect(outbox).toEqual(collectSqliteSchemaShape(historical).context_engine_turn_outbox);
    expect(outbox.columns.map((column) => column.name)).not.toContain("enqueue_sequence");
    expect(outbox.columns.map((column) => column.name)).not.toContain("payload_state");
    expect(outbox.columns.filter((column) => column.pk !== 0)).toEqual([
      expect.objectContaining({ name: "advancement_key", pk: 1 }),
    ]);
    expect(collectSqliteSchemaShape(database).trajectory_runtime_events).toEqual(
      collectSqliteSchemaShape(historical).trajectory_runtime_events,
    );
    expect(database.prepare("SELECT * FROM cache_entries").all()).toEqual(cacheRows);
    expect(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it.each([0, 1])(
    "refuses a populated outbox without changing data or schema (foreign_keys=%s)",
    (foreignKeys) => {
      using database = new DatabaseSync(":memory:");
      seedCurrentFixture(database);
      database.exec(`PRAGMA foreign_keys = ${foreignKeys}`);
      database.exec(`
        INSERT INTO context_engine_turn_outbox
          (advancement_key, engine_id, session_id, payload_json, created_at)
          VALUES ('pending-turn', 'engine', 'session', '{}', 1);
      `);
      const before = captureDatabase(database);

      expect(() => restoreEmptyV21StorageForHistoricalFixture(database)).toThrow(
        "Historical fixture must not discard context_engine_turn_outbox data",
      );

      expect(captureDatabase(database)).toEqual(before);
    },
  );

  it.each([0, 1])(
    "rolls back every dropped table when outbox reconstruction fails (foreign_keys=%s)",
    (foreignKeys) => {
      using database = new DatabaseSync(":memory:");
      seedCurrentFixture(database);
      database.exec(`PRAGMA foreign_keys = ${foreignKeys}`);
      const before = captureDatabase(database);
      const execute = database.exec.bind(database);
      const failure = new Error("injected after outbox drop");
      const fault = vi.spyOn(database, "exec").mockImplementation((sql) => {
        execute(sql);
        if (sql === "DROP TABLE context_engine_turn_outbox") {
          expect(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(0);
          throw failure;
        }
      });
      try {
        expect(() => restoreEmptyV21StorageForHistoricalFixture(database)).toThrow(failure);
      } finally {
        fault.mockRestore();
      }

      expect(captureDatabase(database)).toEqual(before);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
      // A new transaction proves the failed reconstruction did not leave its writer open.
      database.exec("BEGIN IMMEDIATE; ROLLBACK");
    },
  );
});
