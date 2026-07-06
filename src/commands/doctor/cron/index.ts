// Doctor cron repair orchestration for legacy stores, run logs, payloads, and warnings.
import { normalizeOptionalString } from "../../../../packages/normalization-core/src/string-coerce.js";
import { note } from "../../../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../../../cli/command-format.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  loadCronQuarantineFile,
  loadCronJobsStoreWithConfigJobs,
  loadCronJobsStoreWithConfigJobsReadOnly,
  resolveCronQuarantinePath,
  resolveCronJobsStorePath,
  saveCronQuarantineFile,
  saveCronJobsStore,
  saveCronJobsStoreWithMetadata,
} from "../../../cron/store.js";
import type { CronJob } from "../../../cron/types.js";
import type { HealthFinding } from "../../../flows/health-checks.js";
import { shortenHomePath } from "../../../utils.js";
import type { DoctorPrompter, DoctorOptions } from "../../doctor-prompter.js";
import {
  countStaleDreamingJobs,
  migrateLegacyDreamingPayloadShape,
} from "./dreaming-payload-migration.js";
import { migrateLegacyNotifyFallback } from "./legacy-notify.js";
import {
  legacyCronRunLogFilesExist,
  migrateLegacyCronRunLogsToSqlite,
} from "./legacy-run-log-migration.js";
import {
  archiveLegacyCronStoreForMigration,
  assertLegacyCronMigrationSourceCurrent,
  legacyCronStoreFilesExist,
  loadLegacyCronStoreForMigration,
  type LegacyCronMigrationSource,
} from "./legacy-store-migration.js";
import {
  acquireLegacyCronMigrationReceipt,
  hasLegacyCronMigrationReceipt,
  hasLegacyCronMigrationReceiptReadOnly,
  markLegacyCronMigrationSourceRemoved,
} from "./migration-ledger.js";
import {
  formatLegacyIssuePreview,
  formatUnresolvedCommandPromptAdvisory,
  formatUnresolvedShellPromptAdvisory,
  mergeLegacyCronJobs,
  mergeRuntimeEntryIntoConfigJob,
  needsSqliteProjectionBackfill,
} from "./repair-plan.js";
import { normalizeStoredCronJobs } from "./store-migration.js";
import { noteCronModelOverrides } from "./warnings.js";

export {
  collectLegacyWhatsAppCrontabHealthWarning,
  noteLegacyWhatsAppCrontabHealthCheck,
} from "./warnings.js";

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

// Count jobs the store still marks in-flight (`state.runningAtMs` is a number).
// The scheduler sets this while a run is active and clears it on completion, so a
// leftover marker (gateway killed mid-run) makes `cron list` show the job as
// `running` while nothing executes it. Startup marks exactly these runs interrupted
// (`src/cron/service/ops.ts` `start`), so doctor only reports the count here.
function countInFlightCronJobs(jobs: Array<Record<string, unknown>>): number {
  return jobs.filter((job) => {
    const state = job.state;
    return (
      typeof state === "object" &&
      state !== null &&
      typeof (state as { runningAtMs?: unknown }).runningAtMs === "number"
    );
  }).length;
}

type LegacyCronRepairState = {
  storePath: string;
  quarantinePath: string;
  legacyStoreDetected: boolean;
  legacyRunLogDetected: boolean;
  legacyMigrationSource?: LegacyCronMigrationSource;
  legacyMigrationAlreadyImported: boolean;
  legacyImportCount: number;
  sqliteProjectionBackfillCount: number;
  rawJobs: Array<Record<string, unknown>>;
};

export type LegacyCronRepairResult = {
  changes: string[];
  warnings: string[];
};

const LEGACY_CRON_STORE_CHECK_ID = "core/doctor/legacy-cron-store";

