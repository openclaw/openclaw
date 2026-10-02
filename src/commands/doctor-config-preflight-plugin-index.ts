import type { ConfigFileSnapshot } from "../config/types.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type { MigrationMessages } from "../infra/state-migrations.types.js";
import { resolveUpdateRehearsalRoot } from "../infra/update-rehearsal-paths.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "../plugins/installed-plugin-index-records.js";

/** Returns true during updater-managed config rewrites where plugin validation may be stale. */
export function shouldSkipPluginValidationForDoctorConfigPreflight(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isTruthyEnvValue(env.OPENCLAW_UPDATE_IN_PROGRESS);
}

/** One preflight owns completion; each read still checks the current update phase. */
export function createDoctorRehearsalSnapshotPreparation(
  report: (result: MigrationMessages) => void,
): (enabled: boolean) => ((snapshot: ConfigFileSnapshot) => Promise<void>) | undefined {
  let completed = false;
  const prepareSnapshot = async (snapshot: ConfigFileSnapshot) => {
    if (completed) {
      return;
    }
    const { completeUpdateCandidatePluginRehearsal } =
      await import("../infra/update-candidate-plugin-repair.js");
    const result = await completeUpdateCandidatePluginRehearsal({
      config: snapshot.sourceConfig ?? snapshot.config ?? {},
      env: process.env,
      installRecords: loadInstalledPluginIndexInstallRecordsSync({ env: process.env }),
    });
    completed = true;
    report({
      changes:
        result.copiedFiles > 0
          ? [`Update rehearsal: copied ${result.copiedFiles} missing plugin dependency files.`]
          : [],
      warnings: result.warnings,
    });
  };
  return (enabled) =>
    enabled &&
    resolveUpdateRehearsalRoot(process.env) &&
    process.env.OPENCLAW_UPDATE_IN_PROGRESS === "1"
      ? prepareSnapshot
      : undefined;
}
