import type { DatabaseSync } from "node:sqlite";
import { ensureColumn } from "./openclaw-state-db-schema-helpers.js";

export const stateWorkerResourceReceiptMigration = {
  version: 37,
  tables: ["worker_environments"],
  columns: ["worker_environments.resource_receipt_json"],
  migrate(db: DatabaseSync, previousVersion: number): boolean {
    if (previousVersion >= 37) {
      return false;
    }
    // Existing environments remain unqualified; only a provider can supply resource identity.
    return ensureColumn(db, "worker_environments", "resource_receipt_json TEXT");
  },
  applied: "Retained immutable worker provider resource receipts (v37)",
};

/** Exact predecessor DDL for PostgreSQL migration admission and backups. */
export function withLegacyWorkerResourceReceipts(schema: string): string {
  return schema.replace(
    /,\n {2}resource_receipt_json TEXT(?=\n\))|\n {2}"resource_receipt_json" text COLLATE "C",/gu,
    "",
  );
}