function legacyCronStoreFinding(params: {
  readonly message: string;
  readonly path: string;
  readonly requirement: string;
  readonly fixHint?: string;
}): HealthFinding {
  return {
    checkId: LEGACY_CRON_STORE_CHECK_ID,
    severity: "warning",
    message: params.message,
    path: params.path,
    requirement: params.requirement,
    fixHint:
      params.fixHint ??
      `Run ${formatCliCommand("openclaw doctor --fix")} to normalize legacy cron storage.`,
  };
}

async function loadLegacyCronRepairState(params: {
  cfg: OpenClawConfig;
  onlyIfLegacyDetected?: boolean;
  readOnly?: boolean;
}): Promise<LegacyCronRepairState | null> {
  const storePath = resolveCronJobsStorePath(params.cfg.cron?.store);
  const quarantinePath = resolveCronQuarantinePath(storePath);
  const legacyStoreDetected = await legacyCronStoreFilesExist(storePath);
  const legacyRunLogDetected = await legacyCronRunLogFilesExist(storePath);
  if (params.onlyIfLegacyDetected && !legacyStoreDetected && !legacyRunLogDetected) {
    return null;
  }

  const loaded = params.readOnly
    ? await loadCronJobsStoreWithConfigJobsReadOnly(storePath)
    : await loadCronJobsStoreWithConfigJobs(storePath);
  const currentJobs =
    loaded.configJobs.length > 0
      ? loaded.configJobs.map((job, index) =>
          mergeRuntimeEntryIntoConfigJob({
            job,
            runtimeEntry: loaded.configJobRuntimeEntries[index],
          }),
        )
      : (loaded.store.jobs as unknown as Array<Record<string, unknown>>);
  const sqliteProjectionBackfillCount =
    loaded.configJobs.length > 0
      ? currentJobs.filter((job, index) =>
          needsSqliteProjectionBackfill({
            configJob: job,
            projectedJob: loaded.store.jobs[index],
          }),
        ).length
      : 0;
  let rawJobs = currentJobs;
  let legacyImportCount = 0;
  let legacyMigrationSource: LegacyCronMigrationSource | undefined;
  let legacyMigrationAlreadyImported = false;
  if (legacyStoreDetected) {
    const loadedLegacy = await loadLegacyCronStoreForMigration(storePath);
    legacyMigrationSource = loadedLegacy.migrationSource;
    legacyMigrationAlreadyImported = legacyMigrationSource
      ? params.readOnly
        ? hasLegacyCronMigrationReceiptReadOnly(legacyMigrationSource)
        : hasLegacyCronMigrationReceipt(legacyMigrationSource)
      : false;
    if (!legacyMigrationAlreadyImported) {
      const merged = mergeLegacyCronJobs({
        currentJobs: rawJobs,
        legacyJobs: loadedLegacy.store.jobs as unknown as Array<Record<string, unknown>>,
      });
      rawJobs = merged.jobs;
      legacyImportCount = merged.importedCount;
    }
  }

  return {
    storePath,
    quarantinePath,
    legacyStoreDetected,
    legacyRunLogDetected,
    legacyMigrationSource,
    legacyMigrationAlreadyImported,
    legacyImportCount,
    sqliteProjectionBackfillCount,
    rawJobs,
  };
}

