import { normalizeOptionalString } from "../../../../packages/normalization-core/src/string-coerce.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  loadCronJobsStoreWithConfigJobs,
  resolveCronJobsStorePath,
  saveCronJobsStore,
  saveCronQuarantineFile,
} from "../../../cron/store.js";
import type { CronJob } from "../../../cron/types.js";
import { shortenHomePath } from "../../../utils.js";
import { migrateLegacyDreamingPayloadShape } from "./dreaming-payload-migration.js";
import { migrateLegacyNotifyFallback } from "./legacy-notify.js";
import {
  legacyCronRunLogFilesExist,
  migrateLegacyCronRunLogsToSqlite,
} from "./legacy-run-log-migration.js";
import {
  archiveLegacyCronStoreForMigration,
  legacyCronStoreFilesExist,
  loadLegacyCronStoreForMigration,
} from "./legacy-store-migration.js";
import { mergeLegacyCronJobs, mergeRuntimeEntryIntoConfigJob } from "./repair-plan.js";
import { normalizeStoredCronJobs } from "./store-migration.js";

export type CronAutoMigrationResult = {
  changes: string[];
  warnings: string[];
};

function pluralize(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatRunLogMigrationNote(importedFiles: number): string {
  return importedFiles > 0
    ? ` Imported ${pluralize(importedFiles, "legacy cron run log")} into SQLite.`
    : "";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function loadedCurrentCronJobs(
  loaded: Awaited<ReturnType<typeof loadCronJobsStoreWithConfigJobs>>,
): Array<Record<string, unknown>> {
  if (loaded.configJobs.length === 0) {
    return loaded.store.jobs as unknown as Array<Record<string, unknown>>;
  }
  return loaded.configJobs.map((job, index) =>
    mergeRuntimeEntryIntoConfigJob({
      job,
      runtimeEntry: loaded.configJobRuntimeEntries[index],
    }),
  );
}

export async function autoMigrateLegacyCronStore(params: {
  cfg: OpenClawConfig;
}): Promise<CronAutoMigrationResult> {
  const storePath = resolveCronJobsStorePath(params.cfg.cron?.store);
  const changes: string[] = [];
  const warnings: string[] = [];
  const legacyWebhook = normalizeOptionalString(params.cfg.cron?.webhook);

  let legacyStoreDetected: boolean;
  let legacyRunLogDetected: boolean;
  let rawJobs: Array<Record<string, unknown>>;
  try {
    legacyStoreDetected = await legacyCronStoreFilesExist(storePath);
    legacyRunLogDetected = await legacyCronRunLogFilesExist(storePath);
    if (!legacyStoreDetected && !legacyRunLogDetected) {
      return { changes, warnings };
    }

    const loaded = await loadCronJobsStoreWithConfigJobs(storePath);
    rawJobs = loadedCurrentCronJobs(loaded);
    if (legacyStoreDetected) {
      const legacyStore = (await loadLegacyCronStoreForMigration(storePath)).store;
      const merged = mergeLegacyCronJobs({
        currentJobs: rawJobs,
        legacyJobs: legacyStore.jobs as unknown as Array<Record<string, unknown>>,
      });
      rawJobs = merged.jobs;
    }
  } catch (err) {
    return {
      changes,
      warnings: [
        `Failed reading legacy cron storage at ${shortenHomePath(storePath)}: ${errorMessage(err)}`,
      ],
    };
  }

  const normalized = normalizeStoredCronJobs(rawJobs);
  const notifyMigration = migrateLegacyNotifyFallback({
    jobs: rawJobs,
    legacyWebhook,
  });
  const dreamingMigration = migrateLegacyDreamingPayloadShape(rawJobs);
  warnings.push(...notifyMigration.warnings);

  const changed =
    legacyStoreDetected ||
    legacyRunLogDetected ||
    normalized.mutated ||
    notifyMigration.changed ||
    dreamingMigration.changed;
  if (!changed && warnings.length === 0) {
    return { changes, warnings };
  }

  try {
    if (normalized.removedJobs.length > 0) {
      await saveCronQuarantineFile({
        storePath,
        nowMs: Date.now(),
        entries: normalized.removedJobs.map((entry) => ({
          sourceIndex: entry.sourceIndex,
          reason: entry.reason,
          job: entry.job,
        })),
      });
    }
    await saveCronJobsStore(storePath, {
      version: 1,
      jobs: rawJobs as unknown as CronJob[],
    });
  } catch (err) {
    return {
      changes,
      warnings: [
        ...warnings,
        `Failed writing migrated cron store at ${shortenHomePath(storePath)}: ${errorMessage(err)}`,
      ],
    };
  }

  let importedRunLogs = 0;
  if (legacyRunLogDetected) {
    try {
      importedRunLogs = (await migrateLegacyCronRunLogsToSqlite(storePath)).importedFiles;
    } catch (err) {
      warnings.push(
        `Failed importing legacy cron run logs at ${shortenHomePath(storePath)}: ${errorMessage(err)}`,
      );
    }
  }

  if (legacyStoreDetected) {
    await archiveLegacyCronStoreForMigration(storePath);
    changes.push(
      `Cron store migrated to SQLite at ${shortenHomePath(storePath)}.${formatRunLogMigrationNote(importedRunLogs)}`,
    );
  } else if (legacyRunLogDetected && importedRunLogs > 0) {
    changes.push(
      `Cron run logs migrated to SQLite at ${shortenHomePath(storePath)}.${formatRunLogMigrationNote(importedRunLogs)}`,
    );
  }
  if (dreamingMigration.rewrittenCount > 0) {
    changes.push(
      `Rewrote ${pluralize(dreamingMigration.rewrittenCount, "managed dreaming job")} to run as an isolated agent turn so dreaming no longer requires heartbeat.`,
    );
  }

  return { changes, warnings };
}
