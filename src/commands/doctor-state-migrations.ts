export type { LegacyStateDetection } from "./doctor/state-migrations.js";
export {
  autoMigrateLegacyStateDir,
  detectLegacyStateMigrations,
  migrateLegacyAgentDir,
  resetAutoMigrateLegacyStateDirForTest,
  runLegacyStateMigrations,
} from "./doctor/state-migrations.js";
