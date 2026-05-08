import { repairMissingConfiguredPluginInstalls } from "../../commands/doctor/shared/missing-configured-plugin-install.js";
import { UPDATE_POST_CORE_CONVERGENCE_ENV } from "../../commands/doctor/shared/update-phase.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import {
  runPluginPayloadSmokeCheck,
  type PluginPayloadSmokeFailure,
} from "./plugin-payload-validation.js";

export type PostCoreConvergenceWarning = {
  pluginId?: string;
  reason: string;
  message: string;
  guidance: string[];
};

export type PostCoreConvergenceResult = {
  changes: string[];
  warnings: PostCoreConvergenceWarning[];
  errored: boolean;
  smokeFailures: PluginPayloadSmokeFailure[];
  /**
   * Install records as they exist on disk *after* the convergence pass has
   * (potentially) repaired missing plugins. Callers that subsequently write
   * back the installed-plugin index MUST seed their write from these records
   * — otherwise the in-memory pre-convergence snapshot will overwrite the
   * fresh repairs that convergence just persisted via
   * `repairMissingConfiguredPluginInstalls` →
   * `writePersistedInstalledPluginIndexInstallRecords`.
   */
  installRecords: Record<string, PluginInstallRecord>;
};

const REPAIR_GUIDANCE = "Run `openclaw doctor --fix` to retry plugin repair.";
const inspectGuidance = (pluginId: string) =>
  `Run \`openclaw plugins inspect ${pluginId} --runtime --json\` for details.`;

/**
 * Mandatory post-core convergence pass. Runs AFTER the core package files
 * are swapped and the in-update doctor pass has already returned, but BEFORE
 * the gateway is restarted. Failures here must block the restart so we
 * never restart with a configured plugin whose payload is unloadable.
 */
export async function runPostCorePluginConvergence(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<PostCoreConvergenceResult> {
  const env: NodeJS.ProcessEnv = {
    ...params.env,
    [UPDATE_POST_CORE_CONVERGENCE_ENV]: "1",
  };

  const repair = await repairMissingConfiguredPluginInstalls({
    cfg: params.cfg,
    env,
  });

  const warnings: PostCoreConvergenceWarning[] = repair.warnings.map((message) => ({
    reason: message,
    message,
    guidance: [REPAIR_GUIDANCE],
  }));

  const records: Record<string, PluginInstallRecord> = await loadInstalledPluginIndexInstallRecords(
    { env },
  );
  const smoke = await runPluginPayloadSmokeCheck({ records, env });
  for (const failure of smoke.failures) {
    warnings.push({
      pluginId: failure.pluginId,
      reason: `${failure.reason}: ${failure.detail}`,
      message: `Plugin "${failure.pluginId}" failed post-core payload smoke check (${failure.reason}): ${failure.detail}`,
      guidance: [REPAIR_GUIDANCE, inspectGuidance(failure.pluginId)],
    });
  }

  return {
    changes: repair.changes,
    warnings,
    errored: warnings.length > 0,
    smokeFailures: smoke.failures,
    installRecords: records,
  };
}

/**
 * Pure helper used by `updatePluginsAfterCoreUpdate` to fold a convergence
 * result into the existing `PluginUpdateOutcome[]` / warning shape that the
 * post-core update result carries.
 *
 * Returns:
 *  - `outcomes` to append to `pluginUpdateOutcomes`. Only convergence
 *    warnings that name a `pluginId` produce per-plugin error outcomes; the
 *    rest are surfaced via `warnings`.
 *  - `errored` boolean that callers translate into `status: "error"`.
 */
export function convergenceWarningsToOutcomes(convergence: PostCoreConvergenceResult): {
  warnings: PostCoreConvergenceWarning[];
  outcomes: Array<{ pluginId: string; status: "error"; message: string }>;
  errored: boolean;
} {
  const outcomes = convergence.warnings
    .filter((w): w is PostCoreConvergenceWarning & { pluginId: string } => Boolean(w.pluginId))
    .map((w) => ({ pluginId: w.pluginId, status: "error" as const, message: w.message }));
  return {
    warnings: convergence.warnings,
    outcomes,
    errored: convergence.errored,
  };
}
