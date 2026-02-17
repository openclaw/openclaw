/**
 * Drizzle ORM client for OpenClaw.
 *
 * Wraps the existing postgres.js connection from client.ts so both raw SQL
 * and Drizzle queries can coexist during the migration period.
 */

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getDatabase } from "./client.js";
import * as schema from "./drizzle-schema.js";

export type DrizzleDb = PostgresJsDatabase<typeof schema>;

let instance: DrizzleDb | null = null;

/**
 * Get the Drizzle ORM client instance (singleton).
 * Reuses the postgres.js connection from getDatabase().
 */
export function getDrizzle(): DrizzleDb {
  if (instance) {
    return instance;
  }
  const sql = getDatabase();
  instance = drizzle(sql, { schema });
  return instance;
}

/**
 * Reset the Drizzle instance (for testing).
 */
export function resetDrizzle(): void {
  instance = null;
}
