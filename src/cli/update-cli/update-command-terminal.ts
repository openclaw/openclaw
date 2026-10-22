import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveManagedServiceUpdateFailureExitCode } from "../../infra/update-control-plane-sentinel.js";
import { createUpdateErrorFact, type UpdateFailureFact } from "../../infra/update-failure-facts.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import { UpdateRecoveryRequiredError } from "../../infra/update-run-recovery.js";
import { isUpdateGatewayReadinessPending } from "../../infra/update-run-step.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { exitCliAfterOutput } from "../one-shot-exit.js";
import { prepareResult, printResult } from "./progress.js";
import type { UpdateCommandOptions } from "./shared.js";
import { UpdateActivationTimeoutError } from "./update-command-activation.js";
import {
  prepareUnreportedUpdateAdmissionOutcome,
  publishUnreportedUpdateAdmissionOutcome,
  resolveUnreportedUpdateAdmissionReport,
} from "./update-command-admission-report.js";
import { registerUpdateCommandTerminalPreparation } from "./update-command-executor-capabilities.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import type { MigratedUpdateFinalizationResult } from "./update-command-migrated-types.js";
import {
  recordMutableUpdateInterruption,
  withMutableUpdateTerminalSettlement,
} from "./update-command-mutable-signals.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import {
  recordUpdateResultNextAction,
  failUpdateCommandRun,
  createPreMutationUpdateResult,
  createUpdateCommandFailureResult,
  UnreportedUpdateAdmissionOutcome,
  UpdateCommandFailure,
  UpdateCommandFinalizedRecoveryFailure,
  UpdateCommandPendingRecoveryFailure,
  withUpdateStateRead,
  isUpdateStateReadContention,
} from "./update-command-result.js";
import { completeUpdateCommandRun } from "./update-command-run.js";
import {
  readUpdateCommandTerminalRecord,
  type UpdateCommandTerminalRecord,
} from "./update-command-terminal-record.js";

type Run = NonNullable<UpdateCommandOptions["run"]>;
type PublishedRecord = (record: UpdateCommandTerminalRecord["record"]) => void;
type Publisher = (
  failure?: unknown,
  onTerminalRecord?: PublishedRecord,
) => Promise<UpdateRunResult>;
const terminalOwners = new WeakMap<Run, { publish?: Publisher }>();
type PreparedPublisher = (onTerminalRecord?: PublishedRecord) => UpdateRunResult;
type TerminalOptions = Pick<UpdateCommandOptions, "json" | "onResult"> & {
  /** Internal candidate-worker output, never a serialized continuation grant. */
  onTerminalRecord?: PublishedRecord;
};

function unexpectedUpdateFailure(cause: unknown) {
  return { mode: "unknown" as const, durationMs: 0, failure: { cause } };
}

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

/** Prepare under the live executor; the outer owner emits only after its release. */
export function deferUpdateCommandTerminalPreparation(
  run: Run | undefined,
  prepare: (failure?: unknown) => Promise<PreparedPublisher>,
  pendingResult: (cause: unknown) => UpdateRunResult,
): boolean {
  const owner = run && terminalOwners.get(run);
  const fence = run?.executorFence;
  if (!owner || !run || !fence) {
    return false;
  }
  let prepared: PreparedPublisher | undefined;
  let expectedFailure: unknown;
  registerUpdateCommandTerminalPreparation(fence, run.runId, async (failure) => {
    expectedFailure = failure;
    prepared = await prepare(failure);
  });
  // A release/identity failure cannot fall back to reading newer mutable state.
  const pending = (cause: unknown) =>
    new UpdateCommandPendingRecoveryFailure(pendingResult(cause), formatErrorMessage(cause), {
      cause,
    });
  owner.publish = async (failure, onTerminalRecord) => {
    if (!prepared || failure !== expectedFailure) {
      throw pending(failure ?? new Error("Update terminal preparation did not settle."));
    }
    try {
      return prepared(onTerminalRecord);
    } catch (cause) {
      throw pending(cause);
    }
  };
  return true;
}

