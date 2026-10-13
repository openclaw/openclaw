// Publishes a Doctor pass's outcome to the updater that launched it.
import type { beginDoctorMaintenance } from "../commands/doctor-maintenance.js";
import { retainCurrentDeferredPluginMigrationWarnings } from "../infra/deferred-plugin-migration-warnings.js";
import { formatUpdateDoctorConfigChange } from "../infra/update-doctor-config.js";
import {
  normalizeUpdatePostInstallDoctorWarnings,
  writeUpdatePostInstallDoctorResult,
  type DoctorConfigCapture,
  type UpdatePostInstallDoctorResult,
} from "../infra/update-doctor-result.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contributions.js";

export async function publishDoctorUpdateResult(params: {
  updateResult: { resultPath: string; capture: DoctorConfigCapture };
  doctorResult: UpdatePostInstallDoctorResult;
  healthContext: DoctorHealthFlowContext | undefined;
  maintenance: Awaited<ReturnType<typeof beginDoctorMaintenance>>;
}): Promise<void> {
  const { updateResult, doctorResult, healthContext, maintenance } = params;
  for (const change of updateResult.capture.configChanges) {
    createSubsystemLogger("update").warn(formatUpdateDoctorConfigChange(change));
  }
  const contributionWarnings = healthContext?.updateWarnings ?? [];
  const deferredCount = healthContext?.updateBudget?.deferred.size ?? 0;
  // Contributions put deferrals first; retain migration advisories before other diagnostics.
  // The updater persists these, so drop plugin migration warnings this pass already settled.
  const warnings = await retainCurrentDeferredPluginMigrationWarnings(
    normalizeUpdatePostInstallDoctorWarnings([
      ...contributionWarnings.slice(0, deferredCount),
      ...(doctorResult.warnings ?? []),
      ...(maintenance?.warnings ?? []).filter(
        (warning) => !doctorResult.warnings?.includes(warning),
      ),
      ...contributionWarnings.slice(deferredCount),
    ]),
  );
  const outcome = { ...doctorResult };
  delete outcome.warnings;
  await writeUpdatePostInstallDoctorResult({
    resultPath: updateResult.resultPath,
    result: {
      ...outcome,
      ...(maintenance?.databaseWrites ? { databaseWrites: maintenance.databaseWrites } : {}),
      ...(updateResult.capture.fileWrites
        ? { configFileWrites: updateResult.capture.fileWrites }
        : {}),
      ...(warnings.length ? { warnings } : {}),
      ...(updateResult.capture.configChanges.length
        ? { configChanges: updateResult.capture.configChanges }
        : {}),
      ...(updateResult.capture.configWriteRefusal
        ? { configWriteRefusal: updateResult.capture.configWriteRefusal }
        : {}),
      configHash: updateResult.capture.hash,
      ...(updateResult.capture.inputHash === undefined
        ? {}
        : { configInputHash: updateResult.capture.inputHash }),
    },
  });
}
