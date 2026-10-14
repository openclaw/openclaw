import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "../sqlite-schema-facts.js";
import { openEngineStore } from "./open.js";

const schema = { id: "fixture", version: 1, sqlite: "CREATE TABLE fixture_rows (id TEXT)" };

describe("engine store opening", () => {
  it.each(["schema_meta", "cron_jobs"])(
    "refuses existing %s data without relying on a store prefix",
    (table) => {
      const anchor = openNodeSqliteDatabase(":memory:");
      try {
        anchor.exec(`CREATE TABLE ${table} (value TEXT); INSERT INTO ${table} VALUES ('retained')`);
        expect(() =>
          openEngineStore({
            anchor,
            schema: { ...schema, postgres: "CREATE TABLE fixture_rows (id TEXT)" },
            input: { connection: "postgresql://127.0.0.1:1/unreachable", schemaPrefix: "fixture" },
            prepareAnchor: () => {},
            openSqlite: () => {
              throw new Error("Must not bootstrap SQLite");
            },
            inspectSqlite: () => {
              admitSqliteSchema(anchor);
              return {
                hasExistingData: (getAdmittedSqliteSchemaFacts(anchor)?.tables.size ?? 0) > 0,
                hasEngineAnchor: false,
              };
            },
          }),
        ).toThrow("Existing SQLite fixture data cannot switch engines");
        expect(anchor.prepare(`SELECT value FROM ${table}`).get()).toMatchObject({
          value: "retained",
        });
      } finally {
        anchor.close();
      }
    },
  );

  it("keeps an unported store on SQLite even when PostgreSQL is configured", () => {
    using anchor = new DatabaseSync(":memory:");
    const db = openEngineStore({
      anchor,
      schema,
      input: { connection: "postgresql://127.0.0.1:1/unreachable", schemaPrefix: "openclaw" },
      prepareAnchor: () => {},
      inspectSqlite: () => ({ hasExistingData: false, hasEngineAnchor: false }),
      openSqlite: () => anchor.exec(schema.sqlite),
    });
    expect(db).toBe(anchor);
    db.prepare("INSERT INTO fixture_rows VALUES (?)").run("native");
    expect(db.prepare("SELECT id FROM fixture_rows").all()).toEqual([{ id: "native" }]);
  });

  it("refuses an existing PostgreSQL anchor instead of creating SQLite tables", () => {
    using anchor = new DatabaseSync(":memory:");
    anchor.exec(
      "CREATE TABLE openclaw_engine_anchor (schema TEXT); INSERT INTO openclaw_engine_anchor VALUES ('remote')",
    );
    expect(() =>
      openEngineStore({
        anchor,
        schema,
        prepareAnchor: () => {},
        inspectSqlite: () => ({ hasExistingData: false, hasEngineAnchor: true }),
        openSqlite: () => anchor.exec(schema.sqlite),
      }),
    ).toThrow(/database.engine to postgres/);
    expect(
      anchor.prepare("SELECT name FROM sqlite_schema WHERE name = 'fixture_rows'").all(),
    ).toEqual([]);
  });
});