/** Deliver candidate-owned facts only after the retained parent's executor settles. */
export function deferMigratedUpdateCommandTerminalResult(
  run: Run,
  prepared: Pick<MigratedUpdateFinalizationResult, "result" | "exitCode">,
  stdout: string,
): UpdateCommandFailure | undefined {
  const expectedFailure =
    prepared.exitCode === 0
      ? undefined
      : new UpdateCommandFailure(prepared.result, prepared.exitCode);
  const pending = (cause: unknown) =>
    new UpdateCommandPendingRecoveryFailure(prepared.result, formatErrorMessage(cause), { cause });
  if (
    !deferUpdateCommandTerminalResult(run, async (failure) => {
      // Only the exact candidate failure is expected. Cleanup and release errors
      // must suppress its output without reopening the newer ledger in this parent.
      if (failure !== expectedFailure) {
        throw pending(
          failure === undefined
            ? new Error("Update continuation did not propagate its prepared failure.")
            : failure,
        );
      }
      try {
        if (stdout) {
          process.stdout.write(stdout);
        }
      } catch (cause) {
        throw pending(cause);
      }
      return prepared.result;
    })
  ) {
    throw pending(new Error("Migrated update result has no terminal publication owner."));
  }
  return expectedFailure;
}

export function hasDeferredUpdateCommandTerminalResult(run: Run): boolean {
  return terminalOwners.get(run)?.publish !== undefined;
}

/** Record facts while admitted; publish only when the executor has settled. */
export async function prepareUnexpectedUpdateCommandFailure(
  error: unknown,
  opts: UpdateCommandOptions & { run: Run },
  onPublishedRecord?: PublishedRecord,
): Promise<UpdateCommandFailure> {
  try {
    opts.run.executorFence?.assertCurrent();
  } catch (cause) {
    return new UpdateCommandPendingRecoveryFailure(
      createUpdateCommandFailureResult(unexpectedUpdateFailure(error)),
      formatErrorMessage(cause),
      { cause: error },
    );
  }
  if (error instanceof UnreportedUpdateAdmissionOutcome && opts.run.executorFence) {
    const runId = opts.run.runId;
    // Release failure may suppress the prepared report, but not the original
    // run identity or its refusal facts. Rebuild only captured data here.
    const resultForFailure = (cause: unknown): UpdateRunResult => ({
      ...createPreMutationUpdateResult(resolveUnreportedUpdateAdmissionReport(cause, error), {
        status: cause === error && error.skipped ? "skipped" : "error",
      }),
      runId,
    });
    const result = resultForFailure(error);
    const fence = opts.run.executorFence;
    const failure = new UpdateCommandFailure(
      result,
      error.skipped?.exitCode ?? resolveManagedServiceUpdateFailureExitCode(result),
      error.message,
      { cause: error },
    );
    if (
      !deferUpdateCommandTerminalPreparation(
        opts.run,
        async (settlementFailure) =>
          (
            await prepareUnreportedUpdateAdmissionOutcome(
              // Only the original wrapper represents an ordinary refusal. A
              // later child/cleanup failure must qualify the final report too.
              settlementFailure === failure ? error : settlementFailure,
              opts.run,
              fence.assertCurrent,
            )
          ).publish,
        (cause) => resultForFailure(cause === failure ? error : cause),
      )
    ) {
      return new UpdateCommandPendingRecoveryFailure(result, error.message, { cause: error });
    }
    return failure;
  }
  const failure = unexpectedUpdateFailure(error);
  let fact: UpdateFailureFact;
  try {
    const recorded = failUpdateCommandRun(error, opts.run);
    if (!recorded) {
      throw new Error("Update history remains with its existing recovery owner.");
    }
    fact = recorded;
  } catch (cause) {
    return new UpdateCommandPendingRecoveryFailure(
      createUpdateCommandFailureResult(failure),
      formatErrorMessage(cause),
      { cause: error },
    );
  }
  const result = createUpdateCommandFailureResult({ ...failure, phase: fact.check });
  result.failedStep.failureFacts = [fact];
  const params = { opts, root: result.root ?? "" };
  const prepare = async (settlementFailure?: unknown) => {
    opts.run.executorFence?.assertCurrent();
    const settled = await resolveSettledUpdateCommandResult(params, result, settlementFailure);
    return prepareUpdateCommandTerminalResult(params, settled.result, { rolledBack: false }, () =>
      opts.run.executorFence?.assertCurrent(),
    );
  };
  const publish: Publisher = async (settlementFailure, onTerminalRecord) => {
    const settled = await resolveSettledUpdateCommandResult(params, result, settlementFailure);
    return publishUpdateCommandTerminalResult(params, settled.result, onTerminalRecord);
  };
  const published =
    deferUpdateCommandTerminalPreparation(opts.run, prepare, () => result) ||
    deferUpdateCommandTerminalResult(opts.run, publish)
      ? result
      : await publish(undefined, onPublishedRecord);
  return new UpdateCommandFailure(published, 1, fact.message, { cause: error });
}

