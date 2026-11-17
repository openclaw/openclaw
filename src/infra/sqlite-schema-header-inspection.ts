import fs from "node:fs";
import { setSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import {
  prepareSqliteReadOnlyCopyInProcess,
  prepareSqliteReadOnlyLocationInProcess,
  readSourceJournalMode,
  readSourceSidecars,
  requiresPrivateRollbackRecovery,
} from "./sqlite-readonly-location.js";
import {
  readSqliteSchemaHeader,
  readSqliteSchemaHeaderFromSnapshot,
} from "./sqlite-schema-header.js";
import { SQLITE_SOURCE_READ_BUSY_TIMEOUT_MS } from "./sqlite-snapshot-policy.js";
import { withSqliteSourceReadDatabase } from "./sqlite-source-handle.js";

/** Fixed metadata inspection in the read-only child; no payload scan or backup
 * unless source journal state requires private recovery/artifact preservation. */
export async function inspectSqliteSchemaHeaderInProcess(
  pathname: string,
  stagingRoot?: string,
  agentSchemaVersionForOwnership?: number,
  preserveSourceArtifacts = false,
  options: { cleanupFailure?: "warn" } = {},
) {
  const canonicalPath = fs.realpathSync.native(pathname);
  if (preserveSourceArtifacts) {
    return readSqliteSchemaHeaderFromSnapshot(
      await prepareSqliteReadOnlyCopyInProcess(canonicalPath, stagingRoot),
      undefined,
      agentSchemaVersionForOwnership,
      options,
    );
  }
  const mode = readSourceJournalMode(canonicalPath);
  const sidecars = readSourceSidecars(canonicalPath);
  if (mode !== "wal" || (sidecars.wal && sidecars.shm)) {
    let readError: unknown;
    try {
      return withSqliteSourceReadDatabase(canonicalPath, "source", (database) => {
        try {
          setSqliteBusyTimeout(database, SQLITE_SOURCE_READ_BUSY_TIMEOUT_MS);
          return readSqliteSchemaHeader(database, agentSchemaVersionForOwnership);
        } catch (error) {
          readError = error;
          throw error;
        }
      });
    } catch (error) {
      // Only SQLite's recovery-required refusal permits private recovery.
      // Ordinary I/O, admission, and native close errors must stay failures.
      if (error !== readError || !requiresPrivateRollbackRecovery(canonicalPath, error)) {
        throw error;
      }
    }
  }
  // An incomplete WAL family would create source sidecars on native open.
  // The existing snapshot owner also handles hot rollback recovery privately.
  const prepared = await prepareSqliteReadOnlyLocationInProcess(canonicalPath, stagingRoot);
  return readSqliteSchemaHeaderFromSnapshot(
    prepared,
    undefined,
    agentSchemaVersionForOwnership,
    options,
  );
}
