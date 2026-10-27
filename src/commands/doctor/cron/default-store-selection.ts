import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { note } from "../../../../packages/terminal-core/src/note.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  resolveCronStoreSelectionAsync,
  type CronStoreSelection,
} from "../../../cron/store/paths.js";
import { withArtifactPreservingStateReads } from "../../../state/artifact-preserving-state-reads.js";
import { getOpenClawDatabaseMaintenanceScope } from "../../../state/openclaw-state-db-async-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import type { DoctorOptions, DoctorPrompter } from "../../doctor-prompter.js";
import { repairCronDefaultStoreSelectionForDoctor } from "./store-repair.js";

export function readCronStoreSelectionForDoctor(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CronStoreSelection> {
  const store = asOptionalRecord(cfg.cron)?.store;
  return withArtifactPreservingStateReads(() =>
    resolveCronStoreSelectionAsync(typeof store === "string" ? store : undefined, env),
  );
}

/** Selection is the only deferred cron operation; unrelated Doctor work remains available. */
export async function maybeRepairCronStoreSelection(params: {
  cfg: OpenClawConfig;
  options: DoctorOptions;
  prompter: Partial<Pick<DoctorPrompter, "selectRuntimeRepair">>;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const env = params.env ?? process.env;
  const selection = await readCronStoreSelectionForDoctor(params.cfg, env);
  if (selection.status === "ready") {
    return true;
  }
  note(selection.message, "Cron partition selection");
  if (!(params.options.repair || params.options.yes) || !params.prompter.selectRuntimeRepair) {
    return false;
  }
  const choices = selection.partitions.length
    ? selection.partitions.map((partition) => ({
        value: partition.storeKey,
        label: partition.storeKey,
        hint: `${partition.jobs} jobs, ${partition.scratch} scratch rows, ${partition.receipts} receipts, ${partition.history} runs, ${partition.quarantine} quarantined, ${partition.proactiveReceipts} provisioning receipts`,
      }))
    : [{ value: selection.storePath, label: selection.storePath, hint: "Empty cron store" }];
  const storeKey = await params.prompter.selectRuntimeRepair<string | undefined>(
    {
      message: "Select the default cron partition",
      options: [...choices, { value: undefined, label: "Leave cron paused and decide later" }],
    },
    undefined,
  );
  if (storeKey === undefined) {
    return false;
  }
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  if (!maintenance?.ownsSchemaMaintenance) {
    note("Selection requires offline Doctor maintenance. Run openclaw doctor --fix again.", "Cron");
    return false;
  }
  const assertCurrent = () => maintenance.assertDatabaseAccess(resolveOpenClawStateSqlitePath(env));
  const result = await repairCronDefaultStoreSelectionForDoctor(
    { env },
    { assertCurrent, assertOwnedInTransaction: assertCurrent },
    selection,
    storeKey,
  );
  note(
    `Selected default cron partition ${JSON.stringify(storeKey)}. Saved pre-repair backup: ${result.backupPath}. Restart the Gateway to resume cron.`,
    "Doctor changes",
  );
  return true;
}
