import { describe, expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { installSqliteTempTrackingSchema } from "./sqlite-schema-facts.js";
import { useSqliteSchemaTestFixture } from "./sqlite-schema-facts.test-support.js";
import type { SqliteTempTrackingSchema } from "./sqlite-temp-generation-schema.js";

describe("connection-local tracking installation", () => {
  const { openDatabase } = useSqliteSchemaTestFixture();

  it("skips absent trigger drops and preserves transcript writes after reinstall and rollback", () => {
    const database = openDatabase("CREATE TABLE original (session_id TEXT, id INTEGER)");
    const schema: SqliteTempTrackingSchema = {
      statusTable: "local_status",
      pendingTable: "local_pending",
      pendingIndex: "local_pending_state",
      observedTables: ["original"],
    };
    const observed = observeHostDataSql();
    try {
      installSqliteTempTrackingSchema(database, schema);
      expect(database.prepare("SELECT total_changes() AS writes").get()).toEqual({ writes: 1 });
      expect(observed.queries.filter((sql) => /\bDROP TRIGGER\b/iu.test(sql))).toEqual([]);
    } finally {
      observed.restore();
    }
    const expectPending = (ids: string[]) => {
      expect(
        database.prepare("SELECT session_id FROM temp.local_pending ORDER BY session_id").all(),
      ).toEqual(ids.map((session_id) => ({ session_id })));
    };
    database.exec("INSERT INTO original VALUES ('first', 1)");
    expectPending(["first"]);
    database.exec("DELETE FROM temp.local_pending");

    database.exec(`UPDATE temp.local_status SET sibling_write_revision = 7,
      schema_version = 42, complete = 1, after_session = 'cursor', completed_traversals = 9`);
    installSqliteTempTrackingSchema(database, schema);
    expect(database.prepare("SELECT * FROM temp.local_status").get()).toEqual({
      id: 1,
      sibling_write_revision: -1,
      schema_version: 42,
      complete: 1,
      after_session: "cursor",
      completed_traversals: 9,
    });
    database.exec("BEGIN; UPDATE original SET session_id = 'rolled-back'; ROLLBACK");
    expectPending([]);
    database.exec("UPDATE original SET session_id = 'second'");
    expectPending(["first", "second"]);
    database.exec("BEGIN");
    installSqliteTempTrackingSchema(database, schema);
    database.exec("ROLLBACK");
    installSqliteTempTrackingSchema(database, schema);
    database.exec("DELETE FROM original");
    expectPending(["first", "second"]);
  });
});
