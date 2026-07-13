// Applies persisted state migrations across OpenClaw config files.
export type { LegacyStateDetection } from "./state-migrations.types.js";
export {
  autoMigrateLegacyPluginDoctorState,
  autoMigrateLegacyState,
  detectLegacyStateMigrations,
  resetAutoMigrateLegacyStateForTest,
  runLegacyStateMigrations,
} from "./state-migrations.doctor.js";
export { migrateLegacyAgentDir } from "./state-migrations.legacy-sessions.js";
export {
  migrateOrphanedSessionKeys,
  sessionStoreTextMayNeedCanonicalization,
} from "./state-migrations.session-store.js";
export {
  autoMigrateLegacyStateDir,
  autoMigrateLegacyTaskStateSidecars,
  resetAutoMigrateLegacyStateDirForTest,
  resetAutoMigrateLegacyTaskStateSidecarsForTest,
} from "./state-migrations.state-dir.js";
export {
  CRON_RUN_LOG_TASK_IMPORT_MIGRATION_ID,
  migrateLegacyCronRunLogsToTaskRuns,
} from "./state-migrations.cron-run-logs.js";
