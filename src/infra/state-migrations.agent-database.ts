import type { DatabaseSync } from "node:sqlite";
import type { OpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { admitSqliteSchema } from "./sqlite-schema-facts.js";
import { createSqliteWalReclamationResult } from "./sqlite-wal-reclamation.js";

/** Adapt a migration-owned connection without transferring its WAL or close custody. */
export function createMigrationDatabaseHandle(
  database: DatabaseSync,
  agentId: string,
  pathname: string,
): OpenClawAgentDatabase {
  // The previous migration handle may have closed and retired its schema facts.
  admitSqliteSchema(database);
  return {
    agentId,
    db: database,
    path: pathname,
    walMaintenance: {
      checkpoint: () => false,
      stop: async () => {},
      close: () => false,
      reclaimFreePages: createSqliteWalReclamationResult,
    },
  };
}
