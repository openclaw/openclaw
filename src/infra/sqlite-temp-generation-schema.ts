import type { DatabaseSync } from "node:sqlite";
import { executeWithCachedStatement } from "./kysely-sync-cache-state.js";
import { normalizeSchemaSql, quoteSqliteIdentifier } from "./sqlite-schema-sql.js";

/** A singleton (id = 1, generation) counter and TEMP triggers that only increment it. */
export type SqliteTempGenerationSchema = {
  table: string;
  triggers: readonly {
    name: string;
    table: string;
    operation: "INSERT" | "UPDATE" | "DELETE";
    enabled: boolean;
  }[];
};

export function prepareSqliteTempGenerationSchema(
  database: DatabaseSync,
  schema: SqliteTempGenerationSchema,
  advance: boolean,
): { sql: string; unexpected: boolean } {
  const table = quoteSqliteIdentifier(schema.table);
  const counter = `${table} (id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL) STRICT`;
  const increment = `UPDATE ${table} SET generation = generation + 1 WHERE id = 1;`;
  const triggers = schema.triggers.map((trigger) => ({
    ...trigger,
    definition: `TRIGGER ${quoteSqliteIdentifier(trigger.name)} AFTER ${trigger.operation} ON main.${quoteSqliteIdentifier(trigger.table)} BEGIN ${increment} END`,
  }));
  const definitions = new Map([
    [
      schema.table.toLowerCase(),
      { type: "table", table: schema.table, sql: `CREATE TABLE ${counter}` },
    ],
    ...triggers.map(
      (trigger) =>
        [
          trigger.name.toLowerCase(),
          { type: "trigger", table: trigger.table, sql: `CREATE ${trigger.definition}` },
        ] as const,
    ),
  ]);
  const names = [schema.table, ...triggers.map((trigger) => trigger.name)];
  // sqlite-allow-raw -- One TEMP admission snapshot verifies names and shapes before replacement.
  const existing = executeWithCachedStatement(
    database,
    `SELECT type, name, tbl_name, sql FROM temp.sqlite_schema WHERE name COLLATE NOCASE IN (${names.map(() => "?").join(",")})`,
    names,
    (statement) => statement.all(...names),
  );
  const unexpected = existing.some((row) => {
    const declared =
      typeof row.name === "string" ? definitions.get(row.name.toLowerCase()) : undefined;
    return (
      !declared ||
      row.type !== declared.type ||
      row.tbl_name !== declared.table ||
      typeof row.sql !== "string" ||
      normalizeSchemaSql(row.sql) !== normalizeSchemaSql(declared.sql)
    );
  });
  const sql = `
    CREATE TEMP TABLE IF NOT EXISTS ${counter};
    INSERT OR IGNORE INTO temp.${table} (id, generation) VALUES (1, 0);
    ${advance ? `UPDATE temp.${table} SET generation = generation + 1 WHERE id = 1;` : ""}
    ${triggers
      .map(({ name, definition, enabled }) => {
        const trigger = quoteSqliteIdentifier(name);
        return `DROP TRIGGER IF EXISTS temp.${trigger};${enabled ? `CREATE TEMP ${definition};` : ""}`;
      })
      .join("\n")}
  `;
  return { sql, unexpected };
}
