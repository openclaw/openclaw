import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { SharedAuthLegacyRows } from "../agents/auth-profiles/shared-store-bootstrap.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { sha256Hex } from "./crypto-digest.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

export const SHARED_AUTH_MIGRATION_KIND = "shared-auth-store-state-db";
export const SHARED_AUTH_MIGRATION_RECEIPT_PREFIX = "shared-auth-store:";
export type SharedAuthMigrationStage = "copied" | "ownership-flipped" | "completed";
export const SHARED_AUTH_MIGRATION_TABLES = [
  { sourceTable: "auth_profile_store", targetTable: "auth_profile_stores" },
  { sourceTable: "auth_profile_state", targetTable: "auth_profile_state" },
] as const;

export function sharedAuthSourceMigrationKey(sourcePath: string, sourceTable: string): string {
  return `${SHARED_AUTH_MIGRATION_RECEIPT_PREFIX}${sha256Hex(`${path.resolve(sourcePath)}\0${sourceTable}`)}`;
}

export function sharedAuthMigrationRunId(sourceDigests: readonly string[]): string {
  return `${SHARED_AUTH_MIGRATION_RECEIPT_PREFIX}${sha256Hex(sourceDigests.join("")).slice(0, 24)}`;
}

export function sharedAuthMigrationRunReport(
  stage: SharedAuthMigrationStage,
  count: number,
): string {
  return JSON.stringify({
    source: SHARED_AUTH_MIGRATION_KIND,
    target: "auth_profile_stores,auth_profile_state",
    stage,
    importedRecordCount: count,
  });
}

export function sharedAuthMigrationSourceReport(params: {
  source: string;
  target: string;
  stage: SharedAuthMigrationStage;
  sourceSha256: string;
  importedRecordCount: number;
}): string {
  return JSON.stringify(params);
}

/** Receipt digests include the historical row shape and timestamp, including null rows. */
export function sharedAuthMigrationRowDigest(row: SharedAuthLegacyRows["store" | "state"]): string {
  return sha256Hex(JSON.stringify(row));
}

export function readSharedAuthMigrationTargetRows(database: DatabaseSync): SharedAuthLegacyRows {
  const cells = executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<Pick<DB, "config_machine_state">>(database)
      .selectFrom("config_machine_state")
      .select(["state_key", "value_json", "updated_at_ms"])
      .where("state_key", "in", ["authProfiles.store", "authProfiles.state"]),
  ).rows;
  const store = cells.find((cell) => cell.state_key === "authProfiles.store");
  const state = cells.find((cell) => cell.state_key === "authProfiles.state");
  return {
    store: store ? { store_json: store.value_json, updated_at: store.updated_at_ms } : null,
    state: state ? { state_json: state.value_json, updated_at: state.updated_at_ms } : null,
  };
}
