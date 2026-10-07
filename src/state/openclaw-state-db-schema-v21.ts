import type { DatabaseSync } from "node:sqlite";
import {
  DELEGATED_EXECUTION_OWNERSHIP_EVENT_TABLE,
  DELEGATED_EXECUTION_OWNERSHIP_TABLE,
  delegatedExecutionOwnershipSchemaSql,
} from "../delegation/delegated-execution-ownership.schema.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";

/**
 * v21 installs the durable delegated-execution ownership registry.
 *
 * The published version is also the downgrade fence: a build that predates this
 * release refuses the database through the shared schema-version admission, so
 * it cannot activate ordinary execution while ownership rows exist.
 */
export function migrateDelegatedExecutionOwnershipV21(
  db: DatabaseSync,
  previousVersion: number,
): boolean {
  if (previousVersion >= 21) {
    return false;
  }
  if (
    tableExists(db, DELEGATED_EXECUTION_OWNERSHIP_TABLE) &&
    tableExists(db, DELEGATED_EXECUTION_OWNERSHIP_EVENT_TABLE)
  ) {
    return false;
  }
  // sqlite-allow-raw -- canonical feature-local additive DDL; registry rows use Kysely.
  db.exec(delegatedExecutionOwnershipSchemaSql());
  return true;
}
