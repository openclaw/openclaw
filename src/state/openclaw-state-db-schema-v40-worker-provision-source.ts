import type { DatabaseSync } from "node:sqlite";
import { ensureColumn, tableExists } from "./openclaw-state-db-schema-helpers.js";

export const stateWorkerProvisionSourceMigration = {
  version: 40,
  tables: ["worker_environments"],
  columns: ["worker_environments.provision_source_json"],
  migrate(db: DatabaseSync, previousVersion: number): boolean {
    if (previousVersion >= 40 || !tableExists(db, "worker_environments")) {
      return false;
    }
    const changed = ensureColumn(db, "worker_environments", "provision_source_json TEXT");
    // Old pending rows cannot distinguish a person from independent internal work.
    // Keep uncertain allocation custody while refusing to invent recovery authority.
    const pending = db
      .prepare(`UPDATE worker_environments
      SET provision_source_json = '{"kind":"unavailable"}'
      WHERE (state IN ('requested', 'provisioning') AND lease_id IS NULL
        OR state = 'bootstrapping' AND owner_epoch = 0)
        AND provision_source_json IS NULL`)
      .run();
    return changed || Number(pending.changes) > 0;
  },
  applied: "Original worker provisioning source retained across recovery (v40)",
};

/** Exact predecessor DDL for native admission and PostgreSQL backup restoration. */
export function withLegacyWorkerProvisionSource(schema: string): string {
  return schema.replace(
    /,\n {2}provision_source_json TEXT(?=\n\))|\n {2}"provision_source_json" text COLLATE "C",/gu,
    "",
  );
}
