import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
// Publishes a Doctor pass's outcome to the updater that launched it.
import type { beginDoctorMaintenance } from "../commands/doctor-maintenance.js";
import { ConfigWritePostCommitError } from "../config/io.write-errors.js";
import { retainCurrentDeferredUpdateWarnings } from "../infra/deferred-update-warnings.js";
import { DoctorStateMigrationRefusalError } from "../infra/state-migrations.messages.js";
import { resolveDoctorUpdateRun } from "../infra/update-deferred-model-retirement.js";
import { formatUpdateDoctorConfigChange } from "../infra/update-doctor-config.js";
import {
  UpdateDoctorError,
  normalizeUpdatePostInstallDoctorWarnings,
  writeUpdatePostInstallDoctorResult,
  type DoctorConfigCapture,
  type UpdatePostInstallDoctorResult,
} from "../infra/update-doctor-result.js";
import { createUpdateErrorFact, createUpdateFailureFact } from "../infra/update-failure-facts.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { UpdateSchemaRefusalError } from "../state/openclaw-update-schema-refusal.js";
import { collectDoctorHealthResultWarnings } from "./doctor-health-contribution.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contributions.js";

export async function publishDoctorUpdateResult(params: {
  updateResult: { resultPath?: string; capture: DoctorConfigCapture };
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
  updateResult.capture.warnings = warnings;
  if (!updateResult.resultPath) {
    return;
  }
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

export async function createDoctorFailureResult(
  error: unknown,
  refusalWarnings: string[],
  includeWarnings: boolean,
): Promise<UpdatePostInstallDoctorResult> {
  const causes = collectNestedErrorCandidates(error);
  const { classifyDoctorMaintenanceRefusal } =
    await import("../commands/doctor-maintenance-inspection.js");
  const maintenanceRefusal = classifyDoctorMaintenanceRefusal(error);
  const unsafeConfigWrite = causes.find(
    (cause): cause is ConfigWritePostCommitError =>
      cause instanceof ConfigWritePostCommitError && cause.rollbackStatus !== "restored",
  );
  const schemaRefusal = causes.find(
    (cause): cause is UpdateSchemaRefusalError => cause instanceof UpdateSchemaRefusalError,
  );
  const refusalFacts = causes.flatMap((cause) =>
    cause instanceof UpdateDoctorError || cause instanceof DoctorStateMigrationRefusalError
      ? cause.failureFacts
      : [],
  );
  return {
    status: "error",
    ...(maintenanceRefusal.kind === "data-at-risk" ? { maintenanceRefusal } : {}),
    ...(includeWarnings && refusalWarnings.length > 0 ? { warnings: refusalWarnings } : {}),
    failureFacts:
      !unsafeConfigWrite && !schemaRefusal && refusalFacts.length > 0
        ? refusalFacts
        : [
            createUpdateFailureFact({
              leaseLoss: createUpdateErrorFact("doctor", error).leaseLoss,
              check: unsafeConfigWrite
                ? "config-write"
                : schemaRefusal
                  ? "database-schema-preflight"
                  : "doctor",
              code: unsafeConfigWrite
                ? "rollback-state-unverified"
                : (schemaRefusal?.code ?? "doctor-failed"),
              message: unsafeConfigWrite
                ? `${unsafeConfigWrite.publication} config publication; rollback ${unsafeConfigWrite.rollbackStatus}. ${unsafeConfigWrite.message}`
                : (schemaRefusal?.message ??
                  (error instanceof Error ? error.message : String(error))),
            }),
          ],
  };
}

export function createDoctorCompletedResult(
  ctx: DoctorHealthFlowContext,
  maintenance: Awaited<ReturnType<typeof beginDoctorMaintenance>>,
  pluginWarnings: string[],
): UpdatePostInstallDoctorResult {
  const maintenanceWarnings = maintenance?.warnings ?? [];
  const warnings = normalizeUpdatePostInstallDoctorWarnings([
    ...pluginWarnings,
    ...(ctx.configResult.warnings ?? []),
    ...maintenanceWarnings,
    ...(ctx.configResult.stateMigrationStepReceipts ?? []).flatMap((receipt) =>
      receipt.outcome === "warning" ||
      receipt.outcome === "skipped" ||
      receipt.outcome === "deferred"
        ? receipt.warnings
        : [],
    ),
    ...(ctx.postInstallDoctorResult?.warnings ?? []),
  ]);
  ctx.repairEvidence?.summarize([
    ...warnings.filter((warning) => !maintenanceWarnings.includes(warning)),
    ...(ctx.updateWarnings ?? []),
  ]);
  return {
    ...(ctx.postInstallDoctorResult ?? { status: "ok" }),
    ...(warnings.length ? { warnings } : {}),
    ...(maintenance?.failureFacts?.length
      ? {
          failureFacts: [
            ...maintenance.failureFacts,
            ...(ctx.postInstallDoctorResult?.failureFacts ?? []),
          ],
        }
      : {}),
  };
}
