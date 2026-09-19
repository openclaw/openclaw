import { Buffer } from "node:buffer";
import type { DatabaseSync } from "node:sqlite";
import type { AliasedExpression } from "kysely";
import {
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "./kysely-sync.js";

/** Admit a filtered JSONL source inside the caller's payload-read transaction. */
export function assertSqliteJsonlReadBudget(
  database: DatabaseSync,
  source: AliasedExpression<{ event_json: string }, "events">,
  budget: number,
  label: string,
): void {
  const db = getNodeSqliteKysely<{ pragma_encoding: { encoding: string } }>(database);
  const encoding = executeSqliteQueryTakeFirstSync(
    database,
    db.selectFrom("pragma_encoding").select("encoding"),
  )?.encoding;
  const utf8 = encoding === "UTF-8";
  const rejectOverflow = (bytes: number) => {
    if (bytes > budget) {
      throw new Error(`${label} is too large to export (at least ${bytes} bytes; limit ${budget})`);
    }
  };

  // Keep this source an unbounded filtered SELECT: SQLite flattens it so
  // octet_length reads column metadata without decoding overflow payloads.
  // UTF-16 stored bytes / 2 is a UTF-8 lower bound, rejecting huge rows first.
  const sizes = iterateSqliteQuerySync(
    database,
    db.selectFrom(source).select((eb) => eb.fn<number>("octet_length", ["event_json"]).as("bytes")),
  );
  let bytes = 0;
  let separator = 0;
  for (const row of sizes) {
    bytes += (utf8 ? row.bytes : Math.ceil(row.bytes / 2)) + separator;
    rejectOverflow(bytes);
    separator = 1;
  }
  if (utf8) {
    return;
  }

  // UTF-16 storage size is not the UTF-8 export size. After metadata admission,
  // decode one bounded row at a time for exact accounting in the same snapshot.
  bytes = 0;
  separator = 0;
  for (const row of iterateSqliteQuerySync(database, db.selectFrom(source).select("event_json"))) {
    bytes += Buffer.byteLength(row.event_json, "utf8") + separator;
    rejectOverflow(bytes);
    separator = 1;
  }
}