/** Enclose the real executor so its final checks and release precede terminal output. */
export async function withUpdateCommandTerminalResult<T>(
  operation: (registerRun: (run: Run) => void) => Promise<T>,
  opts: TerminalOptions = {},
): Promise<T> {
  let run: Run | undefined;
  return await withMutableUpdateTerminalSettlement(async (retain) => {
    try {
      return await settleUpdateCommandTerminalResult(operation, opts, (admitted) => {
        run = admitted;
        retain(admitted);
      });
    } catch (error) {
      if (
        run &&
        !(error instanceof UpdateCommandFinalizedRecoveryFailure) &&
        (error instanceof UpdateCommandPendingRecoveryFailure ||
          hasCommandProcessCleanupError(error))
      ) {
        const input =
          error instanceof UpdateCommandFailure
            ? error.result
            : createUpdateCommandFailureResult(unexpectedUpdateFailure(error));
        const result = recordMutableUpdateInterruption({ run }, input);
        if (result !== input || result.reason === "interrupted") {
          // Uncertain writers prohibit state reads and recovery, not a detached failure report.
          await printResult(
            result,
            { ...opts, run },
            {
              readHistory: false,
              nextAction:
                "Run openclaw update status, then openclaw update repair to inspect retained recovery.",
            },
          );
          throw new UpdateCommandFinalizedRecoveryFailure(result, 1, undefined, { cause: error });
        }
      }
      throw error;
    }
  });
}

