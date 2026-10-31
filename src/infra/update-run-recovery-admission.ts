import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { pathEntryExists } from "./path-existence.js";
import { assertNoPendingUpdateRecovery } from "./update-run-recovery.js";

/** Read-only admission; neither a missing nor a replaced DB retires old recovery. */
export async function assertUpdateRecoveryAdmission(
  options: OpenClawStateDatabaseOptions = {},
): Promise<void> {
  const databasePath = path.resolve(
    options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env),
  );
  if (!(await assertUpdateRecoveryDirectoryAdmission(databasePath))) {
    return;
  }
  assertNoPendingUpdateRecovery({ ...options, path: databasePath });
}

/** Check publication before an admitted row reader; false means the parent is absent. */
export async function assertUpdateRecoveryDirectoryAdmission(
  databasePath: string,
): Promise<boolean> {
  const parent = path.dirname(databasePath);
  if (!(await pathEntryExists(parent))) {
    return false;
  }
  // A family may hold the only original DB even when another canonical file
  // exists. Locators confer no authority to inspect, repair, or retire it.
  // Do not swallow discovery races or recreate an absent canonical database.
  const family = (await fs.readdir(parent)).find((name) => name.startsWith(".openclaw-restore-"));
  if (family) {
    throw new Error(
      `Interrupted shared-database publication left ${path.join(parent, family)}, which may hold the only copy of the original state database; update commands stay read-only. Keep that directory and see https://docs.openclaw.ai/cli/update/repair-and-recovery#interrupted-state-restore.`,
    );
  }
  return true;
}
