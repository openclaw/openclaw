import { formatErrorMessage } from "../../infra/errors.js";
import {
  resolveManagedServiceUpdateFailureExitCode,
  type ControlPlaneUpdateSentinelMetaFile,
} from "../../infra/update-control-plane-sentinel.js";
import { verifyPackageUpdateRecovery } from "../../infra/update-global.js";
import { getUpdateRun, recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import { readCurrentGitUpdateRecovery } from "../../infra/update-runner-git-recovery.js";
import type { UpdateRunResult, UpdateStepResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { printResult } from "./progress.js";
import type { UpdateCommandOptions } from "./shared.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import {
  recordUpdateResultNextAction,
  UpdateCommandFailure,
  UpdateCommandFinalizedRecoveryFailure,
  UpdateCommandPendingRecoveryFailure,
  writeControlPlaneUpdateRestartSentinelBestEffort,
} from "./update-command-result.js";
import { completeUpdateCommandRun } from "./update-command-run.js";

type Run = NonNullable<UpdateCommandOptions["run"]>;
type Publisher = (failure?: unknown) => Promise<UpdateRunResult>;
type TerminalOwner = {
  publish?: Publisher;
  retireCapture?: (result: UpdateRunResult) => Promise<void>;
  captureResult?: UpdateRunResult;
  settled: boolean;
};
const terminalOwners = new WeakMap<Run, TerminalOwner>();

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

/** Only the enclosing settled invocation may retire its own recovery capture. */
export function deferUpdateCommandCaptureRetirement(
  run: Run | undefined,
  result: UpdateRunResult,
  retire: (result: UpdateRunResult) => Promise<void>,
): boolean {
  const owner = run && terminalOwners.get(run);
  if (!owner || owner.settled) {
    return false;
  }
  owner.retireCapture = retire;
  owner.captureResult = result;
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
  const owner: TerminalOwner = { settled: false };
  terminalOwners.set(run, owner);
  let outcome: { value: T } | { error: unknown };
  try {
    outcome = { value: await operation() };
  } catch (error) {
    outcome = { error };
  }
  owner.settled = !("error" in outcome);
  try {
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
    if (!owner.publish && owner.captureResult) {
      await owner.retireCapture?.(owner.captureResult);
    }
    return outcome.value;
  } finally {
    terminalOwners.delete(run);
  }
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
  const base = failure instanceof UpdateCommandFailure ? failure.result : pendingResult;
  const result: UpdateRunResult = settlementFailed
    ? {
        ...base,
        status: "error",
        reason: "update-executor-settlement-failed",
        steps: [
          ...base.steps,
          {
            name: "update executor settlement",
            command: "openclaw update",
            cwd: base.root ?? params.root,
            durationMs: 0,
            exitCode: 1,
            stderrTail: formatErrorMessage(failure),
          },
        ],
      }
    : base;
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

export async function reportPreMutationUpdateFailure(params: {
  root: string;
  installKind: "git" | "package" | "unknown";
  reason: string;
  message?: string;
  opts: UpdateCommandOptions;
  controlPlaneUpdateSentinelMeta: ControlPlaneUpdateSentinelMetaFile["meta"] | null;
}): Promise<never> {
  const run = params.opts.run;
  const active = run ? getUpdateRun(run.runId, { env: run.env }) : undefined;
  if (run && active && params.message) {
    recordUpdateRunPhase(
      run.runId,
      active.phase,
      { origin: { nextAction: params.message } },
      { env: run.env },
    );
  }
  const result = completeUpdateCommandRun(
    {
      status: "error",
      mode: params.installKind === "git" ? "git" : "unknown",
      root: params.root,
      reason: params.reason,
      ...(params.opts.dryRun !== true
        ? {
            recovery: await (params.installKind === "git"
              ? readCurrentGitUpdateRecovery(params.root)
              : verifyPackageUpdateRecovery(params.root)),
          }
        : {}),
      steps: [],
      durationMs: 0,
    },
    params.opts.run,
  );
  if (params.opts.dryRun !== true) {
    await writeControlPlaneUpdateRestartSentinelBestEffort({
      meta: params.controlPlaneUpdateSentinelMeta,
      result,
      jsonMode: Boolean(params.opts.json),
    });
  }
  if (params.opts.json && params.message) {
    defaultRuntime.error(params.message);
  }
  printResult(result, params.opts, { nextAction: params.message });
  throw new UpdateCommandFailure(
    result,
    resolveManagedServiceUpdateFailureExitCode(result),
    params.message,
  );
}

/** Write the terminal ledger and its visible result together after settlement. */
export async function publishUpdateCommandTerminalResult(
  params: Pick<FinishUpdateParams, "opts" | "coreAlreadyCurrent" | "ownedManagedUpdateEnv">,
  input: UpdateRunResult,
  outcome: { rolledBack: boolean; downtimeMs?: number },
): Promise<UpdateRunResult> {
  const nextAction = recordUpdateResultNextAction(params, input);
  const run = params.opts.run;
  const result = completeUpdateCommandRun(input, run, outcome);
  const owner = run && terminalOwners.get(run);
  if (owner?.settled) {
    await owner.retireCapture?.(result);
  }
  printResult(result, params.opts, { nextAction });
  return result;
}
