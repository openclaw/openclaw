import type { DatabaseSync } from "node:sqlite";
import { ensureColumn, tableExists } from "./openclaw-state-db-schema-helpers.js";

export const stateApprovalProfileMigration = {
  version: 41,
  tables: ["operator_approvals"],
  columns: ["operator_approvals.requested_by_profile_id"],
  migrate(db: DatabaseSync, previousVersion: number): boolean {
    if (previousVersion >= 41 || !tableExists(db, "operator_approvals")) {
      return false;
    }
    return ensureColumn(db, "operator_approvals", "requested_by_profile_id TEXT");
  },
  applied: "Retained trusted approval requester profiles without historical inference (v41)",
};

/** Exact predecessor DDL; historical requester profiles remain unknown. */
export function withLegacyApprovalProfile(schema: string): string {
  return schema
    .replace("  requested_by_profile_id TEXT,\n", "")
    .replace('  "requested_by_profile_id" text COLLATE "C",\n', "");
}