async function applyLegacyCronStoreRepair(params: {
  cfg: OpenClawConfig;
  state: LegacyCronRepairState;
  normalized?: ReturnType<typeof normalizeStoredCronJobs>;
}): Promise<LegacyCronRepairResult> {
  const { state } = params;
  const changes: string[] = [];
  const warnings: string[] = [];
  const normalized = params.normalized ?? normalizeStoredCronJobs(state.rawJobs);
  const legacyWebhook = normalizeOptionalString(params.cfg.cron?.webhook);
  const notifyMigration = migrateLegacyNotifyFallback({
    jobs: state.rawJobs,
    legacyWebhook,
  });
  const dreamingMigration = migrateLegacyDreamingPayloadShape(state.rawJobs);
  warnings.push(...notifyMigration.warnings);

  const storeChanged =
    (state.legacyStoreDetected && !state.legacyMigrationAlreadyImported) ||
    state.sqliteProjectionBackfillCount > 0 ||
    normalized.mutated ||
    notifyMigration.changed ||
    dreamingMigration.changed;
  const changed = state.legacyStoreDetected || state.legacyRunLogDetected || storeChanged;
  if (!changed && warnings.length === 0) {
    return { changes, warnings };
  }

  if (storeChanged) {
    try {
      if (normalized.removedJobs.length > 0) {
        await saveCronQuarantineFile({
          storePath: state.storePath,
          nowMs: Date.now(),
          entries: normalized.removedJobs.map((entry) => ({
            sourceIndex: entry.sourceIndex,
            reason: entry.reason,
            job: entry.job,
          })),
        });
      }
      const store = {
        version: 1,
        jobs: state.rawJobs as unknown as CronJob[],
      } as const;
      const migrationSource = state.legacyMigrationSource;
      if (migrationSource && !state.legacyMigrationAlreadyImported) {
        await assertLegacyCronMigrationSourceCurrent(migrationSource);
        await saveCronJobsStoreWithMetadata(state.storePath, store, (db) => {
          return acquireLegacyCronMigrationReceipt(db, migrationSource);
        });
      } else {
        await saveCronJobsStore(state.storePath, store);
      }
    } catch (err) {
      return {
        changes,
        warnings: [
          ...warnings,
          `Failed writing migrated cron store at ${shortenHomePath(state.storePath)}: ${errorMessage(err)}`,
        ],
      };
    }
  }

  let importedRunLogs = 0;
  if (state.legacyRunLogDetected) {
    try {
      importedRunLogs = (await migrateLegacyCronRunLogsToSqlite(state.storePath)).importedFiles;
    } catch (err) {
      warnings.push(
        `Failed importing legacy cron run logs at ${shortenHomePath(state.storePath)}: ${errorMessage(err)}`,
      );
    }
  }

  if (state.legacyStoreDetected) {
    const archiveResult = await archiveLegacyCronStoreForMigration(
      state.storePath,
      state.legacyMigrationSource,
    );
    if (archiveResult.ok) {
      if (state.legacyMigrationSource) {
        try {
          markLegacyCronMigrationSourceRemoved(state.legacyMigrationSource);
        } catch (err) {
          warnings.push(
            `Cron store was archived, but its migration receipt could not be finalized: ${errorMessage(err)}`,
          );
        }
      }
      changes.push(
        `Cron store migrated to SQLite at ${shortenHomePath(state.storePath)}.${formatRunLogMigrationNote(importedRunLogs)}`,
      );
    } else {
      // SQLite already holds the migrated jobs, but the legacy file could not be
      // archived (e.g. EXDEV copy+unlink failed), so report it honestly instead of
      // claiming a finished migration; doctor re-detects the leftover and retries.
      for (const failure of archiveResult.failures) {
        warnings.push(
          `Migrated cron jobs to SQLite but could not archive the legacy cron file at ${shortenHomePath(failure.path)}: ${failure.reason}. Remove it manually or rerun ${formatCliCommand("openclaw doctor --fix")} to retry.`,
        );
      }
    }
  } else if (state.legacyRunLogDetected && importedRunLogs > 0) {
    changes.push(
      `Cron run logs migrated to SQLite at ${shortenHomePath(state.storePath)}.${formatRunLogMigrationNote(importedRunLogs)}`,
    );
  } else if (storeChanged) {
    changes.push(`Cron store normalized at ${shortenHomePath(state.storePath)}.`);
  }
  if (dreamingMigration.rewrittenCount > 0) {
    changes.push(
      `Rewrote ${pluralize(dreamingMigration.rewrittenCount, "managed dreaming job")} to run as an isolated agent turn so dreaming no longer requires heartbeat.`,
    );
  }

  return { changes, warnings };
}

