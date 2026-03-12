import fs from "node:fs/promises";
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
  const shouldVerify = opts.verify !== false;
  if (shouldVerify && !opts.dryRun) {
    try {
      await backupVerifyCommand(
        {
          ...runtime,
          log: () => {},
        },
        { archive: result.archivePath, json: false },
      );
      result.verified = true;
    } catch (cause) {
      await fs.rm(result.archivePath, { force: true });
      throw new Error(
        `Backup archive failed validation after writing and was removed: ${result.archivePath}`,
        { cause },
      );
    }
  }
  const output = opts.json
    ? JSON.stringify(result, null, 2)
    : formatBackupCreateSummary(result).join("\n");
  runtime.log(output);
  return result;
}
