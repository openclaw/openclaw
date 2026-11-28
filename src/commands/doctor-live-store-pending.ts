import { existsSync } from "node:fs";
import { readOnlyOpenWouldCreateSqliteSidecars } from "../infra/sqlite-files.js";
import { hasUpdateDoctorMigrationCapture } from "../infra/update-doctor-migration-context.js";
import {
  isArtifactPreservingStateRead,
  withLiveStateReads,
} from "../state/artifact-preserving-state-reads.js";
import type { DoctorMaintenancePending } from "./doctor-maintenance-pending.js";

/** Store reads here are served from copies: an updater's migration capture or an artifact-preserving read. */
export function storeReadsNeedCopies(): boolean {
  return hasUpdateDoctorMigrationCapture() || isArtifactPreservingStateRead();
}

/**
 * Runs a Doctor pending check's SQLite reads against the live stores, never a copy.
 *
 * It is undecidable under an updater's migration capture or an artifact-preserving read
 * (both require a copy), and when a listed store exists but no connection holds its WAL
 * sidecars open, because a read-only open would then create them. Beside a serving
 * Gateway, which holds its stores open, the reads decide.
 */
export async function decideDoctorPendingFromLiveStores(
  sqlitePaths: readonly string[],
  decide: () => DoctorMaintenancePending | Promise<DoctorMaintenancePending>,
): Promise<DoctorMaintenancePending> {
  if (storeReadsNeedCopies()) {
    return "undecidable";
  }
  if (
    sqlitePaths.some(
      (pathname) => existsSync(pathname) && readOnlyOpenWouldCreateSqliteSidecars(pathname),
    )
  ) {
    return "undecidable";
  }
  return withLiveStateReads(decide);
}