async function settleUpdateCommandTerminalResult<T>(
  operation: (registerRun: (run: Run) => void) => Promise<T>,
  opts: TerminalOptions,
  retain: (run: Run) => void,
): Promise<T> {
  const owner: { publish?: Publisher } = {};
  let run: Run | undefined;
  const notifyResult = (result: UpdateRunResult) => {
    try {
      opts.onResult?.(result);
    } catch (cause) {
      // An observer cannot replace or redeliver the terminal owner's outcome.
      defaultRuntime.error(
        `Warning: Update result observer failed: ${createUpdateErrorFact("update", cause, run?.env).message}`,
      );
    }
  };
  let registrationOpen = true;
  const registerRun = (admitted: Run) => {
    if (!registrationOpen || run || terminalOwners.has(admitted)) {
      throw new Error("Update terminal publication already has an owner or has settled.");
    }
    run = admitted;
    terminalOwners.set(admitted, owner);
    retain(admitted);
  };
  let outcome: { value: T } | { error: unknown };
  try {
    outcome = { value: await operation(registerRun) };
  } catch (error) {
    outcome = { error };
  } finally {
    registrationOpen = false;
    if (run) {
      terminalOwners.delete(run);
    }
  }
  if ("error" in outcome && hasCommandProcessCleanupError(outcome.error)) {
    throw outcome.error;
  }
  await run?.sourceArtifactLock?.release().catch((error: unknown) => {
    defaultRuntime.error(`Warning: Artifact lock release failed: ${formatErrorMessage(error)}`);
  });
  const activationTimeout =
    "error" in outcome
      ? collectNestedErrorCandidates(outcome.error).find(
          (error) => error instanceof UpdateActivationTimeoutError,
        )
      : undefined;
  const admissionOutcome =
    "error" in outcome && outcome.error instanceof UnreportedUpdateAdmissionOutcome
      ? outcome.error
      : undefined;
  if (
    run?.executorFence &&
    !owner.publish &&
    "error" in outcome &&
    (activationTimeout || admissionOutcome)
  ) {
    // Cancellation custody is not mutation authority, even while a child keeps
    // the lease retained. Unprepared admitted failures report captured facts only.
    const result: UpdateRunResult = activationTimeout
      ? {
          status: "error",
          reason: activationTimeout.reason,
          mode: "unknown",
          root: activationTimeout.root,
          runId: run.runId,
          steps: [],
          durationMs: activationTimeout.timeoutMs,
        }
      : createPreMutationUpdateResult(admissionOutcome!.report, { status: "error" });
    throw new UpdateCommandPendingRecoveryFailure(result, formatErrorMessage(outcome.error), {
      cause: outcome.error,
    });
  }
  if (run && activationTimeout && !owner.publish) {
    const admittedRun = run;
    owner.publish = async (failure) => {
      const params = { opts: { ...opts, run: admittedRun }, root: activationTimeout.root };
      const { result } = await resolveSettledUpdateCommandResult(
        params,
        {
          status: "error",
          mode: "unknown",
          root: activationTimeout.root,
          steps: [],
          durationMs: activationTimeout.timeoutMs,
        },
        failure,
      );
      return publishUpdateCommandTerminalResult(params, result);
    };
  }
  if (
    run &&
    "error" in outcome &&
    outcome.error instanceof UnreportedUpdateAdmissionOutcome &&
    !owner.publish
  ) {
    const admittedRun = run;
    const admission = outcome.error;
    owner.publish = async () => {
      await assertUpdateRecoveryAdmission({ env: admittedRun.env });
      return (await publishUnreportedUpdateAdmissionOutcome(admission, admittedRun)).result;
    };
  }
  if (owner.publish) {
    let published: UpdateRunResult | undefined;
    try {
      published = await owner.publish(
        "error" in outcome ? outcome.error : undefined,
        opts.onTerminalRecord,
      );
    } catch (error) {
      // A recovery publisher already owns its result and settlement exception.
      if (
        collectNestedErrorCandidates(error).some((cause) => cause instanceof UpdateCommandFailure)
      ) {
        throw error;
      }
      if (run && getUpdateRun(run.runId, { env: run.env })?.status === "succeeded") {
        defaultRuntime.error(
          `Warning: Update succeeded, but result publication failed: ${createUpdateErrorFact("update", error, run.env).message}`,
        );
        return exitCliAfterOutput(defaultRuntime, 0);
      }
      outcome = {
        error:
          "error" in outcome && outcome.error !== error
            ? new AggregateError([outcome.error, error], "Update result publication failed", {
                cause: error,
              })
            : error,
      };
    }
    if (published) {
      notifyResult(published);
    }
    if (published && "error" in outcome) {
      const failure = outcome.error;
      if (
        failure instanceof UpdateCommandPendingRecoveryFailure ||
        failure instanceof UpdateCommandRecoveryPendingError ||
        activationTimeout
      ) {
        // Publication does not restore authority for outer failure triage.
        throw new UpdateCommandFinalizedRecoveryFailure(published);
      }
      // This report has already been printed. Do not let pending-recovery triage
      // print it a second time or launch recovery using a now-released fence.
      throw new UpdateCommandFailure(
        published,
        failure instanceof UpdateCommandFailure
          ? failure.exitCode
          : failure instanceof UnreportedUpdateAdmissionOutcome
            ? (failure.skipped?.exitCode ?? resolveManagedServiceUpdateFailureExitCode(published))
            : 1,
        formatErrorMessage(failure),
        {
          cause: failure,
        },
      );
    }
  }
  // Executor and artifact cleanup have settled; a reported exit is not a new failure report.
  if ("error" in outcome && outcome.error instanceof ExitError) {
    throw outcome.error;
  }
  if (run && "error" in outcome && !(outcome.error instanceof UpdateCommandFailure)) {
    const error = outcome.error;
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    const causes = collectNestedErrorCandidates(error);
    const primaryFailure = causes.find((cause) => cause instanceof UpdateCommandFailure);
    const admission = causes.find((cause) => cause instanceof UnreportedUpdateAdmissionOutcome);
    let failure: UpdateCommandFailure;
    try {
      if (
        run.executorFence ||
        primaryFailure ||
        admission ||
        causes.some(
          (cause) =>
            cause instanceof UpdateCommandRecoveryPendingError ||
            cause instanceof UpdateRecoveryRequiredError,
        )
      ) {
        throw error;
      }
      // Only pre-admission failures have no retained executor. An admitted run
      // must prepare diagnostics before release, never reacquire them here.
      await assertUpdateRecoveryAdmission({ env: run.env });
      failure = await prepareUnexpectedUpdateCommandFailure(
        error,
        { ...opts, run },
        opts.onTerminalRecord,
      );
    } catch (cause) {
      // A wrapped refusal permits reporting, never completion of the retained run.
      const admissionReport =
        !primaryFailure && admission
          ? resolveUnreportedUpdateAdmissionReport(error, admission)
          : undefined;
      const admissionResult = admissionReport
        ? {
            ...createPreMutationUpdateResult(
              { ...admissionReport, opts: { ...admissionReport.opts, run } },
              { status: "error" },
            ),
            runId: run.runId,
          }
        : undefined;
      throw new UpdateCommandPendingRecoveryFailure(
        primaryFailure?.result ??
          admissionResult ??
          createUpdateCommandFailureResult(unexpectedUpdateFailure(error)),
        admissionReport?.nextAction ?? admissionReport?.message ?? formatErrorMessage(cause),
        { cause: error },
      );
    }
    if (!(failure instanceof UpdateCommandPendingRecoveryFailure)) {
      notifyResult(failure.result);
    }
    throw failure;
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
  captured?: UpdateCommandTerminalRecord,
): Promise<{
  result: UpdateRunResult;
  settlementFailed: boolean;
  captured?: UpdateCommandTerminalRecord;
}> {
  const settlementFailed =
    failure !== undefined &&
    (!(failure instanceof UpdateCommandFailure) ||
      failure instanceof UpdateCommandPendingRecoveryFailure);
  const activationTimeout = collectNestedErrorCandidates(failure).find(
    (error) => error instanceof UpdateActivationTimeoutError,
  );
  const failedStep: UpdateStepResult | undefined = settlementFailed
    ? {
        name: "update-executor-settlement",
        command: "openclaw update",
        cwd: pendingResult.root ?? params.root,
        durationMs: 0,
        exitCode: 1,
        stderrTail: activationTimeout?.message ?? formatErrorMessage(failure),
      }
    : undefined;
  const version = pendingResult.after?.version?.trim();
  const recovery: UpdateRunResult["recovery"] =
    pendingResult.recovery ?? (version ? { serviceRestartSafe: true, version } : undefined);
  const result: UpdateRunResult = failedStep
    ? {
        ...pendingResult,
        status: "error",
        reason: activationTimeout?.reason ?? "update-executor-settlement-failed",
        recovery: isUpdateStateReadContention(failure) ? recovery : undefined,
        failedStep,
        steps: [...pendingResult.steps, failedStep],
      }
    : failure instanceof UpdateCommandFailure
      ? failure.result
      : pendingResult;
  // The mutation owner is now closed. This is diagnostic publication only,
  // never authority to reopen displaced state or replace another terminal row.
  try {
    if (failure === undefined && captured) {
      readUpdateCommandTerminalRecord(params, result, captured);
      return { result, settlementFailed, captured };
    }
    const env = params.ownedManagedUpdateEnv ?? params.opts.run?.env;
    // Keep the first target stable if selectors change during admission.
    const targetPath = resolveOpenClawStateSqlitePath(env);
    await withUpdateStateRead(
      async () => {
        await assertUpdateRecoveryAdmission({ env, path: targetPath });
        if (params.opts.run) {
          if (resolveOpenClawStateSqlitePath(params.opts.run.env) !== targetPath) {
            await assertUpdateRecoveryAdmission({ env: params.opts.run.env });
          }
          const prior = getUpdateRun(params.opts.run.runId, { env: params.opts.run.env });
          if (prior && prior.status !== "running" && settlementFailed) {
            throw new Error("Update history was already finalized by another owner.");
          }
        }
      },
      params.opts.run?.deadline?.remainingMs() ?? params.opts.run?.defaultStepTimeoutMs ?? 0,
    );
  } catch (cause) {
    throw new UpdateCommandPendingRecoveryFailure(result, formatErrorMessage(cause), { cause });
  }
  return { result, settlementFailed };
}

/** Share verified retirement and unverified recovery retention across finalizers. */
export async function recordUpdatePackageCompletion(
  params: Pick<FinishUpdateParams, "packageTransaction" | "databaseBackup" | "root" | "opts">,
  result: UpdateRunResult,
  assertCurrent: () => void,
): Promise<UpdateCommandFailure | void> {
  const transaction = params.packageTransaction;
  if (!transaction) {
    return;
  }
  if (
    isUpdateGatewayReadinessPending(result) ||
    (result.status === "ok" &&
      params.opts.run?.completionOwner === "gateway-restart" &&
      params.opts.run.gatewayRestartRequired === true)
  ) {
    assertCurrent();
    const message = `Gateway readiness is pending; backup retirement deferred for ${transaction.backupRoot}. Verify readiness before cleanup.`;
    result.steps.push({
      name: "package-backup-retention",
      command: "openclaw update",
      cwd: result.root ?? params.root,
      durationMs: 0,
      exitCode: 0,
      advisory: { kind: "recoverable-maintenance", message },
    });
    defaultRuntime.error(message);
    return;
  }
  let cleanupFailure: unknown;
  // Progress goes to the human channel only; --json owns stdout and records the
  // retention outcome as a step, so this line must not leak into machine output.
  if (!params.opts.json) {
    defaultRuntime.log("Finishing update: checking package backup retention and cleanup.");
  }
  // Doctor can revoke restoration after capture. Both local and migrated
  // finalization retire the retained parent's transaction through this boundary.
  if (params.databaseBackup?.restoreRefusal) {
    transaction.databaseBackupRoot = undefined;
  }
  const retained: UpdateStepResult | void = await transaction
    .complete({ activationVerified: result.status === "ok" }, assertCurrent)
    .catch((error: unknown) => {
      assertCurrent();
      if (error instanceof UpdateCommandPendingRecoveryFailure) {
        throw error;
      }
      cleanupFailure = error;
      return {
        name: "package-backup-retention",
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
  const step = { ...retained, stderrTail: retained.stderrTail };
  if (step.exitCode !== 0) {
    const recoveryPath = `Recovery transaction backup path: ${transaction.backupRoot}`;
    if (!step.advisory) {
      step.warnings = [...(step.warnings ?? []), recoveryPath];
    }
    if (!step.stderrTail?.includes(transaction.backupRoot)) {
      step.stderrTail = [step.stderrTail, recoveryPath].filter(Boolean).join("\n");
    }
  }
  result.steps = [...result.steps, step];
  if (result.status !== "ok" && !result.recovery?.packageRollbackVerified) {
    defaultRuntime.error(step.stderrTail);
    return;
  }
  if (step.exitCode !== 0 && step.advisory?.kind !== "recoverable-maintenance") {
    // A caller's successful activation does not establish recovery/cleanup safety.
    // Unknown exceptions and unqualified completion refusals must fail the command.
    return new UpdateCommandFailure(
      { ...result, status: "error", reason: "package-backup-retention-failed", failedStep: step },
      1,
      step.stderrTail ?? "Package backup completion was not verified.",
      { cause: cleanupFailure },
    );
  }
}

/** Write the terminal ledger and its visible result together after settlement. */
async function publishUpdateCommandTerminalResult(
  params: Pick<FinishUpdateParams, "opts" | "coreAlreadyCurrent" | "ownedManagedUpdateEnv">,
  input: UpdateRunResult,
  onTerminalRecord?: PublishedRecord,
): Promise<UpdateRunResult> {
  const prepared = await prepareUpdateCommandTerminalResult(params, input, { rolledBack: false });
  return prepared(onTerminalRecord);
}

/** All state/report effects precede release; the returned closure only emits captured facts. */
export async function prepareUpdateCommandTerminalResult(
  params: Pick<FinishUpdateParams, "opts" | "coreAlreadyCurrent" | "ownedManagedUpdateEnv">,
  input: UpdateRunResult,
  outcome: {
    rolledBack: boolean;
    downtimeMs?: number;
    captured?: UpdateCommandTerminalRecord;
  },
  assertCurrent?: () => void,
): Promise<PreparedPublisher> {
  assertCurrent?.();
  const readCaptured = () => {
    try {
      return outcome.captured
        ? readUpdateCommandTerminalRecord(params, input, outcome.captured)
        : undefined;
    } catch (cause) {
      throw new UpdateCommandPendingRecoveryFailure(input, formatErrorMessage(cause), { cause });
    }
  };
  const record = readCaptured();
  const nextAction = recordUpdateResultNextAction(params, input, record);
  const result = record
    ? { ...input, runId: record.runId }
    : completeUpdateCommandRun(input, params.opts.run, outcome);
  const emit = await prepareResult(result, params.opts, { nextAction, record }, assertCurrent);
  assertCurrent?.();
  return (onTerminalRecord) => {
    if (outcome.captured) {
      readCaptured();
    }
    emit();
    if (record) {
      onTerminalRecord?.(record);
    }
    return result;
  };
}
