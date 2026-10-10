import type { SessionStoreTarget } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DeferredPluginSessionImport } from "../infra/deferred-plugin-session-sources.js";
import {
  isSessionSqliteMigrationWarning,
  type DoctorSessionSqliteIssue,
  type DoctorSessionSqliteRestoreConflict,
} from "../infra/session-sqlite-migration-issues.js";
import type { SessionSqliteMigrationTargetInput } from "../infra/session-sqlite-migration-manifest.js";
import type { readOnlySqliteDbStats } from "../infra/session-sqlite-migration-readers.js";
import type { moveSqliteFilesAside } from "../infra/sqlite-recovery-files.js";
import type { LegacySessionRecord } from "./doctor-session-sqlite-discovery.js";

export type LegacyArchiveTarget = {
  sourceTarget: SessionStoreTarget & { sqlitePath?: string };
  target: SessionSqliteMigrationTargetInput;
  report: DoctorSessionSqliteTargetReport;
  validated: boolean;
  records: Array<Omit<LegacySessionRecord, "entry"> & { sessionId: string }>;
  deferredPluginIds: string[];
  retainedImportVerified: boolean;
  sourceConflicts?: Map<string, string>;
  verifiedSources?: DeferredPluginSessionImport["sources"];
};

export function countBlockingSessionSqliteIssues(report: DoctorSessionSqliteTargetReport): number {
  return report.issues.filter((issue) => !isSessionSqliteMigrationWarning(issue)).length;
}

export function isRetainedSourceIssue(issue: DoctorSessionSqliteIssue): boolean {
  return [
    "entry_invalid",
    "historical_duplicate_settled",
    "legacy_import_deferred",
    "transcript_malformed",
    "transcript_missing",
    "retained_plugin_source_index_rebuilt",
    "retained_plugin_receipt_superseded",
  ].includes(issue.code);
}

export function isInformationalMissingSessionIndex(
  report: DoctorSessionSqliteTargetReport,
): boolean {
  return report.issues.some((issue) => issue.code === "legacy_index_informational");
}

export type DoctorSessionSqliteRestoreReport = {
  conflicts: DoctorSessionSqliteRestoreConflict[];
  manifestPaths: string[];
  restoredFiles: string[];
  skippedFiles: string[];
};

export type DoctorSessionSqliteCompactReport = {
  dbSizeAfterBytes: number;
  dbSizeBeforeBytes: number;
  freelistAfterPages: number;
  freelistBeforePages: number;
  pageSizeBytes: number;
  reclaimedBytes: number;
  skipped: boolean;
  walSizeAfterBytes: number;
  walSizeBeforeBytes: number;
};

export type SessionSqliteMigrationFailureIssue = {
  body: string;
  bodyPath?: string;
  github?: {
    message?: string;
    status: "created" | "failed" | "skipped";
    url?: string;
  };
  title: string;
};

export type DoctorSessionSqliteMode =
  | "dry-run"
  | "import"
  | "validate"
  | "inspect"
  | "compact"
  | "restore"
  | "recover";

export type DoctorSessionSqliteOptions = {
  allAgents?: boolean;
  agent?: string;
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  mode: DoctorSessionSqliteMode;
  store?: string;
};

export type DoctorSessionSqliteTargetReport = {
  agentId: string;
  archivedLegacyStoreFiles?: string[];
  archivedTranscriptFiles: string[];
  archivedUnreferencedJsonlFiles: string[];
  dbStats?: Extract<ReturnType<typeof readOnlySqliteDbStats>, { ok: true }>["stats"];
  importedEntries: number;
  importedTranscriptEvents: number;
  issues: DoctorSessionSqliteIssue[];
  legacyEntries: number;
  referencedTranscriptFiles: number;
  sqliteEntries: number;
  sqlitePath: string;
  storePath: string;
  unreferencedJsonlFiles: string[];
  validatedEntries: number;
  validatedTranscriptEvents: number;
  compact?: DoctorSessionSqliteCompactReport;
  corruptRecovery?: ReturnType<typeof moveSqliteFilesAside>;
  restore?: DoctorSessionSqliteRestoreReport;
};

export function createDoctorSessionSqliteTargetReport(
  values: Pick<DoctorSessionSqliteTargetReport, "agentId" | "sqlitePath" | "storePath"> &
    Partial<Omit<DoctorSessionSqliteTargetReport, "agentId" | "sqlitePath" | "storePath">>,
): DoctorSessionSqliteTargetReport {
  return {
    archivedTranscriptFiles: [],
    archivedUnreferencedJsonlFiles: [],
    importedEntries: 0,
    importedTranscriptEvents: 0,
    issues: [],
    legacyEntries: 0,
    referencedTranscriptFiles: 0,
    sqliteEntries: 0,
    unreferencedJsonlFiles: [],
    validatedEntries: 0,
    validatedTranscriptEvents: 0,
    ...values,
  };
}

export type DoctorSessionSqliteReport = {
  migrationRun?: {
    failureReportJsonPath?: string;
    failureReportMarkdownPath?: string;
    manifestPath: string;
    runId: string;
  };
  mode: DoctorSessionSqliteMode;
  supportIssue?: SessionSqliteMigrationFailureIssue;
  targets: DoctorSessionSqliteTargetReport[];
  totals: {
    archivedLegacyStoreFiles?: number;
    archivedTranscriptFiles: number;
    archivedUnreferencedJsonlFiles: number;
    importedEntries: number;
    importedTranscriptEvents: number;
    issues: number;
    legacyEntries: number;
    reclaimedBytes?: number;
    sqliteEntries: number;
    targets: number;
    unreferencedJsonlFiles: number;
    validatedEntries: number;
    validatedTranscriptEvents: number;
  };
};
