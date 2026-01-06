export type { LegacyStateDetection } from "../infra/state-migrations.js";
export {
  autoMigrateLegacyAgentDir,
  detectLegacyStateMigrations,
  migrateLegacyAgentDir,
  resetAutoMigrateLegacyAgentDirForTest,
  runLegacyStateMigrations,
} from "../infra/state-migrations.js";
