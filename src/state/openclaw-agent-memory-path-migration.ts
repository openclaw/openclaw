import { MEMORY_PATH_POSTGRES_INDEX_SQL } from "../../packages/memory-host-sdk/src/host/memory-path-postgres.js";

/** Reconstruct the exact predecessor before any older version transforms. */
export function withLegacyAgentPostgresMemoryPaths(sql: string): string {
  return sql.replace(`${MEMORY_PATH_POSTGRES_INDEX_SQL}\n\n`, "");
}
