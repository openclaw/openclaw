import type { DatabaseSync } from "node:sqlite";
import { sql, type Expression, type RawBuilder } from "kysely";
import { isPostgresSqlConnection, type PostgresSqlConnection } from "../sql-connection.js";

/** Slice encoded bytes on the server; SQLite retains its physical text encoding. */
export function engineTextByteSliceSql(
  db: DatabaseSync | PostgresSqlConnection,
  value: Expression<string>,
  offset: number | Expression<number>,
  length: number,
): RawBuilder<Uint8Array> {
  return isPostgresSqlConnection(db)
    ? /* kysely-allow-raw: Slice UTF-8 bytes rather than Unicode characters. */ sql<Uint8Array>`substring(convert_to(${value}, 'UTF8') FROM ${offset} FOR ${length})`
    : /* kysely-allow-raw: Keep native encoded bytes and preserve empty-text frames. */ sql<Uint8Array>`coalesce(substr(CAST(${value} AS BLOB), ${offset}, ${length}), CAST('' AS BLOB))`;
}

/** Preserve byte-order comparisons for text keys using each engine's encoding. */
export function engineTextHexSql(
  db: DatabaseSync | PostgresSqlConnection,
  value: Expression<string | null>,
): RawBuilder<string> {
  return isPostgresSqlConnection(db)
    ? /* kysely-allow-raw: PostgreSQL text is stored in UTF-8; match SQLite's uppercase hex. */ sql<string>`upper(encode(convert_to(${value}, 'UTF8'), 'hex'))`
    : /* kysely-allow-raw: Preserve the native text encoding used by SQLite key ordering. */ sql<string>`hex(cast(${value} as blob))`;
}
