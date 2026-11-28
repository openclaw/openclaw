import { expect, it } from "vitest";
import { extractSqliteTableSchema } from "./sqlite-schema-sql.js";

it.each(["STRICT", "STRICT, WITHOUT ROWID"])(
  "extracts a %s table without consuming its neighboring table",
  (options) => {
    const table = `CREATE TABLE IF NOT EXISTS selected (\n  id TEXT PRIMARY KEY\n) ${options};`;
    const schema = `${table}\nCREATE TABLE IF NOT EXISTS neighbor (\n  id INTEGER PRIMARY KEY\n) STRICT;`;
    expect(extractSqliteTableSchema(schema, "selected")).toBe(table);
    expect(extractSqliteTableSchema(schema, "selected", { includeEndMarker: false })).toBe(
      "CREATE TABLE IF NOT EXISTS selected (\n  id TEXT PRIMARY KEY",
    );
  },
);
