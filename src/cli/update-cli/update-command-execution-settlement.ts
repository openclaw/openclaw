import type { PackageUpdateTransaction } from "../../infra/package-update-swap-contract.js";
import type { UpdateDatabaseBackup } from "../../infra/update-database-backup.js";
import { isUpdatePostInstallVerificationDeferred } from "../../infra/update-run-step.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { restoreFailedUpdateDatabases } from "./update-command-database-backup.js";
import type { MutableUpdateExecutionParams } from "./update-command-execution.types.js";
import { recordMutableUpdateInterruption } from "./update-command-mutable-signals.js";
import type { MutableUpdateExecutionResult } from "./update-command-result.js";

type MutableUpdateSettlement = {
  result: UpdateRunResult;
  failure: MutableUpdateExecutionResult["failure"];
  candidateFailureReason?: string;
  databaseBackup?: UpdateDatabaseBackup;
  databaseCaptureStep?: UpdateStepResult;
  activationSteps: UpdateStepResult[];
  doctorEntered: boolean;
  packageTransaction?: PackageUpdateTransaction;
  originalRun: MutableUpdateExecutionParams["opts"]["run"];
  env?: NodeJS.ProcessEnv;
  assertCurrent: () => void;
};

export async function settleMutableUpdateResult(
  params: MutableUpdateExecutionParams,
  settlement: MutableUpdateSettlement,
): Promise<UpdateRunResult> {
  const { opts } = params;
  const { databaseBackup, databaseCaptureStep, activationSteps, packageTransaction } = settlement;
  const originalRun = settlement.originalRun;
  let result = recordMutableUpdateInterruption(opts, settlement.result);
  if (
    result.status === "ok" &&
    opts.restart === false &&
    result.steps.some(isUpdatePostInstallVerificationDeferred)
  ) {
    result = { ...result, status: "skipped", reason: "gateway-readiness-unverified" };
  }
  if (settlement.candidateFailureReason && result.status === "error") {
    result.reason = settlement.candidateFailureReason;
  }
  if (databaseCaptureStep || activationSteps.length) {
    result.steps = [
      ...(databaseCaptureStep ? [databaseCaptureStep] : []),
      ...result.steps,
      ...activationSteps,
    ];
  }
  const doctorSettled =
    settlement.doctorEntered && !hasCommandProcessCleanupError(settlement.failure?.cause);
  if (databaseBackup && originalRun && result.status === "error" && doctorSettled) {
    // Execution has not entered finalization or admitted any candidate Gateway.
    // Restore before schema inspection can hand an incompatible ledger to the candidate.
    await restoreFailedUpdateDatabases({
      backup: databaseBackup,
      result,
      runId: originalRun.runId,
      env: settlement.env ?? originalRun.env,
      assertCurrent: settlement.assertCurrent,
      assertRollbackSafe: packageTransaction?.assertRollbackSafe,
      progress: params.progress,
    });
  }
  return result;
}
