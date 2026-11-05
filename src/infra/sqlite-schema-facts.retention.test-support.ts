import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { collectForRetentionCheck } from "../test-utils/retention.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { hasPendingSqliteDatabaseSchemaMutation } from "./sqlite-database-admission.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "./sqlite-schema-facts.js";

const [root] = process.argv.slice(2);
assert.ok(root, "SQLite statement retention requires its temporary directory");

function abandon(statement: StatementSync): WeakRef<object>[] {
  const rows = statement.iterate();
  assert.equal(rows.next().done, false);
  return [new WeakRef(statement), new WeakRef(rows)];
}

let collected = 0;
for (const tracked of [false, true]) {
  const filename = path.join(root, tracked ? "tracked.sqlite" : "native.sqlite");
  const database = tracked ? openNodeSqliteDatabase(filename) : new DatabaseSync(filename);
  database.exec("CREATE TABLE original(id); INSERT INTO original VALUES(1),(2)");
  if (tracked) {
    admitSqliteSchema(database);
  }
  const sibling = openNodeSqliteDatabase(filename);
  admitSqliteSchema(sibling);
  try {
    database.function("create_schema", () => {
      database.exec("CREATE TABLE callback_table(id)");
      return 1;
    });
    const references = abandon(database.prepare("SELECT create_schema() FROM original"));
    await collectForRetentionCheck(`sqlite-statement-${tracked ? "tracked" : "native"}`);
    for (const reference of references) {
      assert.equal(reference.deref(), undefined, "Abandoned native statement must collect");
      collected += 1;
    }
    assert.equal(hasPendingSqliteDatabaseSchemaMutation(sibling), false);
    assert.ok(sibling.prepare("SELECT name FROM sqlite_schema WHERE name='callback_table'").get());
    if (tracked) {
      assert.equal(getAdmittedSqliteSchemaFacts(sibling)?.tables.has("callback_table"), true);
      database.exec("CREATE TABLE after_gc(id)");
      assert.equal(hasPendingSqliteDatabaseSchemaMutation(sibling), false);
      assert.equal(getAdmittedSqliteSchemaFacts(sibling)?.tables.has("after_gc"), true);
    }
  } finally {
    database.close();
    sibling.close();
  }
}
process.stdout.write(JSON.stringify({ collected, pending: false }));
