import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readPackageVersion } from "../../infra/package-json.js";
import { resolveManagedServiceUpdateFailureExitCode } from "../../infra/update-control-plane-sentinel.js";
import { normalizeUpdateFailureFacts } from "../../infra/update-failure-facts.js";
import { verifyPackageUpdateRecovery } from "../../infra/update-global.js";
import { getUpdateRun, recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import { readCurrentGitUpdateRecovery } from "../../infra/update-runner-git-recovery.js";
import type { UpdateRunResult, UpdateStepResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { exitCliAfterOutput } from "../one-shot-exit.js";
import { printResult } from "./progress.js";
import type { UpdateCommandOptions } from "./shared.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import {
  recordUpdateResultNextAction,
  UnreportedUpdateAdmissionOutcome,
  type UpdateAdmissionReportParams,
  UpdateCommandFailure,
  UpdateCommandFinalizedRecoveryFailure,
  UpdateCommandPendingRecoveryFailure,
  writeControlPlaneUpdateRestartSentinelBestEffort,
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
  operation: (registerRun: (run: Run) => void) => Promise<T>,
): Promise<T> {
  const owner: { publish?: Publisher } = {};
  let run: Run | undefined;
  let registrationOpen = true;
  const registerRun = (admitted: Run) => {
    if (!registrationOpen || run || terminalOwners.has(admitted)) {
      throw new Error("Update terminal publication already has an owner or has settled.");
    }
    run = admitted;
    terminalOwners.set(admitted, owner);
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
    const env = params.ownedManagedUpdateEnv ?? params.opts.run?.env;
    // Keep the first target stable if selectors change during admission.
    const targetPath = resolveOpenClawStateSqlitePath(env);
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

export async function reportUnreportedUpdateAdmissionOutcome(error: unknown): Promise<never> {
  const candidates = collectNestedErrorCandidates(error);
  const outcome = candidates.find(
    (candidate): candidate is UnreportedUpdateAdmissionOutcome =>
      candidate instanceof UnreportedUpdateAdmissionOutcome,
  );
  if (!outcome) {
    throw error;
  }
  const cleanupFailed = error !== outcome;
  const params = cleanupFailed
    ? {
        ...outcome.report,
        reason: "update-admission-cleanup-failed",
        message: candidates
          .filter((candidate): candidate is Error => candidate instanceof Error)
          .slice(0, 8)
          .map((candidate) => formatErrorMessage(candidate).slice(0, 2_000))
          .join("\n"),
      }
    : outcome.report;
  const result = await publishPreMutationUpdateOutcome(params, async () => ({
    status: !cleanupFailed && outcome.skipped ? "skipped" : "error",
    ...(cleanupFailed
      ? { recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" } }
      : {}),
  }));
  if (!cleanupFailed && outcome.skipped) {
    return exitCliAfterOutput(defaultRuntime, outcome.skipped.exitCode);
  }
  return exitCliAfterOutput(
    defaultRuntime,
    cleanupFailed ? 1 : resolveManagedServiceUpdateFailureExitCode(result),
  );
}

export async function reportPreMutationUpdateResult(
  params: UpdateAdmissionReportParams & { status?: "error" | "skipped" },
): Promise<never> {
  const result = await publishPreMutationUpdateOutcome(params, async () => ({
    status: params.status ?? "error",
    ...(params.opts.dryRun !== true && params.status !== "skipped"
      ? {
          recovery: await (params.installKind === "git"
            ? readCurrentGitUpdateRecovery(params.root)
            : verifyPackageUpdateRecovery(params.root)),
        }
      : {}),
  }));
  throw new UpdateCommandFailure(
    result,
    params.status === "skipped" ? 0 : resolveManagedServiceUpdateFailureExitCode(result),
    params.message,
  );
}

async function publishPreMutationUpdateOutcome(
  params: UpdateAdmissionReportParams,
  prepareOutcome: () => Promise<Pick<UpdateRunResult, "status" | "recovery">>,
): Promise<UpdateRunResult> {
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
  const outcome = await prepareOutcome();
  const result = completeUpdateCommandRun(
    {
      ...outcome,
      mode: params.installKind === "git" ? "git" : "unknown",
      root: params.root,
      reason: params.reason,
      steps:
        outcome.status === "error"
          ? [
              {
                name: params.reason,
                command: "openclaw update",
                cwd: params.root,
                durationMs: 0,
                exitCode: 1,
                failureFacts: normalizeUpdateFailureFacts(
                  params.failureFacts ?? [
                    { check: params.reason, code: params.reason, message: params.message },
                  ],
                  run?.env,
                ),
              },
            ]
          : [],
      ...(outcome.status === "skipped"
        ? { before: { version: await readPackageVersion(params.root) } }
        : {}),
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
  return result;
}

/** Write the terminal ledger and its visible result together after settlement. */
export function publishUpdateCommandTerminalResult(
  params: Pick<FinishUpdateParams, "opts" | "coreAlreadyCurrent" | "ownedManagedUpdateEnv">,
  input: UpdateRunResult,
  outcome: { rolledBack: boolean; downtimeMs?: number },
): UpdateRunResult {
  const nextAction = recordUpdateResultNextAction(params, input);
  const result = completeUpdateCommandRun(input, params.opts.run, outcome);
  printResult(result, params.opts, { nextAction });
  return result;
}
