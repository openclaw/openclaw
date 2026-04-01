import {
  executeRestore,
  formatBackupRestoreSummary,
  planRestore,
  type BackupRestoreOptions,
  type BackupRestoreResult,
} from "../infra/backup-restore.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

export type { BackupRestoreOptions, BackupRestoreResult } from "../infra/backup-restore.js";

export async function backupRestoreCommand(
  runtime: RuntimeEnv,
  opts: BackupRestoreOptions,
): Promise<BackupRestoreResult> {
  const plan = await planRestore(opts);

  const conflicts = plan.assets.filter((a) => a.conflict);
  if (conflicts.length > 0 && !opts.force && !opts.dryRun) {
    const paths = conflicts.map((a) => `  - ${a.displayPath}`).join("\n");
    throw new Error(
      `Restore would overwrite existing paths:\n${paths}\nUse --force to overwrite, or --dry-run to preview.`,
    );
  }

  if (!opts.dryRun) {
    plan.restoredCount = await executeRestore(plan, opts);
  }

  if (opts.json) {
    writeRuntimeJson(runtime, plan);
  } else {
    runtime.log(formatBackupRestoreSummary(plan).join("\n"));
  }
  return plan;
}
