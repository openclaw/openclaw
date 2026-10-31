import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { openDoctorStateSchemaReadAdmission } from "../state/openclaw-state-db-doctor-schema.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { pathEntryExists } from "./path-existence.js";
import type { PluginCohortRecoveryPair } from "./update-plugin-cohort-schema.js";
import { withUpdateRunRead } from "./update-run-read-admission.js";
import {
  decodeUpdateRecovery,
  isUpdateRecoveryPending,
  UpdateRecoveryRequiredError,
} from "./update-run-recovery-schema.js";
import {
  inspectPluginCohortRecoveryRows,
  inspectRecoveryRows,
} from "./update-run-recovery-store.js";
import {
  assertNoPendingUpdateRecovery,
  pluginCohortRecoveryMatchesSource,
  type UpdateRecoveryAdmissionOptions,
} from "./update-run-recovery.js";

/** Read-only admission; neither a missing nor a replaced DB retires old recovery. */
export async function assertUpdateRecoveryAdmission(
  options: UpdateRecoveryAdmissionOptions = {},
): Promise<void> {
  options.pluginCohort?.fence.assertCurrent();
  const databasePath = path.resolve(
    options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env),
  );
  const parentExists = await assertUpdateRecoveryDirectoryAdmission(databasePath);
  options.pluginCohort?.fence.assertCurrent();
  if (!parentExists) {
    return;
  }
  assertNoPendingUpdateRecovery({ ...options, path: databasePath });
  options.pluginCohort?.fence.assertCurrent();
}

/** Explicit repair may inspect one bounded pair before acquiring custody. No facts grant effects. */
export async function inspectPluginCohortRecoveryAdmission(
  options: OpenClawStateDatabaseOptions = {},
  expectedRunId?: string,
): Promise<PluginCohortRecoveryPair | undefined> {
  const databasePath = path.resolve(
    options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env),
  );
  if (!(await assertUpdateRecoveryDirectoryAdmission(databasePath))) {
    return undefined;
  }
  const selected = { ...options, path: databasePath };
  return withUpdateRunRead(
    ({ db }) => {
      const cohorts = inspectPluginCohortRecoveryRows(db);
      const pending = inspectRecoveryRows(db).filter((entry) =>
        isUpdateRecoveryPending(entry.record),
      );
      const only = pending[0];
      if (!only) {
        return undefined;
      }
      const pair = cohorts.find(({ cohort }) => cohort.runId === only.record.runId);
      if (
        pending.length !== 1 ||
        !pair ||
        (expectedRunId !== undefined && pair.cohort.runId !== expectedRunId) ||
        !pluginCohortRecoveryMatchesSource(pair, selected)
      ) {
        throw new UpdateRecoveryRequiredError(decodeUpdateRecovery(only.raw, only.record.runId));
      }
      return pair;
    },
    selected,
    openDoctorStateSchemaReadAdmission,
  );
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
