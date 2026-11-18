import path from "node:path";
import { StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { getSqliteDatabaseSchemaRevision } from "./sqlite-database-admission.js";
import {
  getAdmittedSqliteSchemaFacts as facts,
  getSqliteReadOperationRevision as operationRevision,
  readSqliteNativeMutationRevision as nativeRevision,
  registerSqliteSchemaMutationListener,
  runSqliteReadOperationSync,
} from "./sqlite-schema-facts.js";
import { useSqliteSchemaTestFixture } from "./sqlite-schema-facts.test-support.js";

const { tempDirs, openDatabase } = useSqliteSchemaTestFixture();
afterEach(() => vi.restoreAllMocks());
function watch(schema?: string, filename?: string) {
  const database = openDatabase(schema, true, filename);
  const mutation = vi.fn();
  registerSqliteSchemaMutationListener(database, mutation);
  return [database, mutation] as const;
}

it.each([false, true])(
  "keeps TEMP trigger admission local without hiding subsequent main DDL: %s",
  (mainDdl) => {
    const filename = path.join(tempDirs.make("openclaw-schema-temp-trigger-"), "state.sqlite");
    const [writer, localMutation] = watch(undefined, filename);
    const sibling = openDatabase("", true, filename);
    const before = facts(sibling)?.admissionId;
    expect(before).toEqual(expect.any(String));
    const revision = getSqliteDatabaseSchemaRevision(sibling)!;
    writer.exec(`CREATE TEMP TRIGGER IF NOT EXISTS local_observer AFTER INSERT ON original BEGIN
        SELECT CASE WHEN NEW.id > 0 THEN 'END; CREATE TABLE quoted(id)' ELSE 'kept' END;
        /* END; */ SELECT 1;
        END;
        ${mainDdl ? "CREATE TABLE published_after_trigger(id);" : ""}`);
    expect(localMutation).toHaveBeenCalledWith(undefined);
    const after = facts(sibling)?.admissionId;
    const nextRevision = getSqliteDatabaseSchemaRevision(sibling)!;
    expect(mainDdl ? nextRevision > revision : nextRevision === revision).toBe(true);
    expect(after === before).toBe(!mainDdl);
    expect(tableExists(sibling, "published_after_trigger")).toBe(mainDdl);
    const triggers = writer.prepare("SELECT name FROM temp.sqlite_schema WHERE type='trigger'");
    expect(triggers.all()).toEqual([{ name: "local_observer" }]);
  },
);

it.each([
  "CREATE TABLE unexpected (id INTEGER)",
  "CREATE TEMP TABLE scratch (id); CREATE TABLE unexpected (id INTEGER)",
  "PRAGMA user_version = 2",
  "DROP TABLE session_nodes",
  "DROP TABLE main.session_nodes",
])("revokes admission for ordinary DDL: %s", (sql) => {
  const [database, schemaMutation] = watch("CREATE TABLE session_nodes (id INTEGER)");
  database.exec(sql);
  expect(schemaMutation).toHaveBeenCalledWith(undefined);
});

it.each([
  "CREATE TEMP TABLE memory_publication_input (id)",
  "DROP TABLE temp.original",
  'DROP TABLE IF EXISTS "TeMp"."original"',
  "DROP /* cleanup */ TABLE `temp`.[original]; -- done",
])("expires local TEMP facts while preserving MAIN admission: %s", (sql) => {
  const filename = path.join(tempDirs.make("openclaw-schema-temp-"), "state.sqlite");
  const [database, schemaMutation] = watch("CREATE TABLE original(id)", filename);
  const sibling = openDatabase("", true, filename);
  database.exec("CREATE TEMP TABLE original(id)");
  const readRevision = () =>
    runSqliteReadOperationSync(database, () => {
      facts(database);
      return operationRevision(database);
    });
  const beforeLocal = readRevision();
  const beforeNative = nativeRevision(database);
  expect([beforeLocal, beforeNative]).not.toContain(undefined);
  const siblingFacts = facts(sibling);
  schemaMutation.mockClear();
  runSqliteReadOperationSync(database, () => {
    const observation = observeSqliteReadSql(StatementSync.prototype);
    database.exec(sql);
    expect([readRevision() !== beforeLocal, nativeRevision(database) !== beforeNative]).toEqual([
      true,
      true,
    ]);
    expect(observation.queries.filter((query) => /data_version/iu.test(query))).toEqual([]);
  });
  expect(schemaMutation).not.toHaveBeenCalled();
  expect(facts(sibling)).toBe(siblingFacts);
  expect(tableExists(database, "original")).toBe(true);
});

it("expires rolled-back TEMP facts without revoking MAIN admission", () => {
  const [database, schemaMutation] = watch();
  database.exec("BEGIN");
  database.exec("CREATE TEMP TABLE scratch(id)");
  const temporary = runSqliteReadOperationSync(database, () => facts(database));
  database.exec("ROLLBACK");
  expect(facts(database)).not.toBe(temporary);
  expect(() => database.prepare("SELECT * FROM temp.scratch").all()).toThrow(/no such table/);
  expect(schemaMutation).not.toHaveBeenCalled();
});

it("does not suppress reentrant MAIN DDL inside a TEMP table statement", () => {
  const [database, schemaMutation] = watch();
  database.function("create_main_table", () => {
    database.exec("CREATE TABLE callback_table(id)");
    return 1;
  });
  database.exec("CREATE TEMP TABLE scratch AS SELECT create_main_table()");
  expect(schemaMutation).toHaveBeenCalledWith(undefined);
  expect(tableExists(database, "callback_table")).toBe(true);
});
