import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readPackageVersion } from "../../infra/package-json.js";
import { resolveManagedServiceUpdateFailureExitCode } from "../../infra/update-control-plane-sentinel.js";
import { verifyPackageUpdateRecovery } from "../../infra/update-global.js";
import { getUpdateRun, recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import { readCurrentGitUpdateRecovery } from "../../infra/update-runner-git-recovery.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { defaultRuntime } from "../../runtime.js";
import { exitCliAfterOutput } from "../one-shot-exit.js";
import { prepareResult } from "./progress.js";
import { parseUpdateTimeoutMs, type UpdateCommandOptions } from "./shared.js";
import {
  createPreMutationUpdateResult,
  UnreportedUpdateAdmissionOutcome,
  type UpdateAdmissionReportParams,
  UpdateCommandFailure,
  writeControlPlaneUpdateRestartSentinelBestEffort,
} from "./update-command-result.js";
import { completeUpdateCommandRun } from "./update-command-run.js";

type Run = NonNullable<UpdateCommandOptions["run"]>;

export function resolveUnreportedUpdateAdmissionReport(
  error: unknown,
  outcome: UnreportedUpdateAdmissionOutcome,
): UpdateAdmissionReportParams {
  if (error === outcome) {
    return outcome.report;
  }
  return {
    ...outcome.report,
    reason: "update-admission-cleanup-failed",
    failureFacts: outcome.report.failureFacts ?? [
      {
        check: outcome.report.reason,
        code: outcome.report.reason,
        message: outcome.report.message,
      },
    ],
    stepResult: outcome.report.stepResult ? { steps: outcome.report.stepResult.steps } : undefined,
    message: collectNestedErrorCandidates(error)
      .filter((candidate) => candidate instanceof Error)
      .slice(0, 8)
      .map((candidate) => formatErrorMessage(candidate).slice(0, 2_000))
      .join("\n"),
  };
}

export async function prepareUnreportedUpdateAdmissionOutcome(
  error: unknown,
  run?: Run,
  assertCurrent?: () => void,
  detached = false,
): Promise<{ result: UpdateRunResult; exitCode: number; publish: () => UpdateRunResult }> {
  const outcome = collectNestedErrorCandidates(error).find(
    (candidate) => candidate instanceof UnreportedUpdateAdmissionOutcome,
  );
  if (!outcome) {
    throw error;
  }
  const cleanupFailed = error !== outcome;
  const params = resolveUnreportedUpdateAdmissionReport(error, outcome);
  const { result, publish } = await preparePreMutationUpdateOutcome(
    {
      ...params,
      ...(run ? { opts: { ...params.opts, run } } : {}),
    },
    async () => ({
      status: !cleanupFailed && outcome.skipped ? "skipped" : "error",
      ...(cleanupFailed
        ? { recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" } }
        : {}),
    }),
    assertCurrent,
    detached,
  );
  const exitCode =
    !cleanupFailed && outcome.skipped
      ? outcome.skipped.exitCode
      : cleanupFailed
        ? 1
        : resolveManagedServiceUpdateFailureExitCode(result);
  return { result, exitCode, publish };
}

export async function publishUnreportedUpdateAdmissionOutcome(
  error: unknown,
  run?: Run,
  detached = false,
): Promise<{ result: UpdateRunResult; exitCode: number }> {
  const { result, exitCode, publish } = await prepareUnreportedUpdateAdmissionOutcome(
    error,
    run,
    undefined,
    detached,
  );
  publish();
  return { result, exitCode };
}

export async function reportUnreportedUpdateAdmissionOutcome(
  error: unknown,
  options: { detached?: boolean } = {},
): Promise<never> {
  const { exitCode } = await publishUnreportedUpdateAdmissionOutcome(
    error,
    undefined,
    options.detached,
  );
  return exitCliAfterOutput(defaultRuntime, exitCode);
}

export async function reportPreMutationUpdateResult(
  params: UpdateAdmissionReportParams & { status?: "error" | "skipped" },
): Promise<never> {
  const result = await publishPreMutationUpdateOutcome(params, async () => ({
    status: params.status ?? "error",
    ...(params.opts.dryRun !== true && params.status !== "skipped"
      ? {
          recovery: await (params.installKind === "git"
            ? readCurrentGitUpdateRecovery(params.root, parseUpdateTimeoutMs(params.opts.timeout))
            : verifyPackageUpdateRecovery(params.root)),
        }
      : {}),
  }));
  if (!params.opts.run && params.opts.dryRun && params.reason === "invalid-dev-target") {
    return exitCliAfterOutput(defaultRuntime, 1);
  }
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
  const prepared = await preparePreMutationUpdateOutcome(params, prepareOutcome);
  return prepared.publish();
}

async function preparePreMutationUpdateOutcome(
  params: UpdateAdmissionReportParams,
  prepareOutcome: () => Promise<Pick<UpdateRunResult, "status" | "recovery">>,
  assertCurrent?: () => void,
  detached = false,
): Promise<{ result: UpdateRunResult; publish: () => UpdateRunResult }> {
  assertCurrent?.();
  // A settled, unregistered admission owns only its captured refusal. Even a
  // nested report's Run is not authority to reopen history or publish a sentinel.
  const run = detached ? undefined : params.opts.run;
  const active = run ? getUpdateRun(run.runId, { env: run.env }) : undefined;
  const nextAction = params.nextAction ?? params.message;
  if (run && active && nextAction) {
    recordUpdateRunPhase(
      run.runId,
      active.phase,
      {
        origin: { nextAction },
        ...(params.installKind !== "unknown" ? { target: { kind: params.installKind } } : {}),
      },
      { env: run.env },
    );
  }
  const outcome = await prepareOutcome();
  assertCurrent?.();
  const before =
    params.before ??
    (!detached && outcome.status === "skipped"
      ? { version: await readPackageVersion(params.root) }
      : undefined);
  assertCurrent?.();
  const captured = createPreMutationUpdateResult({ ...params, before }, outcome, active?.phase);
  const result = completeUpdateCommandRun(captured, run);
  if (!detached && params.opts.dryRun !== true) {
    await writeControlPlaneUpdateRestartSentinelBestEffort({
      meta: params.controlPlaneUpdateSentinelMeta,
      result,
      jsonMode: Boolean(params.opts.json),
      env: run?.env,
    });
    assertCurrent?.();
  }
  // Keep legacy dry-run and text-mode refusals on stderr.
  const stderrOnly =
    (params.opts.dryRun || (params.opts.run && !params.opts.json)) &&
    params.reason === "invalid-dev-target" &&
    params.message;
  const emit = stderrOnly
    ? undefined
    : await prepareResult(
        result,
        params.opts,
        { nextAction, ...(detached ? { readHistory: false } : {}) },
        assertCurrent,
      );
  assertCurrent?.();
  return {
    result,
    publish: () => {
      if (params.message && (stderrOnly || params.opts.json)) {
        defaultRuntime.error(params.message);
      }
      emit?.();
      return result;
    },
  };
}
