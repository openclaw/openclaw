import {
  createBackupArchive,
  formatBackupCreateSummary,
  type BackupCreateOptions,
  type BackupCreateResult,
} from "../infra/backup-create.js";
import type { RuntimeEnv } from "../runtime.js";
import { backupVerifyCommand } from "./backup-verify.js";
export type { BackupCreateOptions, BackupCreateResult } from "../infra/backup-create.js";

export async function backupCreateCommand(
  runtime: RuntimeEnv,
  opts: BackupCreateOptions = {},
): Promise<BackupCreateResult> {
  const result = await createBackupArchive(opts);
  if (opts.verify && !opts.dryRun) {
    await backupVerifyCommand(
      {
        ...runtime,
        log: () => {},
      },
      { archive: result.archivePath, json: false },
    );
    result.verified = true;
  }
  const output = opts.json
    ? JSON.stringify(result, null, 2)
    : formatBackupCreateSummary(result).join("\n");
  runtime.log(output);
  return result;
}
