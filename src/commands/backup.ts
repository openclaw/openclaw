// CLI command wrapper for backup archive creation and optional verification.
import {
  createBackupArchive,
  type BackupCreateOptions,
  type BackupCreateResult,
} from "../infra/backup-create.js";
import { formatErrorMessage } from "../infra/errors.js";
import { beginLifecycleWriteCustody } from "../infra/lifecycle-write-custody.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { createLazyPromise } from "../shared/lazy-promise.js";
import { recordBackupOutcomeBestEffort } from "./backup-shared.js";
import { formatBackupCreateSummary } from "./backup-summary.js";

const loadBackupVerifyRuntime = createLazyPromise(() => import("./backup-verify.js"));

/** Create a backup archive, optionally verify it, and emit text or JSON output. */
export async function backupCreateCommand(
  runtime: RuntimeEnv,
  opts: BackupCreateOptions = {},
): Promise<BackupCreateResult> {
  let archivePath = opts.output ?? process.cwd();
  const releaseCustody = opts.dryRun ? undefined : beginLifecycleWriteCustody("backup");
  let failure: unknown;
  try {
    const result = await withCommandProcessScope(() =>
      createBackupArchive({
        ...opts,
        log: opts.log ?? (opts.json ? undefined : (message: string) => runtime.log(message)),
      }),
    );
    archivePath = result.archivePath;
    if (opts.verify && !opts.dryRun) {
      const { backupVerifyCommand } = await loadBackupVerifyRuntime();
      await backupVerifyCommand(
        {
          ...runtime,
          log: () => {},
        },
        { archive: result.archivePath, json: false },
      );
      result.verified = true;
    }
    if (!opts.dryRun) {
      await recordBackupOutcomeBestEffort(runtime, {
        kind: "archive",
        archivePath,
        status: "ok",
      });
    }
    if (opts.json) {
      writeRuntimeJson(runtime, result);
    } else {
      runtime.log(formatBackupCreateSummary(result).join("\n"));
    }
    return result;
  } catch (error) {
    failure = error;
    if (!opts.dryRun) {
      await recordBackupOutcomeBestEffort(runtime, {
        kind: "archive",
        archivePath,
        status: "failed",
        error: formatErrorMessage(error),
      });
    }
    throw error;
  } finally {
    releaseCustody?.(failure);
  }
}
