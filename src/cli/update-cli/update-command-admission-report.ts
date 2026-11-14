import { theme } from "../../../packages/terminal-core/src/theme.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readPackageVersion } from "../../infra/package-json.js";
import { tryProcessCwd } from "../../infra/safe-cwd.js";
import { resolveManagedServiceUpdateFailureExitCode } from "../../infra/update-control-plane-sentinel.js";
import { verifyPackageUpdateRecovery } from "../../infra/update-global.js";
import { UpdateRunAdmissionBusyError } from "../../infra/update-run-admission.js";
import { getUpdateRun, recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import { readCurrentGitUpdateRecovery } from "../../infra/update-runner-git-recovery.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { SystemPackageOwnershipError } from "../../infra/update-system-package-ownership.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { defaultRuntime } from "../../runtime.js";
import { exitCliAfterOutput } from "../one-shot-exit.js";
import { prepareResult, printResult } from "./progress.js";
import {
  parseUpdateTimeoutMs,
  UpdatePreMutationError,
  type UpdateCommandOptions,
} from "./shared.js";
import { resolveUpdateOwnershipFailure } from "./update-command-config-failure.js";
import { readUpdateDatabaseEngineConfig } from "./update-command-database-engine.js";
import {
  createPreMutationUpdateResult,
  createUpdateCommandFailureResult,
  reportUpdateCommandPendingRecovery,
  UnreportedUpdateAdmissionOutcome,
  type UpdateAdmissionReportParams,
  UpdateCommandFailure,
  UpdateCommandPendingRecoveryFailure,
  writeControlPlaneUpdateRestartSentinelBestEffort,
} from "./update-command-result.js";
import { completeUpdateCommandRun } from "./update-command-run.js";
import { resolveServiceRefreshEnv } from "./update-command-service-env.js";
import { GatewayServiceUpdateOwnershipError } from "./update-command-service-plan.js";

type Run = NonNullable<UpdateCommandOptions["run"]>;

/** Report rejected read-only admission without creating a run or recovery diagnostics. */
export async function withUpdateAdmissionReporting<T>(
  opts: UpdateCommandOptions,
  admit: () => Promise<T>,
  mode: "unknown" | "finalize" = "unknown",
  reportHints: NonNullable<Parameters<typeof reportUpdateCommandPendingRecovery>[2]> = {},
): Promise<T> {
  const startedAt = Date.now();
  const sourceEnv =
    opts.dryRun && reportHints.writeArtifacts === undefined
      ? resolveServiceRefreshEnv(process.env, tryProcessCwd())
      : undefined;
  const resolveReportHints = async () => {
    if (reportHints.writeArtifacts !== undefined || !sourceEnv) {
      return reportHints;
    }
    try {
      const { readFailed, sourceInvalid } = await readUpdateDatabaseEngineConfig(sourceEnv);
      return { ...reportHints, writeArtifacts: readFailed || !sourceInvalid };
    } catch {
      // Source diagnostics must not replace the original admission refusal.
      return reportHints;
    }
  };
  try {
    return await admit();
  } catch (error) {
    if (
      error instanceof UpdateRunAdmissionBusyError ||
      (error instanceof SystemPackageOwnershipError && error.owned)
    ) {
      const result = {
        status: "skipped",
        mode,
        reason: error.reason,
        steps: [],
        durationMs: Date.now() - startedAt,
        ...(opts.dryRun ? { dryRun: true } : {}),
        notes: [error.message],
      };
      if (opts.json) {
        defaultRuntime.writeJson(result);
      } else {
        defaultRuntime.log(theme.warn(error.message));
      }
      // Existing parents treat zero as completed convergence, even without reading JSON.
      return exitCliAfterOutput(defaultRuntime, result.mode === "finalize" ? 1 : 0);
    }
    if (error instanceof UpdateCommandPendingRecoveryFailure) {
      return reportUpdateCommandPendingRecovery(error, opts, await resolveReportHints());
    }
    const ownershipFailure = !hasCommandProcessCleanupError(error)
      ? resolveUpdateOwnershipFailure(error)
      : undefined;
    if (
      !(error instanceof GatewayServiceUpdateOwnershipError) &&
      !(error instanceof SystemPackageOwnershipError) &&
      !(
        error instanceof UpdatePreMutationError &&
        (error.reason === "config-read-failed" || error.reason === "invalid-config")
      ) &&
      !ownershipFailure
    ) {
      throw error;
    }
    const message =
      ownershipFailure?.message ??
      (error instanceof SystemPackageOwnershipError || error instanceof UpdatePreMutationError
        ? error.message
        : error instanceof GatewayServiceUpdateOwnershipError
          ? `${error.message} Run \`openclaw gateway status --deep\` from the service's owning account before retrying.`
          : undefined);
    if (opts.json) {
      defaultRuntime.error(message);
    }
    await printResult(
      createUpdateCommandFailureResult({
        mode: "unknown",
        admission: true,
        failure: { cause: error },
        durationMs: 0,
      }),
      opts,
      {
        ...(await resolveReportHints()),
        readHistory: false,
        nextAction:
          ownershipFailure?.nextAction ??
          (error instanceof UpdatePreMutationError ? (error.nextAction ?? message) : message),
      },
    );
    return exitCliAfterOutput(defaultRuntime, 1);
  }
}

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
  const malformedPreview = params.opts.dryRun === true && params.malformedPreview === true;
  const run = detached || malformedPreview ? undefined : params.opts.run;
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
      run,
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
        {
          nextAction,
          ...(detached || malformedPreview ? { readHistory: false } : {}),
          ...(malformedPreview ? { writeArtifacts: false } : {}),
        },
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
