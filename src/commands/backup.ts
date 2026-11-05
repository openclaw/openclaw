import { terminalText } from "../../packages/terminal-core/src/safe-text.js";
import { registerSignalExitGate } from "../cli/signal-exit-barrier.js";
import { createBackupArchive, type BackupCreateOptions } from "../infra/backup-create.js";
import { resolveBackupNamespace, type BackupRetentionOptions } from "../infra/backup-retention.js";
import { formatErrorMessage } from "../infra/errors.js";
import { beginLifecycleWriteCustody } from "../infra/lifecycle-write-custody.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { OffsiteBackupResult } from "./backup-remote.js";
import { recordBackupOutcomeBestEffort } from "./backup-shared.js";

export type BackupCommandCreateOptions = BackupCreateOptions &
  BackupRetentionOptions & {
    to?: string;
    namespace?: string;
    claimNamespace?: boolean;
  };

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
  const finished = createDeferredCore();
  let stopArchive: (() => void) | undefined;
  // In-process tar/gzip must stop and join before CLI shutdown releases custody.
  const releaseExitGate = registerSignalExitGate(finished.promise, () => stopArchive?.());
  let failure: unknown;
  let namespace = opts.namespace;
  try {
    if (opts.to !== undefined) {
      namespace = resolveBackupNamespace(opts.namespace);
    }
    const result: OffsiteBackupResult = await withCommandProcessScope(async (stop) => {
      stopArchive = stop;
      const options = {
        ...opts,
        log:
          opts.log ??
          (opts.json ? undefined : (message: string) => runtime.log(terminalText`${message}`)),
      };
      if (opts.to !== undefined) {
        const { createOffsiteBackupArchive } = await import("./backup-remote.js");
        return await createOffsiteBackupArchive({ ...options, to: opts.to, namespace });
      }
      return await createBackupArchive(options);
    });
    archivePath = result.archivePath;
    if (opts.verify && !opts.dryRun && !result.verified) {
      const { verifyBackupArchive } = await import("./backup-verify.js");
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
      const lines = [terminalText`Backup archive: ${result.archivePath}`];
      lines.push(
        terminalText`Included ${result.assets.length} path${result.assets.length === 1 ? "" : "s"}:`,
      );
      for (const asset of result.assets) {
        lines.push(terminalText`- ${asset.kind}: ${asset.displayPath}`);
      }
      if (result.skipped.length > 0) {
        lines.push(
          terminalText`Skipped ${result.skipped.length} path${result.skipped.length === 1 ? "" : "s"}:`,
        );
        for (const entry of result.skipped) {
          const coverage =
            entry.reason === "covered" && entry.coveredBy ? ` by ${entry.coveredBy}` : "";
          lines.push(
            terminalText`- ${entry.kind}: ${entry.displayPath} (${entry.reason}${coverage})`,
          );
        }
      }
      for (const link of result.externalSymbolicLinks ?? []) {
        lines.push(
          terminalText`External link preserved (target not copied through link): ${JSON.stringify(link.entryPath)} -> ${JSON.stringify(link.linkpath)}`,
        );
      }
      if (result.dryRun) {
        lines.push("Dry run only; archive was not written.");
      } else {
        lines.push(terminalText`Created ${result.archivePath}`);
        if (result.skippedVolatileCount > 0) {
          lines.push(
            terminalText`Skipped ${result.skippedVolatileCount} volatile file${
              result.skippedVolatileCount === 1 ? "" : "s"
            } (live sessions, cron logs, queues, managed runtime paths, sockets, pid/tmp).`,
          );
        }
        if (result.verified) {
          lines.push("Archive verification: passed");
        }
      }
      lines.push(...(result.warnings ?? []).map((warning) => terminalText`${warning}`));
      runtime.log(lines.join("\n"));
      if (result.location) {
        runtime.log(
          terminalText`Uploaded to ${result.location.name}/backups/${result.location.namespace}/${result.location.key} (${result.location.storedBytes} stored bytes).${result.localArchiveRetained ? " Local archive retained." : ""}`,
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
    finished.resolve();
    releaseExitGate();
  }
}
