import {
  failedPackageVerificationStep,
  markPackagePostInstallDoctorAdvisory,
} from "../../infra/package-update-verification-step.js";
import type { UpdateDatabaseBackup } from "../../infra/update-database-backup.js";
import {
  formatUpdateDoctorConfigWriteRefusal,
  type UpdateDoctorConfigChange,
} from "../../infra/update-doctor-config.js";
import type { UpdatePostInstallDoctorResult } from "../../infra/update-doctor-result.js";
import type { UpdateDoctorSectionTiming } from "../../infra/update-doctor-section-timing.js";
import {
  createUpdateFailureFact,
  normalizeUpdateFailureFacts,
} from "../../infra/update-failure-facts.js";
import { reportUpdateStepCompletion } from "../../infra/update-runner-command.js";
import type { UpdateStepProgress } from "../../infra/update-runner-types.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import {
  readUpdateConfigSnapshot,
  type UpdateConfigSnapshot,
} from "./update-command-config-snapshot.js";
import { recordUpdateDatabaseWrites } from "./update-command-database-receipts.js";

type DoctorCompletionOptions = {
  root: string;
  progress: UpdateStepProgress;
  onConfigSnapshot?: (snapshot: UpdateConfigSnapshot) => void;
  context?: { changes: UpdateDoctorConfigChange[]; databaseBackup?: UpdateDatabaseBackup };
  configSnapshot?: UpdateConfigSnapshot;
  sectionTiming: UpdateDoctorSectionTiming;
  assertCurrent: () => void;
  doctorProgressInfo: { name: string; command: string; index: number; total: number };
};

export function createPackageUpdateDoctorCompletion(params: DoctorCompletionOptions) {
  const { context, configSnapshot, sectionTiming, assertCurrent, doctorProgressInfo } = params;
  return async (
    doctorStep: UpdateStepResult,
    doctorResult: UpdatePostInstallDoctorResult | null,
    failure?: { error: unknown },
  ) => {
    let completionFailure = failure;
    sectionTiming.annotate(doctorStep);
    const databaseReceipt = context?.databaseBackup
      ? recordUpdateDatabaseWrites(context.databaseBackup, doctorResult?.databaseWrites, doctorStep)
      : undefined;
    try {
      const refusal = doctorResult?.configWriteRefusal;
      const configWriteRefusal = refusal
        ? {
            ...refusal,
            keys: [
              ...new Set([
                ...refusal.keys,
                ...(context?.changes.flatMap((change) =>
                  change.kind === "key" ? [change.key] : [],
                ) ?? []),
              ]),
            ].toSorted(),
          }
        : undefined;
      Object.assign(
        doctorStep,
        markPackagePostInstallDoctorAdvisory(
          {
            ...doctorStep,
            ...(doctorResult?.configChanges?.length
              ? { configChanges: doctorResult.configChanges }
              : {}),
            ...(doctorResult?.warnings?.length ? { warnings: doctorResult.warnings } : {}),
            ...(configWriteRefusal
              ? {
                  configWriteRefusal,
                  stderrTail: formatUpdateDoctorConfigWriteRefusal(configWriteRefusal),
                }
              : {}),
          },
          doctorResult,
        ),
      );
      if (configSnapshot?.doctorOwned === false) {
        doctorStep.warnings = [
          ...(doctorStep.warnings ?? []),
          "The config include graph could not be captured before Doctor; automatic config rollback is unavailable for this update.",
        ];
      }
      if (configWriteRefusal) {
        doctorStep.failureFacts = normalizeUpdateFailureFacts([
          createUpdateFailureFact({
            check: "config",
            code: configWriteRefusal.reason,
            message: formatUpdateDoctorConfigWriteRefusal(configWriteRefusal),
          }),
          ...(doctorStep.failureFacts ?? []),
        ]);
        delete doctorStep.advisory;
      }
      if (configSnapshot) {
        // Only the child writer can attribute bytes to Doctor; a later read may contain an operator save.
        const { hash } = await readUpdateConfigSnapshot(configSnapshot.path);
        const doctorHash = doctorResult?.configHash;
        const doctorInputHash = doctorResult?.configInputHash;
        const capturedPaths = new Set([
          configSnapshot.pathSnapshot?.targetPath ?? configSnapshot.path,
          ...(configSnapshot.includedFiles ?? []).map(
            (file) => file.pathSnapshot?.targetPath ?? file.path,
          ),
        ]);
        const writesCaptured = Object.keys(doctorResult?.configFileWrites ?? {}).every((file) =>
          capturedPaths.has(file),
        );
        const includedFiles: NonNullable<UpdateConfigSnapshot["includedFiles"]> = [];
        for (const file of configSnapshot.includedFiles ?? []) {
          const current = await readUpdateConfigSnapshot(file.path);
          const receipt =
            doctorResult?.configFileWrites?.[file.pathSnapshot?.targetPath ?? file.path];
          includedFiles.push({
            ...file,
            hash: current.hash,
            doctorOwned:
              receipt?.inputHash === undefined
                ? current.hash === file.hash
                : receipt.inputHash === file.hash && current.hash === receipt.hash,
          });
        }
        params.onConfigSnapshot?.({
          ...configSnapshot,
          hash,
          ...(configSnapshot.includedFiles ? { includedFiles } : {}),
          doctorOwned:
            configSnapshot.doctorOwned !== false &&
            writesCaptured &&
            (doctorInputHash === undefined
              ? hash === configSnapshot.hash
              : doctorInputHash === configSnapshot.hash &&
                hash === (doctorHash === "unchanged" ? doctorInputHash : doctorHash)),
        });
      }
    } catch (error) {
      completionFailure = {
        error: completionFailure
          ? new AggregateError(
              [completionFailure.error, error],
              "Doctor config attribution failed",
              {
                cause: error,
              },
            )
          : error,
      };
    }
    if (completionFailure) {
      Object.assign(
        doctorStep,
        failedPackageVerificationStep(params.root, completionFailure.error, doctorStep),
      );
      delete doctorStep.advisory;
    }
    // Join callback failures with the settled Doctor error; authority checks keep their own outcome.
    const reportCompletion = async (step: Parameters<typeof reportUpdateStepCompletion>[1]) => {
      try {
        await (completionFailure
          ? params.progress?.onStepComplete?.(step)
          : reportUpdateStepCompletion(params.progress, step));
      } catch (error) {
        if (completionFailure) {
          throw new AggregateError(
            [completionFailure.error, error],
            "Doctor progress reporting failed",
            {
              cause: error,
            },
          );
        }
        throw error;
      }
    };
    if (databaseReceipt) {
      await reportCompletion({
        ...databaseReceipt,
        index: 0,
        total: 0,
      });
      assertCurrent();
    }
    await reportCompletion({
      ...doctorProgressInfo,
      durationMs: doctorStep.durationMs,
      exitCode: doctorStep.exitCode,
      stdoutTail: doctorStep.stdoutTail,
      stderrTail: doctorStep.stderrTail,
      signal: doctorStep.signal,
      killed: doctorStep.killed,
      outputLimitExceeded: doctorStep.outputLimitExceeded,
      termination: doctorStep.termination,
      advisory: doctorStep.advisory,
      warnings: doctorStep.warnings,
      diagnostics: doctorStep.diagnostics,
      failureFacts: doctorStep.failureFacts,
      doctorLintFindings: doctorStep.doctorLintFindings,
      configChanges: doctorStep.configChanges,
      configWriteRefusal: doctorStep.configWriteRefusal,
    });
    assertCurrent();
    if (completionFailure) {
      throw completionFailure.error;
    }
    return doctorStep;
  };
}
