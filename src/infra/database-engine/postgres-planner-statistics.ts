import type { Client } from "pg";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { quoteSqliteIdentifier as quote } from "../sqlite-schema-sql.js";

export type PostgresPlannerStatistics =
  | { status: "analyzed"; tables: number }
  | { status: "warning"; warning: string };

/** Offline bulk-load maintenance; the caller owns the namespace and an idle client. */
export async function refreshPostgresPlannerStatistics(
  client: Client,
  namespace: string,
): Promise<PostgresPlannerStatistics> {
  try {
    // A separate transaction keeps an optimization failure from undoing verified data.
    await client.query("BEGIN; SET LOCAL statement_timeout = '10s'; SET LOCAL lock_timeout = '1s'");
    const { rows } = await client.query<{ relname: string }>(
      `SELECT c.relname FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'm') ORDER BY c.relname`,
      [namespace],
    );
    if (rows.length) {
      await client.query(
        `ANALYZE ${rows.map(({ relname }) => `${quote(namespace)}.${quote(relname)}`).join(", ")}`,
      );
    }
    await client.query("COMMIT");
    return { status: "analyzed", tables: rows.length };
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    // SQL errors can contain connection details or data. Only emit recovery guidance.
    const warning =
      "PostgreSQL ANALYZE did not complete; verified data is retained. Autovacuum can refresh planner statistics later.";
    createSubsystemLogger("database").warn(warning);
    return { status: "warning", warning };
  }
}
