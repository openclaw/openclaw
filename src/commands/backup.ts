import { createBackupArchive, type BackupCreateOptions } from "../infra/backup-create.js";
import { resolveBackupNamespace, type BackupRetentionOptions } from "../infra/backup-retention.js";
import { formatErrorMessage } from "../infra/errors.js";
import { beginLifecycleWriteCustody } from "../infra/lifecycle-write-custody.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { createLazyPromise } from "../shared/lazy-promise.js";
import type { OffsiteBackupResult } from "./backup-remote.js";
import { recordBackupOutcomeBestEffort } from "./backup-shared.js";
import { formatBackupCreateSummary } from "./backup-summary.js";

const loadBackupVerifyRuntime = createLazyPromise(() => import("./backup-verify.js"));
const loadBackupRemoteRuntime = createLazyPromise(() => import("./backup-remote.js"));

export type BackupCommandCreateOptions = BackupCreateOptions &
  BackupRetentionOptions & {
    to?: string;
    namespace?: string;
    claimNamespace?: boolean;
  };

/** Create a backup archive, optionally verify it, and emit text or JSON output. */
export async function backupCreateCommand(
  runtime: RuntimeEnv,
  opts: BackupCommandCreateOptions = {},
): Promise<OffsiteBackupResult> {
  if (
    opts.to === undefined &&
    [opts.namespace, opts.claimNamespace, opts.keepDaily, opts.keepWeekly, opts.keepMonthly].some(
      (value) => value !== undefined,
    )
  ) {
    throw new Error("--namespace, --claim-namespace, and retention flags require --to <location>.");
  }
  let archivePath = opts.output ?? (opts.to === undefined ? process.cwd() : `storage://${opts.to}`);
  const releaseCustody = opts.dryRun ? undefined : beginLifecycleWriteCustody("backup");
  let failure: unknown;
  let namespace = opts.namespace;
  try {
    if (opts.to !== undefined) {
      namespace = resolveBackupNamespace(opts.namespace);
    }
    const result: OffsiteBackupResult = await withCommandProcessScope(async () => {
      const options = {
        ...opts,
        log: opts.log ?? (opts.json ? undefined : (message: string) => runtime.log(message)),
      };
      if (opts.to !== undefined) {
        const { createOffsiteBackupArchive } = await loadBackupRemoteRuntime();
        return await createOffsiteBackupArchive({ ...options, to: opts.to, namespace });
      }
      return await createBackupArchive(options);
    });
    archivePath = result.archivePath;
    if (opts.verify && !opts.dryRun && !result.verified) {
      const { verifyBackupArchive } = await loadBackupVerifyRuntime();
      await verifyBackupArchive(result.archivePath);
      result.verified = true;
    }
    if (!opts.dryRun) {
      await recordBackupOutcomeBestEffort(runtime, {
        kind: "archive",
        archivePath,
        status: "ok",
        ...(opts.to !== undefined
          ? {
              target: opts.to,
              namespace,
              location: result.location,
              retention: result.retention,
              bytes: result.location?.plaintextBytes,
            }
          : {}),
      });
    }
    if (opts.json) {
      writeRuntimeJson(runtime, result);
    } else {
      runtime.log(formatBackupCreateSummary(result).join("\n"));
      if (result.location) {
        runtime.log(
          `Uploaded to ${result.location.name}/backups/${result.location.namespace}/${result.location.key} (${result.location.storedBytes} stored bytes).${result.localArchiveRetained ? " Local archive retained." : ""}`,
        );
      }
      if (result.retention) {
        runtime.log(
          `Retention: ${result.retention.kept} kept, ${result.retention.deleted} deleted.`,
        );
      }
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
        ...(opts.to !== undefined ? { target: opts.to, namespace } : {}),
      });
    }
    throw error;
  } finally {
    releaseCustody?.(failure);
  }
}
