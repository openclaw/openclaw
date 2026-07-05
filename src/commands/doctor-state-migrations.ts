/** Re-exports legacy state migration helpers used by doctor preflight. */
export type { LegacyStateDetection } from "../infra/state-migrations.js";
export {
  autoMigrateLegacyStateDir,
<<<<<<< HEAD
  autoMigrateLegacyPluginDoctorState,
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  autoMigrateLegacyTaskStateSidecars,
  autoMigrateLegacyState,
  detectLegacyStateMigrations,
  migrateLegacyAgentDir,
  resetAutoMigrateLegacyStateDirForTest,
  resetAutoMigrateLegacyTaskStateSidecarsForTest,
  resetAutoMigrateLegacyStateForTest,
  runLegacyStateMigrations,
} from "../infra/state-migrations.js";
