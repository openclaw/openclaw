import fs from "node:fs";
import path from "node:path";
import { resolveSessionFilePathCore } from "../config/sessions/paths.js";
import type { SessionStoreTarget } from "../config/sessions/targets.js";
import { resolveRealpathOrAbsolute as canonicalFilePath } from "../infra/boundary-path.js";
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
import { closeOpenClawAgentDatabaseByPath } from "../state/openclaw-agent-db.js";
import { compactDoctorSessionSqliteTarget } from "./doctor-session-sqlite-compact.js";
import {
  createDoctorSessionSqliteTotals,
  sumDoctorSessionSqliteTargets,
  type DoctorSessionSqliteMode,
  type DoctorSessionSqliteReport,
  type DoctorSessionSqliteTargetReport,
} from "./doctor-session-sqlite-types.js";

export function countLegacyTranscript(
  record: { transcriptPath?: string; sessionKey: string },
  report: DoctorSessionSqliteTargetReport,
): void {
  const result = countTranscriptEventsForPath(record.transcriptPath);
  if (result.status === "missing") {
    report.issues.push({
      code: "transcript_missing",
      message: `Transcript file is missing: ${record.transcriptPath}`,
      sessionKey: record.sessionKey,
    });
    return;
  }
  if (result.status === "malformed") {
    report.issues.push({
      code: "transcript_malformed",
      message: result.message,
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
    message: `Canonical session import is verified. Original session migration inputs, including unindexed history, ${pending}`,
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
      closeOpenClawAgentDatabaseByPath(resolveTargetSqlitePath(target));
    }
    report.compact = await compactDoctorSessionSqliteTarget(target, options);
  } catch (err) {
    report.issues.push({
      code: "sqlite_compact_failed",
      message: `SQLite database compact failed: ${formatErrorMessage(err)}`,
    });
  }
}

function resolveActiveSqliteTranscriptFile(
  target: SessionStoreTarget,
  entry: { sessionFile?: string; sessionId: string },
): string | undefined {
  let transcriptPath: string;
  try {
    transcriptPath = resolveSessionFilePathCore(entry.sessionId, entry, {
      agentId: target.agentId,
      sessionsDir: path.dirname(target.storePath),
    });
  } catch {
    return undefined;
  }
  if (!transcriptPath.endsWith(".jsonl")) {
    return undefined;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) {
    return undefined;
  }
  const sessionsDir = canonicalFilePath(path.dirname(target.storePath));
  const activePath = canonicalFilePath(transcriptPath);
  if (path.dirname(activePath) !== sessionsDir) {
    return undefined;
  }
  return activePath;
}

export function summarizeDoctorSessionSqliteReport(
  mode: DoctorSessionSqliteMode,
  targets: DoctorSessionSqliteTargetReport[],
  activeRun?: ActiveSessionSqliteMigrationRun,
): DoctorSessionSqliteReport {
  const sum = (value: (target: DoctorSessionSqliteTargetReport) => number) =>
    sumDoctorSessionSqliteTargets(targets, value);
  const archives = (paths: (target: DoctorSessionSqliteTargetReport) => string[]) =>
    new Set(targets.flatMap(paths)).size;
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
    totals: createDoctorSessionSqliteTotals(targets, {
      archivedLegacyStoreFiles: archives((target) => target.archivedLegacyStoreFiles ?? []),
      archivedTranscriptFiles: archives((target) => target.archivedTranscriptFiles),
      archivedUnreferencedJsonlFiles: archives((target) => target.archivedUnreferencedJsonlFiles),
      importedEntries: sum((target) => target.importedEntries),
      importedTranscriptEvents: sum((target) => target.importedTranscriptEvents),
      legacyEntries: sum((target) => target.legacyEntries),
      reclaimedBytes: sum((target) => target.compact?.reclaimedBytes ?? 0),
      unreferencedJsonlFiles: sum((target) => target.unreferencedJsonlFiles.length),
      validatedEntries: sum((target) => target.validatedEntries),
      validatedTranscriptEvents: sum((target) => target.validatedTranscriptEvents),
    }),
  };
}
