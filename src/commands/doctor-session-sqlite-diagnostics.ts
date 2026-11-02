import type { SessionStoreTarget } from "../config/sessions/targets.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  type ActiveSessionSqliteMigrationRun,
  canonicalMigrationFilePath,
} from "../infra/session-sqlite-migration-manifest.js";
import {
  countTranscriptEventsForPath,
  readOnlySqliteDbStats,
  resolveTargetSqlitePath,
  scanReadOnlySqliteActiveTranscriptFiles,
} from "../infra/session-sqlite-migration-readers.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db.js";
import { compactDoctorSessionSqliteTarget } from "./doctor-session-sqlite-compact.js";
import { resolveActiveSqliteTranscriptFile } from "./doctor-session-sqlite-transcript-file.js";
import type {
  DoctorSessionSqliteMode,
  DoctorSessionSqliteReport,
  DoctorSessionSqliteTargetReport,
} from "./doctor-session-sqlite-types.js";

export function countLegacyTranscript(
  record: { transcriptPath?: string; sessionKey: string },
  report: DoctorSessionSqliteTargetReport,
): void {
  const result = countTranscriptEventsForPath(record.transcriptPath);
  if (result.status !== "ok") {
    report.issues.push({
      code: result.status === "missing" ? "transcript_missing" : "transcript_malformed",
      message:
        result.status === "missing"
          ? `Transcript file is missing: ${record.transcriptPath}`
          : result.message,
      sessionKey: record.sessionKey,
    });
    return;
  }
  report.validatedEntries += 1;
  report.validatedTranscriptEvents += result.events;
}

export function appendRetainedPluginSessionSourceIssue(
  report: DoctorSessionSqliteTargetReport,
  pluginIds: readonly string[],
): void {
  const pending = pluginIds.length
    ? `remain pending for plugin(s): ${pluginIds.join(", ")}. Install the plugin and run openclaw doctor --fix to finish.`
    : "await archival. Run openclaw doctor --fix to finish.";
  report.issues.push({
    code: "plugin_migration_source_retained",
    message: `Session import is verified. Original session migration inputs, including unindexed history, ${pending}`,
  });
}

export function appendActiveSqliteTranscriptFileIssues(
  target: SessionStoreTarget,
  report: DoctorSessionSqliteTargetReport,
  retainedPaths?: ReadonlySet<string>,
): void {
  try {
    for (const { sessionKey, transcriptPath } of readActiveSqliteTranscriptFiles(target)) {
      if (!retainedPaths?.has(canonicalMigrationFilePath(transcriptPath))) {
        report.issues.push({
          code: "active_sqlite_transcript_jsonl",
          message: `SQLite-backed session has a legacy JSONL transcript awaiting verification: ${transcriptPath}. Run openclaw doctor --fix or openclaw doctor --session-sqlite recover with the Gateway stopped to verify, import any missing events, and archive the original.`,
          sessionKey,
        });
      }
    }
  } catch (error) {
    report.issues.push({
      code: "sqlite_active_transcript_scan_failed",
      message: `Could not scan SQLite-backed sessions for active JSONL transcript files: ${String(error)}`,
    });
  }
}

export function readActiveSqliteTranscriptFiles(target: SessionStoreTarget) {
  const sources: Array<{ sessionKey: string; sessionId: string; transcriptPath: string }> = [];
  const result = scanReadOnlySqliteActiveTranscriptFiles(
    target,
    (sessionKey, sessionId, sessionFile) => {
      const transcriptPath = resolveActiveSqliteTranscriptFile(target, {
        ...(sessionFile ? { sessionFile } : {}),
        sessionId,
      });
      if (transcriptPath) {
        sources.push({ sessionKey, sessionId, transcriptPath });
      }
    },
  );
  if (!result.ok) {
    throw result.error;
  }
  return sources;
}

export function appendSqliteDbStats(
  target: SessionStoreTarget,
  report: DoctorSessionSqliteTargetReport,
): void {
  const result = readOnlySqliteDbStats(target);
  if (!result.ok) {
    report.issues.push({
      code: "sqlite_corrupt",
      message: `SQLite database could not be inspected: ${String(result.error)}`,
    });
    return;
  }
  report.dbStats = result.stats;
  if (result.stats.integrityCheck && result.stats.integrityCheck !== "ok") {
    report.issues.push({
      code: "sqlite_integrity_check_failed",
      message: `SQLite quick_check reported: ${result.stats.integrityCheck}`,
    });
  }
}

export async function compactSqliteDatabase(
  target: SessionStoreTarget,
  report: DoctorSessionSqliteTargetReport,
  options: {
    env?: NodeJS.ProcessEnv;
    operation?: "import-finalize";
  } = {},
): Promise<void> {
  try {
    if (options.operation === "import-finalize") {
      await closeOpenClawAgentDatabaseByPathAsync(resolveTargetSqlitePath(target));
    }
    report.compact = await compactDoctorSessionSqliteTarget(target, options);
  } catch (err) {
    report.issues.push({
      code: "sqlite_compact_failed",
      message: `SQLite database compact failed: ${formatErrorMessage(err)}`,
    });
  }
}

export function summarizeDoctorSessionSqliteReport(
  mode: DoctorSessionSqliteMode,
  targets: DoctorSessionSqliteTargetReport[],
  activeRun?: ActiveSessionSqliteMigrationRun,
): DoctorSessionSqliteReport {
  const sum = (value: (target: DoctorSessionSqliteTargetReport) => number) =>
    targets.reduce((total, target) => total + value(target), 0);
  const archives = (paths: (target: DoctorSessionSqliteTargetReport) => string[]) =>
    new Set(targets.flatMap(paths)).size;
  const sqliteEntries = new Map<string, number>();
  for (const target of targets) {
    sqliteEntries.set(
      target.sqlitePath,
      Math.max(sqliteEntries.get(target.sqlitePath) ?? 0, target.sqliteEntries),
    );
  }
  const reportsArchival = mode !== "restore" && mode !== "recover";
  return {
    ...(activeRun
      ? {
          migrationRun: {
            ...(activeRun.manifest.failureReports
              ? {
                  failureReportJsonPath: activeRun.manifest.failureReports.jsonPath,
                  failureReportMarkdownPath: activeRun.manifest.failureReports.markdownPath,
                }
              : {}),
            manifestPath: activeRun.manifestPath,
            runId: activeRun.manifest.runId,
          },
        }
      : {}),
    mode,
    targets,
    totals: {
      ...(reportsArchival
        ? { archivedLegacyStoreFiles: archives((target) => target.archivedLegacyStoreFiles ?? []) }
        : {}),
      archivedTranscriptFiles: archives((target) => target.archivedTranscriptFiles),
      archivedUnreferencedJsonlFiles: archives((target) => target.archivedUnreferencedJsonlFiles),
      importedEntries: sum((target) => target.importedEntries),
      importedTranscriptEvents: sum((target) => target.importedTranscriptEvents),
      issues: sum((target) => target.issues.length),
      legacyEntries: sum((target) => target.legacyEntries),
      ...(reportsArchival
        ? { reclaimedBytes: sum((target) => target.compact?.reclaimedBytes ?? 0) }
        : {}),
      sqliteEntries: [...sqliteEntries.values()].reduce((total, count) => total + count, 0),
      targets: targets.length,
      unreferencedJsonlFiles: sum((target) => target.unreferencedJsonlFiles.length),
      validatedEntries: sum((target) => target.validatedEntries),
      validatedTranscriptEvents: sum((target) => target.validatedTranscriptEvents),
    },
  };
}
