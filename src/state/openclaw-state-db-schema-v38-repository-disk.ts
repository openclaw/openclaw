import type { DatabaseSync } from "node:sqlite";
import { ensureColumn } from "./openclaw-state-db-schema-helpers.js";
import { stateWorkerResourceReceiptMigration } from "./openclaw-state-db-schema-v37-resource-receipts.js";

const stateRepositoryDiskAuthorityMigration = {
  version: 38,
  tables: ["session_repository_workspaces", "worker_workspace_pending_results"],
  columns: [
    "session_repository_workspaces.disk_authority_json",
    "worker_workspace_pending_results.repository_disk_authority_json",
  ],
  migrate(db: DatabaseSync, previousVersion: number): boolean {
    if (previousVersion >= 38) {
      return false;
    }
    // NULL preserves accepted mirror semantics; absent first-use repository storage stays absent.
    const repository = ensureColumn(
      db,
      "session_repository_workspaces",
      "disk_authority_json TEXT",
    );
    const pending = ensureColumn(
      db,
      "worker_workspace_pending_results",
      "repository_disk_authority_json TEXT",
    );
    return repository || pending;
  },
  applied: "Retained repository disk authority and original pending-result authority (v38)",
};

export const stateWorkerDiskMigrations = [
  stateWorkerResourceReceiptMigration,
  stateRepositoryDiskAuthorityMigration,
] as const;

/** Exact predecessor shape for PostgreSQL migration admission and backup restoration. */
export function withLegacyRepositoryDiskAuthority(schema: string): string {
  return schema.replace(
    /\n {2}(?:(?:disk_authority_json|repository_disk_authority_json) TEXT|"(?:disk_authority_json|repository_disk_authority_json)" text COLLATE "C"),/gu,
    "",
  );
}
