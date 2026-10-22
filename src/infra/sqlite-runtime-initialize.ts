import { initializeSqliteRuntimeCapabilities } from "./bun-sqlite-library.js";
import { requireNodeSqlite } from "./node-sqlite.js";

/** Complete native admission before startup creates workers that inherit process facts. */
export async function initializeSqliteRuntime(): Promise<void> {
  requireNodeSqlite();
  await initializeSqliteRuntimeCapabilities();
}