export async function collectLegacyCronStoreHealthFindings(params: {
  cfg: OpenClawConfig;
}): Promise<readonly HealthFinding[]> {
  let state: LegacyCronRepairState | null;
  try {
    state = await loadLegacyCronRepairState({ cfg: params.cfg, readOnly: true });
  } catch (err) {
    const storePath = resolveCronJobsStorePath(params.cfg.cron?.store);
    return [
      legacyCronStoreFinding({
        message: `Unable to read cron job store at ${shortenHomePath(storePath)}.`,
        path: storePath,
        requirement: "cron-store-readable",
        fixHint: [
          `Fix the file's permissions or contents and re-run ${formatCliCommand("openclaw doctor")}.`,
          "Later health checks will continue.",
          `Details: ${errorMessage(err)}`,
        ].join(" "),
      }),
    ];
  }
  if (!state) {
    return [];
  }

  const findings: HealthFinding[] = [];
  const {
    storePath,
    quarantinePath,
    legacyStoreDetected,
    legacyRunLogDetected,
    legacyImportCount,
    sqliteProjectionBackfillCount,
    rawJobs,
  } = state;

  try {
    const quarantine = await loadCronQuarantineFile(quarantinePath);
    if (quarantine.jobs.length > 0) {
      findings.push(
        legacyCronStoreFinding({
          message: `${pluralize(quarantine.jobs.length, "quarantined cron job row")} found at ${shortenHomePath(quarantinePath)}.`,
          path: quarantinePath,
          requirement: "quarantined-cron-rows",
          fixHint: `Review or repair the quarantined rows manually before copying any job back into ${shortenHomePath(storePath)}.`,
        }),
      );
    }
  } catch (err) {
    findings.push(
      legacyCronStoreFinding({
        message: `Unable to read quarantined cron rows at ${shortenHomePath(quarantinePath)}.`,
        path: quarantinePath,
        requirement: "cron-quarantine-readable",
        fixHint: `Fix the quarantine file's permissions or contents. Details: ${errorMessage(err)}`,
      }),
    );
  }

  if (legacyStoreDetected) {
    findings.push(
      legacyCronStoreFinding({
        message:
          legacyImportCount > 0
            ? `${pluralize(legacyImportCount, "legacy JSON cron job")} will be imported into SQLite.`
            : `Legacy JSON cron store was found at ${shortenHomePath(storePath)}.`,
        path: storePath,
        requirement: "legacy-cron-store",
      }),
    );
  }
  if (legacyRunLogDetected) {
    findings.push(
      legacyCronStoreFinding({
        message: `Legacy JSON cron run logs will be imported into SQLite for ${shortenHomePath(storePath)}.`,
        path: storePath,
        requirement: "legacy-cron-run-logs",
      }),
    );
  }

  if (rawJobs.length === 0) {
    return findings;
  }

  const normalized = normalizeStoredCronJobs(rawJobs);
  for (const line of formatLegacyIssuePreview(normalized.issues)) {
    findings.push(
      legacyCronStoreFinding({
        message: line.replace(/^- /u, ""),
        path: storePath,
        requirement: "legacy-cron-store-shape",
      }),
    );
  }

  if (sqliteProjectionBackfillCount > 0) {
    findings.push(
      legacyCronStoreFinding({
        message: `${pluralize(sqliteProjectionBackfillCount, "SQLite cron row")} will be backfilled from stored config JSON into split columns.`,
        path: storePath,
        requirement: "sqlite-projection-backfill",
      }),
    );
  }

  const notifyCount = rawJobs.filter((job) => job.notify === true).length;
  if (notifyCount > 0) {
    findings.push(
      legacyCronStoreFinding({
        message: `${pluralize(notifyCount, "job")} still uses legacy notify webhook fallback.`,
        path: storePath,
        requirement: "legacy-notify-fallback",
      }),
    );
  }

  const dreamingStaleCount = countStaleDreamingJobs(rawJobs);
  if (dreamingStaleCount > 0) {
    findings.push(
      legacyCronStoreFinding({
        message: `${pluralize(dreamingStaleCount, "managed dreaming job")} still has the legacy heartbeat-coupled shape.`,
        path: storePath,
        requirement: "legacy-dreaming-payload",
      }),
    );
  }

  return findings;
}

