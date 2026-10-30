// Publishes a Doctor pass's outcome to the updater that launched it.
import type { beginDoctorMaintenance } from "../commands/doctor-maintenance.js";
import { retainCurrentDeferredUpdateWarnings } from "../infra/deferred-update-warnings.js";
import { resolveDoctorUpdateRun } from "../infra/update-deferred-model-retirement.js";
import { formatUpdateDoctorConfigChange } from "../infra/update-doctor-config.js";
import {
  writeUpdatePostInstallDoctorResult,
  type DoctorConfigCapture,
  type UpdatePostInstallDoctorResult,
} from "../infra/update-doctor-result.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { collectDoctorHealthResultWarnings } from "./doctor-health-contribution.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contributions.js";

export async function publishDoctorUpdateResult(params: {
  updateResult: { resultPath: string; capture: DoctorConfigCapture };
  doctorResult: UpdatePostInstallDoctorResult;
  healthContext: DoctorHealthFlowContext | undefined;
  maintenance: Awaited<ReturnType<typeof beginDoctorMaintenance>>;
  startupWarnings?: readonly string[];
}): Promise<void> {
  const { updateResult, doctorResult, healthContext, maintenance } = params;
  for (const change of updateResult.capture.configChanges) {
    createSubsystemLogger("update").warn(formatUpdateDoctorConfigChange(change));
  }
  const warnings = await retainCurrentDeferredUpdateWarnings(
    collectDoctorHealthResultWarnings({
      healthContext,
      startupWarnings: params.startupWarnings,
      resultWarnings: doctorResult.warnings,
      maintenanceWarnings: maintenance?.warnings,
    }),
    { readUpdateRun: () => resolveDoctorUpdateRun(healthContext?.env ?? process.env) },
  );
  const outcome = { ...doctorResult };
  delete outcome.warnings;
  delete outcome.deferredInspectionCheckIds;
  await writeUpdatePostInstallDoctorResult({
    resultPath: updateResult.resultPath,
    result: {
      ...outcome,
      ...(updateResult.capture.deferredInspectionCheckIds
        ? { deferredInspectionCheckIds: updateResult.capture.deferredInspectionCheckIds }
        : {}),
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
