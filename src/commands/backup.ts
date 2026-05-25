import {
  createBackupArchive,
  formatBackupCreateSummary,
  type BackupCreateOptions,
  type BackupCreateResult,
} from "../infra/backup-create.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
export type { BackupCreateOptions, BackupCreateResult } from "../infra/backup-create.js";

type BackupVerifyRuntime = typeof import("./backup-verify.js");

const backupVerifyRuntimeLoader = createLazyImportLoader<BackupVerifyRuntime>(
  () => import("./backup-verify.js"),
);

function loadBackupVerifyRuntime(): Promise<BackupVerifyRuntime> {
  return backupVerifyRuntimeLoader.load();
}

export async function backupCreateCommand(
  runtime: RuntimeEnv,
  opts: BackupCreateOptions = {},
): Promise<BackupCreateResult> {
  // CLI-level signal cleanup: removes temp files on graceful interruption
  // and exits with the expected Unix signal exit codes.
  let signalCleanup: (() => void) | null = null;
  const onSignal = () => {
    signalCleanup?.();
    process.exit(0);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const result = await createBackupArchive({
      ...opts,
      log: opts.log ?? (opts.json ? undefined : (message: string) => runtime.log(message)),
      onCleanup: (handler) => { signalCleanup = handler; },
    });
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
    if (opts.json) {
      writeRuntimeJson(runtime, result);
    } else {
      runtime.log(formatBackupCreateSummary(result).join("\n"));
    }
    return result;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
