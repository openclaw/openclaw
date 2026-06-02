import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MigrationPlan } from "../../plugins/types.js";

/** Config patch handling mode used by embedded/onboarding migration flows. */
export type MigrationConfigPatchMode = "return";

/** Shared options accepted by migration plan, apply, and default command flows. */
export type MigrateCommonOptions = {
  provider?: string;
  source?: string;
  includeSecrets?: boolean;
  authCredentials?: boolean;
  overwrite?: boolean;
  skills?: string[];
  plugins?: string[];
  verifyPluginApps?: boolean;
  json?: boolean;
  // Suppress the formatted plan dump that `migrate plan` normally prints
  // before any interactive selection. Used by onboarding flows that have
  // already secured user consent and do not want to re-render the plan.
  // The interactive selection picker and apply confirmation still run.
  suppressPlanLog?: boolean;
  // Internal embedded migration source of truth. Standalone CLI callers should
  // omit this so migration uses the current runtime config from disk.
  configOverride?: OpenClawConfig;
  // Internal embedded mode for config patch items. Default CLI behavior persists
  // patches when this is omitted; onboarding can request returned patch details.
  configPatchMode?: MigrationConfigPatchMode;
};

/** Options for applying a migration, including backup and preflight-plan reuse controls. */
export type MigrateApplyOptions = MigrateCommonOptions & {
  yes?: boolean;
  noBackup?: boolean;
  force?: boolean;
  backupOutput?: string;
  preflightPlan?: MigrationPlan;
};

/** Options for the default `openclaw migrate` command that can preview or apply. */
export type MigrateDefaultOptions = MigrateApplyOptions & {
  dryRun?: boolean;
};
