import { formatErrorMessage } from "../../infra/errors.js";
import { finishUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import type { UpdateRunResult, UpdateStepResult } from "../../infra/update-runner.js";
import { printResult } from "./progress.js";
import type { UpdateCommandOptions } from "./shared.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import {
  recordUpdateResultNextAction,
  UpdateCommandFailure,
  UpdateCommandFinalizedRecoveryFailure,
  UpdateCommandPendingRecoveryFailure,
} from "./update-command-result.js";
import { completeUpdateCommandRun } from "./update-command-run.js";

type Run = NonNullable<UpdateCommandOptions["run"]>;
type Publisher = (failure?: unknown) => Promise<UpdateRunResult>;
const terminalOwners = new WeakMap<Run, { publish?: Publisher }>();

/** Finalization prepares a report; the outer invocation owns its publication. */
export function deferUpdateCommandTerminalResult(
  run: Run | undefined,
  publish: Publisher,
): boolean {
  const owner = run && terminalOwners.get(run);
  if (!owner) {
    return false;
  }
  owner.publish = publish;
  return true;
}

export function hasDeferredUpdateCommandTerminalResult(run: Run): boolean {
  return terminalOwners.get(run)?.publish !== undefined;
}

/** Enclose the real executor so its final checks and release precede terminal output. */
export async function withUpdateCommandTerminalResult<T>(
  run: Run,
  operation: () => Promise<T>,
): Promise<T> {
  const owner: { publish?: Publisher } = {};
  terminalOwners.set(run, owner);
  let outcome: { value: T } | { error: unknown };
  try {
    outcome = { value: await operation() };
  } catch (error) {
    outcome = { error };
  } finally {
    terminalOwners.delete(run);
  }
  if (owner.publish) {
    const result = await owner.publish("error" in outcome ? outcome.error : undefined);
    if ("error" in outcome) {
      const failure = outcome.error;
      if (failure instanceof UpdateCommandPendingRecoveryFailure) {
        // Publication does not restore authority for outer failure triage.
        throw new UpdateCommandFinalizedRecoveryFailure(result);
      }
      // This report has already been printed. Do not let pending-recovery triage
      // print it a second time or launch recovery using a now-released fence.
      throw new UpdateCommandFailure(
        result,
        failure instanceof UpdateCommandFailure ? failure.exitCode : 1,
        formatErrorMessage(failure),
        {
          cause: failure,
          automaticTriage:
            failure instanceof UpdateCommandFailure ? failure.automaticTriage : undefined,
        },
      );
    }
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}

/** Resolve diagnostic output without reusing a released mutation fence. */
export async function resolveSettledUpdateCommandResult(
  params: Pick<FinishUpdateParams, "opts" | "ownedManagedUpdateEnv" | "root">,
  pendingResult: UpdateRunResult,
  failure?: unknown,
): Promise<{ result: UpdateRunResult; settlementFailed: boolean }> {
  const settlementFailed =
    failure !== undefined &&
    (!(failure instanceof UpdateCommandFailure) ||
      failure instanceof UpdateCommandPendingRecoveryFailure);
  const result: UpdateRunResult = settlementFailed
    ? {
        ...pendingResult,
        status: "error",
        reason: "update-executor-settlement-failed",
        steps: [
          ...pendingResult.steps,
          {
            name: "update executor settlement",
            command: "openclaw update",
            cwd: pendingResult.root ?? params.root,
            durationMs: 0,
            exitCode: 1,
            stderrTail: formatErrorMessage(failure),
          },
        ],
      }
    : failure instanceof UpdateCommandFailure
      ? failure.result
      : pendingResult;
  // The mutation owner is now closed. This is diagnostic publication only,
  // never authority to reopen displaced state or replace another terminal row.
  try {
    await assertUpdateRecoveryAdmission({
      env: params.ownedManagedUpdateEnv ?? params.opts.run?.env,
    });
    if (params.opts.run) {
      await assertUpdateRecoveryAdmission({ env: params.opts.run.env });
      const prior = getUpdateRun(params.opts.run.runId, { env: params.opts.run.env });
      if (prior && prior.status !== "running" && settlementFailed) {
        throw new Error("Update history was already finalized by another owner.");
      }
    }
  } catch (cause) {
    throw new UpdateCommandPendingRecoveryFailure(result, formatErrorMessage(cause), { cause });
  }
  return { result, settlementFailed };
}

/** Caller verification permits completion; only the producer can qualify a cleanup warning. */
export async function recordVerifiedUpdatePackageCleanup(
  params: Pick<FinishUpdateParams, "packageTransaction" | "root">,
  result: UpdateRunResult,
  assertCurrent: () => void,
): Promise<UpdateCommandFailure | void> {
  const transaction = params.packageTransaction;
  if (!transaction) {
    return;
  }
  let cleanupFailure: unknown;
  const retained: UpdateStepResult | void = await transaction
    .complete({ activationVerified: result.status === "ok" }, assertCurrent)
    .catch((error: unknown) => {
      assertCurrent();
      if (error instanceof UpdateCommandPendingRecoveryFailure) {
        throw error;
      }
      cleanupFailure = error;
      return {
        name: "global install backup retention",
        command: "openclaw update",
        cwd: result.root ?? params.root,
        durationMs: 0,
        exitCode: 1,
        stderrTail: `Update backup cleanup failed: ${formatErrorMessage(error)}. Inspect ${transaction.backupRoot} before manual cleanup.`,
      };
    });
  assertCurrent();
  if (!retained) {
    return;
  }
  result.steps = [...result.steps, retained];
  if (retained.exitCode !== 0 && retained.advisory?.kind !== "recoverable-maintenance") {
    // A caller's successful activation does not establish recovery/cleanup safety.
    // Unknown exceptions and unqualified completion refusals must fail the command.
    return new UpdateCommandFailure(
      { ...result, status: "error", reason: "package-backup-retention-failed" },
      1,
      retained.stderrTail ?? "Package backup completion was not verified.",
      { cause: cleanupFailure },
    );
  }
  return undefined;
}

/** Write the terminal ledger and its visible result together after settlement. */
export function publishUpdateCommandTerminalResult(
  params: Pick<FinishUpdateParams, "opts" | "coreAlreadyCurrent" | "ownedManagedUpdateEnv">,
  input: UpdateRunResult,
  outcome: { rolledBack: boolean; downtimeMs?: number },
): UpdateRunResult {
  const nextAction = recordUpdateResultNextAction(params, input);
  const run = params.opts.run;
  const { downtimeMs } = outcome;
  if (run && outcome.rolledBack) {
    finishUpdateRun(
      run.runId,
      { status: "rolled-back", reason: input.reason, after: input.after, downtimeMs },
      { env: run.env },
    );
  }
  const result = completeUpdateCommandRun(input, run, downtimeMs);
  printResult(result, params.opts, { nextAction });
  return result;
}
