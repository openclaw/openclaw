import { afterEach, expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { writeConfigMachineState } from "./config-machine-state-write.js";
import { readConfigMachineState } from "./config-machine-state.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { hashSqliteSchema } from "./sqlite-schema-shape.test-support.js";

const directories = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  }),
);

it("creates current state without historical DDL and preserves its first write on reopen", async () => {
  const options = { env: { OPENCLAW_STATE_DIR: directories.make("state-fresh-") } };
  const sql = observeHostDataSql();
  let database;
  try {
    database = openOpenClawStateDatabase(options);
    // Empty stores have nothing to retire or rebuild, including disposable legacy indexes.
    expect(sql.queries.filter((query) => /\bDROP\s+(?:TABLE|INDEX)\b/iu.test(query))).toEqual([]);
  } finally {
    sql.restore();
  }
  expect(database.db.prepare("PRAGMA user_version").get()).toEqual({
    user_version: OPENCLAW_STATE_SCHEMA_VERSION,
  });
  expect(
    database.db
      .prepare("SELECT role, schema_version FROM schema_meta WHERE meta_key = 'primary'")
      .get(),
  ).toEqual({ role: "global", schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
  expect(database.db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  expect(database.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  const schema = hashSqliteSchema(requireNativeSqliteDatabase(database.db));
  writeConfigMachineState("fresh.retained", { value: "first write" }, options);
  expect(readConfigMachineState("fresh.retained", options)).toEqual({ value: "first write" });
  await closeStateDatabaseForTest();
  const reopened = openOpenClawStateDatabase(options);
  expect(hashSqliteSchema(requireNativeSqliteDatabase(reopened.db))).toBe(schema);
  expect(readConfigMachineState("fresh.retained", options)).toEqual({ value: "first write" });
});
