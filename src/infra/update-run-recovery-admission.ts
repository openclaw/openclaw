import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { hasNodeErrorCode } from "./path-guards.js";
import { assertNoPendingUpdateRecovery } from "./update-run-recovery.js";

/** Read-only admission; neither a missing nor a replaced DB retires old recovery. */
export async function assertUpdateRecoveryAdmission(
  options: OpenClawStateDatabaseOptions = {},
): Promise<void> {
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
    return;
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
  assertNoPendingUpdateRecovery(options);
}
