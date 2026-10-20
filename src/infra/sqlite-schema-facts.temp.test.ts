import path from "node:path";
import { StatementSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { getSqliteDatabaseSchemaRevision } from "./sqlite-database-admission.js";
import {
  getAdmittedSqliteSchemaFacts,
  getSqliteReadOperationRevision,
  readSqliteNativeMutationRevision,
  registerSqliteSchemaMutationListener,
  runSqliteReadOperationSync,
} from "./sqlite-schema-facts.js";
import { useSqliteSchemaTestFixture } from "./sqlite-schema-facts.test-support.js";

describe("connection-local SQLite schema admission", () => {
  const { tempDirs, openDatabase } = useSqliteSchemaTestFixture();
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
      const before = getAdmittedSqliteSchemaFacts(sibling)?.admissionId;
      expect(before).toEqual(expect.any(String));
      const revision = getSqliteDatabaseSchemaRevision(sibling)!;
      writer.exec(`CREATE TEMP TRIGGER IF NOT EXISTS local_observer AFTER INSERT ON original BEGIN
        SELECT CASE WHEN NEW.id > 0 THEN 'END; CREATE TABLE quoted(id)' ELSE 'kept' END;
        /* END; */ SELECT 1;
        END;
        ${mainDdl ? "CREATE TABLE published_after_trigger(id);" : ""}`);
      expect(localMutation).toHaveBeenCalledWith(undefined);
      const after = getAdmittedSqliteSchemaFacts(sibling)?.admissionId;
      if (mainDdl) {
        expect(getSqliteDatabaseSchemaRevision(sibling)).toBeGreaterThan(revision);
        expect(after).not.toBe(before);
      } else {
        expect(getSqliteDatabaseSchemaRevision(sibling)).toBe(revision);
        expect(after).toBe(before);
      }
      expect(tableExists(sibling, "published_after_trigger")).toBe(mainDdl);
      expect(
        writer.prepare("SELECT name FROM temp.sqlite_schema WHERE type='trigger'").all(),
      ).toEqual([{ name: "local_observer" }]);
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
        getAdmittedSqliteSchemaFacts(database);
        return getSqliteReadOperationRevision(database);
      });
    const beforeLocal = readRevision();
    expect(beforeLocal).toBeDefined();
    const nativeRevision = readSqliteNativeMutationRevision(database);
    expect(nativeRevision).toBeDefined();
    const siblingFacts = getAdmittedSqliteSchemaFacts(sibling);
    schemaMutation.mockClear();
    runSqliteReadOperationSync(database, () => {
      const observation = observeSqliteReadSql(StatementSync.prototype);
      try {
        database.exec(sql);
        expect(readRevision()).not.toBe(beforeLocal);
        expect(readSqliteNativeMutationRevision(database)).not.toBe(nativeRevision);
        expect(observation.queries.filter((query) => /data_version/iu.test(query))).toEqual([]);
      } finally {
        observation.restore();
      }
    });
    expect(schemaMutation).not.toHaveBeenCalled();
    expect(getAdmittedSqliteSchemaFacts(sibling)).toBe(siblingFacts);
    expect(tableExists(database, "original")).toBe(true);
  });

  it("expires rolled-back TEMP facts without revoking MAIN admission", () => {
    const [database, schemaMutation] = watch();
    database.exec("BEGIN");
    database.exec("CREATE TEMP TABLE scratch(id)");
    const temporary = runSqliteReadOperationSync(database, () =>
      getAdmittedSqliteSchemaFacts(database),
    );
    database.exec("ROLLBACK");
    expect(getAdmittedSqliteSchemaFacts(database)).not.toBe(temporary);
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
});
