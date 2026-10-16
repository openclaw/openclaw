import type { DatabaseSync } from "node:sqlite";
import { executeWithCachedStatement } from "./kysely-sync-cache-state.js";
import { normalizeSchemaSql, quoteSqliteIdentifier } from "./sqlite-schema-sql.js";

export type SqliteTempTrackingSchema = {
  kind: "transcript-index";
  statusTable: string;
  pendingTable: string;
  pendingIndex: string;
  observedTables: readonly string[];
};

type SqliteTempObject = {
  name: string;
  type: "table" | "index" | "trigger";
  table: string;
  sql: string;
};

export function prepareSqliteTempTrackingSchema(
  database: DatabaseSync,
  schema: SqliteTempTrackingSchema,
): { sql: string; unexpected: boolean } {
  const { createSql, objects } = prepareTranscriptIndexSchema(schema);
  const definitions = new Map(objects.map((object) => [object.name.toLowerCase(), object]));
  const names = objects.map((object) => object.name);
  const tableNames = objects
    .filter((object) => object.type === "table")
    .map((object) => object.name);
  const parameters = [...names, ...tableNames];
  // sqlite-allow-raw -- One TEMP admission snapshot verifies names and shapes before replacement.
  const existing = executeWithCachedStatement(
    database,
    `SELECT type, name, tbl_name, sql FROM temp.sqlite_schema
     WHERE name COLLATE NOCASE IN (${names.map(() => "?").join(",")})
       OR (type = 'trigger' AND tbl_name COLLATE NOCASE IN (${tableNames.map(() => "?").join(",")}))`,
    parameters,
    (statement) => statement.all(...parameters),
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
  const existingTriggers = new Set(
    existing.flatMap((row) =>
      row.type === "trigger" && typeof row.name === "string" ? [row.name.toLowerCase()] : [],
    ),
  );
  return { sql: createSql(existingTriggers), unexpected };
}

function prepareTranscriptIndexSchema(schema: SqliteTempTrackingSchema): {
  createSql: (existingTriggers: ReadonlySet<string>) => string;
  objects: SqliteTempObject[];
} {
  const status = quoteSqliteIdentifier(schema.statusTable);
  const pending = quoteSqliteIdentifier(schema.pendingTable);
  const index = quoteSqliteIdentifier(schema.pendingIndex);
  const statusTable = `${status} (
    id INTEGER PRIMARY KEY CHECK (id = 1), sibling_write_revision INTEGER NOT NULL,
    schema_version INTEGER NOT NULL, complete INTEGER NOT NULL, after_session TEXT,
    completed_traversals INTEGER NOT NULL
  ) STRICT`;
  const pendingTable = `${pending} (session_id TEXT PRIMARY KEY, state INTEGER NOT NULL) STRICT`;
  const pendingIndex = `${index} ON ${pending}(state, session_id)`;
  const triggers = schema.observedTables.flatMap((table) =>
    (["INSERT", "UPDATE", "DELETE"] as const).map((operation) => {
      const name = `openclaw_${table}_projection_${operation.toLowerCase()}`;
      const sources =
        operation === "UPDATE" ? ["OLD", "NEW"] : [operation === "DELETE" ? "OLD" : "NEW"];
      return {
        name,
        table,
        definition: `TRIGGER ${quoteSqliteIdentifier(name)} AFTER ${operation} ON main.${quoteSqliteIdentifier(table)}
          WHEN ${sources
            .map(
              (source) => `NOT EXISTS (
                SELECT 1 FROM ${pending}
                WHERE session_id = ${source}.session_id AND state = 0
              )`,
            )
            .join(" OR ")} BEGIN
            ${sources
              .map(
                (source) => `
                  UPDATE ${pending} SET state = 0 WHERE session_id = ${source}.session_id;
                  INSERT INTO ${pending}
                    SELECT ${source}.session_id, 0 WHERE NOT EXISTS (
                      SELECT 1 FROM ${pending} WHERE session_id = ${source}.session_id
                    );`,
              )
              .join("\n")}
          END`,
      };
    }),
  );
  // Update before the conflict-free insert preserves an outer INSERT OR REPLACE policy.
  const createSql = (existingTriggers: ReadonlySet<string>) => `
    CREATE TEMP TABLE IF NOT EXISTS ${statusTable};
    INSERT OR IGNORE INTO temp.${status} VALUES (1, -1, -1, 0, NULL, 0);
    UPDATE temp.${status} SET sibling_write_revision = -1;
    CREATE TEMP TABLE IF NOT EXISTS ${pendingTable};
    CREATE INDEX IF NOT EXISTS temp.${pendingIndex};
    ${triggers
      .map(({ name, definition }) => {
        const drop = existingTriggers.has(name.toLowerCase())
          ? `DROP TRIGGER IF EXISTS temp.${quoteSqliteIdentifier(name)};`
          : "";
        return `${drop}CREATE TEMP ${definition};`;
      })
      .join("\n")}
  `;
  return {
    createSql,
    objects: [
      {
        name: schema.statusTable,
        type: "table",
        table: schema.statusTable,
        sql: `CREATE TABLE ${statusTable}`,
      },
      {
        name: schema.pendingTable,
        type: "table",
        table: schema.pendingTable,
        sql: `CREATE TABLE ${pendingTable}`,
      },
      {
        name: schema.pendingIndex,
        type: "index",
        table: schema.pendingTable,
        sql: `CREATE INDEX ${pendingIndex}`,
      },
      ...triggers.map((trigger): SqliteTempObject => ({
        name: trigger.name,
        type: "trigger",
        table: trigger.table,
        sql: `CREATE ${trigger.definition}`,
      })),
    ],
  };
}
