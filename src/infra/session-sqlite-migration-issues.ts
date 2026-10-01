/** Shared migration findings; CLI reports and startup verification use the same severity. */
export type DoctorSessionSqliteIssue = {
  code: string;
  message: string;
  sessionKey?: string;
};

export type DoctorSessionSqliteRestoreConflict = {
  archivePath: string;
  reason: string;
  sourcePath: string;
};

const SESSION_SQLITE_WARNING_ISSUE_CODES = new Set([
  "active_sqlite_transcript_jsonl",
  "entry_invalid",
  "historical_transcript_deferred",
  "historical_duplicate_settled",
  "legacy_index_informational",
  "plugin_migration_source_retained",
  "retained_plugin_source_index_rebuilt",
  "retained_plugin_source_conflict",
  "transcript_archive_failed",
  "transcript_malformed",
  "transcript_missing",
  "unreferenced_jsonl_archive_failed",
]);

export function isSessionSqliteMigrationWarning(issue: DoctorSessionSqliteIssue): boolean {
  return SESSION_SQLITE_WARNING_ISSUE_CODES.has(issue.code);
}
