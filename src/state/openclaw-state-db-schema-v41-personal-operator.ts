import type { DatabaseSync } from "node:sqlite";
import { ensureColumn } from "./openclaw-state-db-schema-helpers.js";

export const statePersonalOperatorMigration = {
  version: 41,
  tables: ["device_pairing_paired"],
  columns: ["device_pairing_paired.operator_profile_id"],
  migrate(db: DatabaseSync, previousVersion: number): boolean {
    if (previousVersion >= 41) {
      return false;
    }
    // Legacy pairings remain shared; only explicit enrollment assigns a profile.
    return ensureColumn(db, "device_pairing_paired", "operator_profile_id TEXT");
  },
  applied: "Added explicit personal operator association to paired installations (v41)",
};

/** Exact predecessor DDL for native admission and PostgreSQL backup restoration. */
export function withLegacyPersonalOperator(schema: string): string {
  return schema.replace(
    /,\n {2}operator_profile_id TEXT(?=\n\))|\n {2}"operator_profile_id" text COLLATE "C",/gu,
    "",
  );
}
