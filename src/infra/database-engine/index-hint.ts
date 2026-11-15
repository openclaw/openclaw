import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { isPostgresSqlConnection, type PostgresSqlConnection } from "../sql-connection.js";

export function engineIndexHint(db: DatabaseSync | PostgresSqlConnection, indexName: string) {
  // Index names come from the schema owner; PostgreSQL chooses its own access path.
  return /* kysely-allow-raw: Engine-owned index hint using a trusted schema identifier. */ sql.raw(
    isPostgresSqlConnection(db) ? "" : `INDEXED BY ${indexName}`,
  );
}
