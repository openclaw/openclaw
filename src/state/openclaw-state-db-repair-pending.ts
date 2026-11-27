import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { readOnlyOpenWouldCreateSqliteSidecars } from "../infra/sqlite-files.js";
import { inspectSqliteIndexCorruption } from "../infra/sqlite-index-schema.js";
import {
  assertSqliteIntegrity,
  isTerminalSqliteIntegrityError,
  SqliteRepairableForeignKeyError,
  type SqliteIntegrityCheckOptions,
} from "../infra/sqlite-integrity.js";
import { hasUpdateDoctorMigrationCapture } from "../infra/update-doctor-migration-context.js";
import { isArtifactPreservingStateRead } from "./artifact-preserving-state-reads.js";
import { readOpenClawDatabaseQuarantineFailure } from "./openclaw-quarantine-store.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { hasDanglingSkillWorkshopCollectionReviewIndex } from "./openclaw-state-db-doctor-schema.js";
import { isStatePostgres } from "./openclaw-state-db-engine.js";
import { hasOpenClawStatePermissionDrift } from "./openclaw-state-db-permissions.js";
import { assertCanonicalAgentDatabasesPrimaryKey } from "./openclaw-state-db-schema-repair.js";
import { readStateSchemaContentVersion } from "./openclaw-state-db-schema-version.js";
import { hasOrphanTaskDeliveryRows } from "./openclaw-state-db-task-delivery-recovery-preservation.js";
import { resolveDatabasePath } from "./openclaw-state-db.paths.js";
import { resolveSchemaMigrationIntegrityCheck } from "./schema-migration-backup-scope.js";

/** A recorded open failure or quarantine verdict makes Doctor rescan indexes and clear it. */
export function hasRecordedStateDatabaseDamage(pathname: string, env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    openClawStateDatabaseCache.getOpenClawStateDatabaseRecordedFailure(pathname) ||
    readOpenClawDatabaseQuarantineFailure("state", pathname, { env, fresh: true }),
  );
}

/**
 * Doctor's index repair decision: "corrupt" proves damage that only an index scan can
 * repair, "foreign-key" leaves known orphan rows to the readability repair, and any
 * other failure (busy, unreadable) is thrown to the caller.
 */
export function classifyStateDatabaseIntegrity(
  database: DatabaseSync,
  pathname: string,
  integrity: SqliteIntegrityCheckOptions,
): "verified" | "corrupt" | "foreign-key" {
  try {
    assertSqliteIntegrity(database, pathname, integrity);
    return "verified";
  } catch (error) {
    if (error instanceof Error && isTerminalSqliteIntegrityError(error)) {
      return "corrupt";
    }
    if (error instanceof SqliteRepairableForeignKeyError) {
      return "foreign-key";
    }
    throw error;
  }
}

/**
 * Read-only: whether Doctor's explicit state database repair (index and readability
 * scopes, see `repairDoctorStateDatabase`) would change the shared state database.
 *
 * Without copying the store it answers from the live file: private file modes,
 * a recorded quarantine or open failure, integrity (the same quick or full check the
 * repair runs), the dangling Skill Workshop review index, orphan task delivery rows,
 * and the canonical registry key the repair asserts first. It cannot decide, and so
 * reports "undecidable", for PostgreSQL, under an updater's migration capture or an
 * artifact-preserving read (both require a copy), and when no connection holds the
 * WAL sidecars open (opening it would create them).
 */
export function checkOpenClawStateDatabaseRepairPending(options: {
  env: NodeJS.ProcessEnv;
  integrityCheck: "quick" | "full";
}): "work" | "none" | "undecidable" {
  if (isStatePostgres() || hasUpdateDoctorMigrationCapture() || isArtifactPreservingStateRead()) {
    return "undecidable";
  }
  const pathname = resolveDatabasePath({ env: options.env });
  if (!existsSync(pathname)) {
    return "none";
  }
  if (
    hasOpenClawStatePermissionDrift(pathname, options.env) ||
    hasRecordedStateDatabaseDamage(pathname, options.env)
  ) {
    return "work";
  }
  if (readOnlyOpenWouldCreateSqliteSidecars(pathname)) {
    return "undecidable";
  }
  using database = openNodeSqliteDatabase(pathname, { readOnly: true });
  // The dangling index makes ordinary catalog reads fail, so it is read first.
  if (hasDanglingSkillWorkshopCollectionReviewIndex(database)) {
    return "work";
  }
  assertCanonicalAgentDatabasesPrimaryKey(database, pathname);
  // A full check always scans; the scan writes only when it finds damaged indexes.
  const damaged =
    options.integrityCheck === "full"
      ? inspectSqliteIndexCorruption(database, pathname, {}).indexes.length > 0
      : classifyStateDatabaseIntegrity(
          database,
          pathname,
          resolveSchemaMigrationIntegrityCheck(
            {
              kind: "state",
              foundVersion: readStateSchemaContentVersion(database),
              supportedVersion: OPENCLAW_STATE_SCHEMA_VERSION,
            },
            "quick",
          ),
        ) === "corrupt";
  return damaged || hasOrphanTaskDeliveryRows(database) ? "work" : "none";
}
