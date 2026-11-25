import type { DatabaseSync } from "node:sqlite";
import { ensureColumn } from "./openclaw-state-db-schema-helpers.js";

export const stateWorkerRetentionMigration = {
  version: 39,
  tables: ["worker_environments"],
  columns: ["worker_environments.retention_json"],
  migrate(db: DatabaseSync, previousVersion: number): boolean {
    if (previousVersion >= 39) {
      return false;
    }
    // Existing leases keep their acquisition policy; migration cannot opt them into retention.
    return ensureColumn(db, "worker_environments", "retention_json TEXT");
  },
  applied: "Retained worker acquisition policy, unfinished operation, and observations (v39)",
};

/** Exact predecessor DDL for native admission and PostgreSQL backup restoration. */
export function withLegacyWorkerRetention(schema: string): string {
  return schema.replace(
    /,\n {2}retention_json TEXT(?=\n\))|\n {2}"retention_json" text COLLATE "C",/gu,
    "",
  );
}
