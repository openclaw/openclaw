import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import {
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
} from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { pathEntryExists } from "./path-existence.js";
import type { UpdateRecoveryAdmissionOptions } from "./update-run-recovery.js";

/** Only interrupted physical publication refuses; saved updater history is not admission authority. */
export async function assertUpdateRecoveryAdmission(
  options: UpdateRecoveryAdmissionOptions = {},
): Promise<void> {
  options.pluginCohort?.fence.assertCurrent();
  const databasePath = path.resolve(
    options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env),
  );
  await assertUpdateRecoveryDirectoryAdmission(databasePath);
  options.pluginCohort?.fence.assertCurrent();
}

/** Read facts in the fixed worker; live continuation authority never crosses that boundary. */
export async function readUpdateRecoveryAdmissionFactsAsync(options: OpenClawStateDatabaseOptions) {
  const reply = await withArtifactPreservingStateReads(() =>
    executeExistingOpenClawStateRead(
      options,
      { type: "updateRuns.recoveryAdmission" },
      { current: true },
    ),
  );
  return reply?.facts;
}

/** A restore directory beside the state database: evidence, unlike a failed listing. */
export class InterruptedStateRestoreError extends Error {
  override name = "InterruptedStateRestoreError";
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
    throw new InterruptedStateRestoreError(
      `Interrupted shared-database publication left ${path.join(parent, family)}, which may hold the only copy of the original state database; update commands stay read-only. Keep that directory and see https://docs.openclaw.ai/cli/update/repair-and-recovery#interrupted-state-restore.`,
    );
  }
  return true;
}
