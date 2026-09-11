import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "./kysely-sync-cache-state.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { hasNodeErrorCode } from "./path-guards.js";
import { prepareSqliteReadOnlyLocation } from "./sqlite-snapshot-source.js";
import {
  isUpdateRecoveryPending,
  UpdateRecoveryRequiredError,
} from "./update-run-recovery-schema.js";
import { readRecoveries } from "./update-run-recovery-store.js";
import { assertNoPendingUpdateRecovery } from "./update-run-recovery.js";

async function inspectUpdateRecoveryDatabasePath(
  options: OpenClawStateDatabaseOptions,
): Promise<string | undefined> {
  const databasePath = path.resolve(
    options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env),
  );
  const parent = path.dirname(databasePath);
  try {
    await fs.lstat(parent);
  } catch (error) {
    if (!hasNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
    return undefined;
  }
  // A family may hold the only original DB even when another canonical file
  // exists. Locators confer no authority to inspect, repair, or retire it.
  // Do not swallow discovery races or recreate an absent canonical database.
  const families = await fs.readdir(parent);
  if (families.some((name) => name.startsWith(".openclaw-restore-"))) {
    throw new Error(
      "Interrupted shared-database publication is read-only while full-state recovery is deferred",
    );
  }
  return databasePath;
}

/** Read-only admission; neither a missing nor a replaced DB retires old recovery. */
export async function assertUpdateRecoveryAdmission(
  options: OpenClawStateDatabaseOptions = {},
): Promise<void> {
  if (await inspectUpdateRecoveryDatabasePath(options)) {
    assertNoPendingUpdateRecovery(options);
  }
}

/** Inspect only the stable recovery namespace before restoring a verified state set. */
export async function assertUpdateRecoveryBackupAdmission(
  options: OpenClawStateDatabaseOptions,
  assertOwned: () => void,
): Promise<void> {
  assertOwned();
  const databasePath = await inspectUpdateRecoveryDatabasePath(options);
  assertOwned();
  if (!databasePath) {
    return;
  }
  try {
    await fs.stat(databasePath);
  } catch (error) {
    if (!hasNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
    assertOwned();
    return;
  }
  assertOwned();
  // The old runtime must not apply its schema ceiling to the state it needs to
  // restore. Inspect the existing namespace in a private, artifact-preserving copy.
  const snapshot = await prepareSqliteReadOnlyLocation(databasePath, {
    preserveSourceArtifacts: true,
  });
  try {
    assertOwned();
    const db = openNodeSqliteDatabase(snapshot.location, { readOnly: true });
    try {
      if (!tableExists(db, "config_machine_state")) {
        throw new Error("Update recovery metadata is unavailable; automatic rollback was refused.");
      }
      const pending = readRecoveries(db).find(isUpdateRecoveryPending);
      if (pending) {
        throw new UpdateRecoveryRequiredError(pending);
      }
      assertOwned();
    } finally {
      clearNodeSqliteKyselyCacheForDatabase(db);
      db.close();
    }
  } finally {
    snapshot.cleanup();
  }
}
