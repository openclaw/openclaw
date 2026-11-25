import type { DatabaseSync } from "node:sqlite";
import { quoteSqliteIdentifier as quote } from "../sqlite-schema-sql.js";
import { readAutoincrementHighWater } from "../sqlite-strict.js";

export type PortAllocationFact = { value: string; called: boolean };

/** Reads the retained id allocation for one SQLite identity, including AUTOINCREMENT. */
export function readSqlitePortAllocation(
  db: DatabaseSync,
  table: string,
  column: string,
  autoIncrement: boolean,
): PortAllocationFact {
  const statement = db.prepare(`SELECT max(${quote(column)}) AS value FROM ${quote(table)}`);
  statement.setReadBigInts(true);
  let value = statement.get()?.value;
  if (autoIncrement) {
    const high = readAutoincrementHighWater(db, table);
    if (high !== null && (value === null || (typeof value === "bigint" && BigInt(high) > value))) {
      value = BigInt(high);
    }
  }
  // SQLite treats `sqlite_sequence.seq = 0` like an absent row: the table never
  // allocated an id. PostgreSQL sequence bounds start at 1, so a called 0 aborts
  // setval; keep the "never called" shape instead.
  if (value === 0n || value === 0) {
    return { value: "1", called: false };
  }
  return { value: String(value ?? 1), called: value !== null && value !== undefined };
}