export async function repairLegacyCronStoreWithoutPrompt(params: {
  cfg: OpenClawConfig;
}): Promise<LegacyCronRepairResult> {
  const storePath = resolveCronJobsStorePath(normalizeOptionalString(params.cfg.cron?.store));
  let state: LegacyCronRepairState | null;
  try {
    state = await loadLegacyCronRepairState({
      cfg: params.cfg,
      onlyIfLegacyDetected: true,
    });
  } catch (err) {
    return {
      changes: [],
      warnings: [
        `Failed reading legacy cron storage at ${shortenHomePath(storePath)}: ${errorMessage(err)}`,
      ],
    };
  }
  if (!state) {
    return { changes: [], warnings: [] };
  }
  return await applyLegacyCronStoreRepair({ cfg: params.cfg, state });
}

function noteLegacyCronRepairResult(result: LegacyCronRepairResult): void {
  if (result.changes.length > 0) {
    note(result.changes.join("\n"), "Doctor changes");
  }
  if (result.warnings.length > 0) {
    note(result.warnings.join("\n"), "Doctor warnings");
  }
}

/** Inspect cron storage and optionally repair legacy JSON/SQLite/payload shapes. */
export async function maybeRepairLegacyCronStore(params: {
  cfg: OpenClawConfig;
  options: DoctorOptions;
  prompter: Pick<DoctorPrompter, "confirm">;
}) {
  let state: LegacyCronRepairState | null;
  try {
    state = await loadLegacyCronRepairState({ cfg: params.cfg });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const storePath = resolveCronJobsStorePath(params.cfg.cron?.store);
    note(
      [
        `Unable to read cron job store at ${shortenHomePath(storePath)}.`,
        `- ${reason}`,
        `Fix the file's permissions or contents and re-run ${formatCliCommand("openclaw doctor")}; later health checks will continue.`,
      ].join("\n"),
      "Cron",
    );
    return;
  }
  if (!state) {
    return;
  }
  const {
    storePath,
    quarantinePath,
    legacyStoreDetected,
    legacyRunLogDetected,
    legacyImportCount,
    sqliteProjectionBackfillCount,
    rawJobs,
  } = state;
  try {
    const quarantine = await loadCronQuarantineFile(quarantinePath);
    if (quarantine.jobs.length > 0) {
      note(
        [
          `Quarantined cron job rows found at ${shortenHomePath(quarantinePath)}.`,
          `- ${pluralize(quarantine.jobs.length, "row")} was removed from the active cron store after runtime validation failed.`,
          `- Review or repair the quarantined rows manually before copying any job back into ${shortenHomePath(storePath)}.`,
        ].join("\n"),
        "Cron",
      );
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    note(
      [
        `Unable to read quarantined cron rows at ${shortenHomePath(quarantinePath)}.`,
        `- ${reason}`,
      ].join("\n"),
      "Cron",
    );
  }
  if (rawJobs.length === 0) {
    if (!legacyStoreDetected && !legacyRunLogDetected) {
      return;
    }
    const previewLines: string[] = [];
    if (legacyStoreDetected) {
      previewLines.push("- legacy JSON cron store will be archived after SQLite migration");
    }
    if (legacyRunLogDetected) {
      previewLines.push("- legacy JSON cron run logs will be imported into SQLite");
    }
    note(
      [
        `Legacy cron storage detected at ${shortenHomePath(storePath)}.`,
        ...previewLines,
        `Repair with ${formatCliCommand("openclaw doctor --fix")} to finish the migration.`,
      ].join("\n"),
      "Cron",
    );
    const shouldRepair = await params.prompter.confirm({
      message: "Repair legacy cron jobs now?",
      initialValue: true,
    });
    if (!shouldRepair) {
      return;
    }
    noteLegacyCronRepairResult(await applyLegacyCronStoreRepair({ cfg: params.cfg, state }));
    return;
  }
  noteCronModelOverrides({ cfg: params.cfg, jobs: rawJobs, storePath });

  const inFlightCount = countInFlightCronJobs(rawJobs);
  if (inFlightCount > 0) {
    const subject = inFlightCount === 1 ? "it" : "them";
    note(
      [
        `${pluralize(inFlightCount, "cron job")} ${inFlightCount === 1 ? "is" : "are"} still marked in-flight (\`state.runningAtMs\` is set), so ${formatCliCommand("openclaw cron list")} shows ${subject} as \`running\`.`,
        `- If no gateway is currently executing ${subject}, the marker is left over from an interrupted run; the gateway marks such runs interrupted the next time it starts.`,
        `- Review with ${formatCliCommand("openclaw cron list")} or ${formatCliCommand("openclaw cron show <id>")}.`,
      ].join("\n"),
      "Cron",
    );
  }

  const normalized = normalizeStoredCronJobs(rawJobs);
  const notifyCount = rawJobs.filter((job) => job.notify === true).length;
  const dreamingStaleCount = countStaleDreamingJobs(rawJobs);
  // Unresolved agentTurn command prompts are not auto-fixable; keep them out of the
  // --fix preview so the repair note does not promise a fix that never lands (#94655).
  const commandPromptAdvisory = formatUnresolvedCommandPromptAdvisory(
    normalized.unresolvedAgentTurnCommandPromptJobs,
  );
  if (commandPromptAdvisory) {
    note(commandPromptAdvisory, "Cron");
  }
  const shellPromptAdvisory = formatUnresolvedShellPromptAdvisory(
    normalized.unresolvedAgentTurnShellToolPromptJobs,
  );
  if (shellPromptAdvisory) {
    note(shellPromptAdvisory, "Cron");
  }
  const previewLines = formatLegacyIssuePreview(normalized.issues);
  if (legacyStoreDetected) {
    previewLines.unshift(
      legacyImportCount > 0
        ? `- ${pluralize(legacyImportCount, "legacy JSON cron job")} will be imported into SQLite`
        : "- legacy JSON cron store will be archived after SQLite migration",
    );
  }
  if (legacyRunLogDetected) {
    previewLines.push("- legacy JSON cron run logs will be imported into SQLite");
  }
  if (sqliteProjectionBackfillCount > 0) {
    previewLines.push(
      `- ${pluralize(sqliteProjectionBackfillCount, "SQLite cron row")} will be backfilled from stored config JSON into split columns`,
    );
  }
  if (notifyCount > 0) {
    previewLines.push(
      `- ${pluralize(notifyCount, "job")} still uses legacy \`notify: true\` webhook fallback`,
    );
  }
  if (dreamingStaleCount > 0) {
    previewLines.push(
      `- ${pluralize(dreamingStaleCount, "managed dreaming job")} still has the legacy heartbeat-coupled shape`,
    );
  }
  if (previewLines.length === 0 && !legacyStoreDetected) {
    return;
  }

  const noteHeading = legacyStoreDetected
    ? `Legacy cron job storage detected at ${shortenHomePath(storePath)}.`
    : `Cron store issues detected at ${shortenHomePath(storePath)}.`;

  note(
    [
      noteHeading,
      ...previewLines,
      `Repair with ${formatCliCommand("openclaw doctor --fix")} to normalize the store before the next scheduler run.`,
    ].join("\n"),
    "Cron",
  );

  const shouldRepair = await params.prompter.confirm({
    message: "Repair legacy cron jobs now?",
    initialValue: true,
  });
  if (!shouldRepair) {
    return;
  }

  noteLegacyCronRepairResult(
    await applyLegacyCronStoreRepair({ cfg: params.cfg, state, normalized }),
  );
}
