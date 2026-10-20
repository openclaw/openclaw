import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  OPENCLAW_AGENT_SCHEMA_V21_SQL,
  restoreEmptyV21StorageForHistoricalFixture,
} from "./openclaw-agent-schema-v21.test-support.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { assertSqliteMigrationScopePreserved } from "./sqlite-migration-scope.test-support.js";
import { collectSqliteSchemaShape } from "./sqlite-schema-shape.test-support.js";

function currentFixture(foreignKeys = 1) {
  const database = new DatabaseSync(":memory:");
  database.exec(OPENCLAW_AGENT_SCHEMA_SQL);
  database.exec(`
    PRAGMA foreign_keys = ${foreignKeys};
    INSERT INTO cache_entries (scope, key, value_json, updated_at)
      VALUES ('historical-fixture', 'preserved', '{"keep":true}', 7);
  `);
  return database;
}

it("restores the frozen outbox and trajectory storage", () => {
  using database = currentFixture();
  using historical = new DatabaseSync(":memory:");
  historical.exec(OPENCLAW_AGENT_SCHEMA_V21_SQL);
  const cacheRows = database.prepare("SELECT * FROM cache_entries").all();

  restoreEmptyV21StorageForHistoricalFixture(database);

  const outbox = collectSqliteSchemaShape(database).context_engine_turn_outbox;
  expect(outbox).toBeDefined();
  expect(outbox).toEqual(collectSqliteSchemaShape(historical).context_engine_turn_outbox);
  expect(collectSqliteSchemaShape(database).trajectory_runtime_events).toEqual(
    collectSqliteSchemaShape(historical).trajectory_runtime_events,
  );
  expect(database.prepare("SELECT * FROM cache_entries").all()).toEqual(cacheRows);
  expect(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
  expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

afterEach(() => vi.restoreAllMocks());

it.each([
  ["populated", 0],
  ["populated", 1],
  ["rollback", 0],
  ["rollback", 1],
] as const)("preserves storage after %s rejection (foreign_keys=%s)", async (mode, foreignKeys) => {
  using database = currentFixture(foreignKeys);
  const failure = new Error(
    mode === "populated"
      ? "Historical fixture must not discard context_engine_turn_outbox data"
      : "injected after outbox drop",
  );
  if (mode === "populated") {
    database.exec(`INSERT INTO context_engine_turn_outbox
      (advancement_key, engine_id, session_id, payload_json, created_at)
      VALUES ('pending-turn', 'engine', 'session', '{}', 1)`);
  } else {
    const execute = database.exec.bind(database);
    vi.spyOn(database, "exec").mockImplementation((sql) => {
      execute(sql);
      if (sql === "DROP TABLE context_engine_turn_outbox") {
        expect(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(0);
        throw failure;
      }
    });
  }
  const metadata = () => [
    database.prepare("PRAGMA foreign_keys").get(),
    database.prepare("PRAGMA user_version").get(),
  ];
  const before = metadata();
  await assertSqliteMigrationScopePreserved(database, [], () => {
    expect(() => restoreEmptyV21StorageForHistoricalFixture(database)).toThrow(failure);
  });
  vi.restoreAllMocks();
  expect(metadata()).toEqual(before);
  if (mode === "rollback") {
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    database.exec("BEGIN IMMEDIATE; ROLLBACK");
  }
});
