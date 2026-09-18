// Update failures and control-plane results share one reporting boundary.
import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import type { TriageFailureContext } from "../../commands/triage-prompt.js";
import { isAbortError } from "../../infra/abort-signal.js";
import {
  attachErrorDiagnostic,
  formatErrorMessageForDisplay,
} from "../../infra/error-diagnostics.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { formatErrorMessage, formatUncaughtError } from "../../infra/errors.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-steps.js";
import { isSqliteLockError } from "../../infra/sqlite-error-diagnostics.js";
import type { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import {
  markControlPlaneUpdateRestartSentinelFailure,
  writeControlPlaneUpdateRestartSentinel,
  type ControlPlaneUpdateSentinelMetaFile,
} from "../../infra/update-control-plane-sentinel.js";
import {
  createUpdateErrorFact,
  createUpdateFailureFact,
  type UpdateFailureFact,
} from "../../infra/update-failure-facts.js";
import { FreeBsdPkgOwnershipError } from "../../infra/update-freebsd-pkg-ownership.js";
import { UpdateRequesterRevokedError } from "../../infra/update-requester-authority.js";
import { UpdateRunAdmissionBusyError } from "../../infra/update-run-admission.js";
import { getUpdateRun, recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import type { UpdateRunResult, UpdateStepResult } from "../../infra/update-runner.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { defaultRuntime } from "../../runtime.js";
import type { UpdateRecoveryStep } from "../../shared/update-outcome.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { formatCliCommand } from "../command-format.js";
import { exitCliAfterOutput } from "../one-shot-exit.js";
import { printResult } from "./progress.js";
import { UpdatePreMutationError, type UpdateCommandOptions } from "./shared.js";
import type { UpdateConfigSnapshot } from "./update-command-config-snapshot.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import type { OwnedManagedUpdateContext } from "./update-command-managed-context.js";
import type {
  ManagedGatewayUpdateVerdict,
  PreManagedServiceStop,
  UpdateRestartParams,
} from "./update-command-service-context-types.js";
import { GatewayServiceUpdateOwnershipError } from "./update-command-service-plan.js";
import { resolveUpdateResultNextAction } from "./update-recovery-guidance.js";

export function collectServiceInspectionFailureFacts(
  verdict: ManagedGatewayUpdateVerdict | undefined,
): UpdateFailureFact[] | undefined {
  return verdict?.kind === "unavailable"
    ? [
        createUpdateFailureFact({
          check: "managed-service",
          code: verdict.inspectionReason ?? "service-inspection-unavailable",
          message: verdict.message,
        }),
      ]
    : undefined;
}

export function recordServiceReconciliationWarning(
  result: UpdateRunResult,
  env: NodeJS.ProcessEnv,
  message: string,
): void {
  defaultRuntime.error(message);
  result.steps.push({
    name: "managed-service-reconciliation",
    command: formatCliCommand("openclaw gateway install --force", env),
    cwd: result.root ?? "",
    durationMs: 0,
    exitCode: 0,
    advisory: { kind: "recoverable-maintenance", message },
  });
}

export function prepareUpdateServiceResult(
  params: Pick<
    UpdateRestartParams,
    "result" | "root" | "preManagedServiceStop" | "shouldRestart"
  > & {
    coreAlreadyCurrent?: boolean;
  },
): boolean {
  const verdict = params.preManagedServiceStop?.serviceUpdateVerdict;
  const serviceEnv = params.preManagedServiceStop?.serviceEnv ?? process.env;
  if (verdict?.kind === "unavailable") {
    params.result.steps.push({
      name: "managed-service",
      command: formatCliCommand("openclaw gateway status --deep", serviceEnv),
      cwd: params.root,
      durationMs: 0,
      exitCode: 0,
      advisory: { kind: "recoverable-maintenance", message: verdict.message },
      failureFacts: collectServiceInspectionFailureFacts(verdict),
    });
  }
  const shouldRestart =
    params.shouldRestart &&
    (!params.coreAlreadyCurrent || params.preManagedServiceStop?.running === true);
  if (verdict?.kind === "owned" && verdict.requiresInstallRootRefresh && !shouldRestart) {
    recordServiceReconciliationWarning(
      params.result,
      serviceEnv,
      `Gateway service still targets ${verdict.root}; the active installation is ${params.result.root ?? params.root}. ` +
        `Service reconciliation was skipped because restart is disabled or the service is stopped. Run \`${formatCliCommand("openclaw doctor --fix", serviceEnv)}\` to apply the installation change.`,
    );
  }
  return shouldRestart;
}

/** Terminal worker diagnostics do not participate in recovery decisions. */
export function formatUpdateFinalizationError(error: unknown): string {
  const contention = collectNestedErrorCandidates(error).find(isSqliteLockError);
  if (error && typeof error === "object" && contention instanceof Error) {
    // The worker has already unwound ownership. Retain the actual causal site
    // through aggregate wrappers without changing policy-bearing error fields.
    attachErrorDiagnostic(
      error,
      `SQLite contention call site:\n${formatUncaughtError(contention)}`,
    );
  }
  return formatErrorMessageForDisplay(error);
}

export type MutableUpdateExecutionResult = {
  mutationStarted: boolean;
  result: UpdateRunResult;
  failure?: { cause: unknown; detail: string };
  preManagedServiceStop: PreManagedServiceStop | undefined;
  ownedManagedUpdateContext: OwnedManagedUpdateContext | undefined;
  recoveryEnv: NodeJS.ProcessEnv | undefined;
  packageTransaction?: PackageUpdateTransaction;
  schemaVersions?: Awaited<ReturnType<typeof readUpdateStateSchemaVersions>>;
  candidateSchemaVersions?: OpenClawSchemaVersions;
  previousSchemaVersions?: OpenClawSchemaVersions;
  previousVerified?: boolean;
  activationConfig?: UpdateConfigSnapshot;
};

function createUpdateCommandFailureResult(
  params: Pick<UpdateRunResult, "mode" | "root" | "recovery" | "durationMs"> & {
    failure: { cause: unknown; detail?: string };
    admission?: true;
    phase?: string;
  },
): UpdateRunResult {
  const { failure, admission, phase, ...result } = params;
  const { cause, detail } = failure;
  const preMutationFailure = cause instanceof UpdatePreMutationError;
  const pkgOwnershipFailure = cause instanceof FreeBsdPkgOwnershipError;
  const admissionFailure =
    admission === true && cause instanceof GatewayServiceUpdateOwnershipError;
  const reason =
    cause instanceof UpdateRequesterRevokedError
      ? cause.code
      : preMutationFailure || pkgOwnershipFailure
        ? cause.reason
        : admissionFailure
          ? "managed-service-preflight"
          : "update-failed";
  const failedStep: UpdateStepResult = {
    name:
      preMutationFailure || pkgOwnershipFailure || admissionFailure ? reason : (phase ?? "update"),
    command: "openclaw update",
    cwd: result.root ?? process.cwd(),
    durationMs: result.durationMs,
    exitCode: 1,
    ...(isAbortError(cause) ? { termination: "signal" as const } : {}),
    ...(detail !== undefined ? { stderrTail: detail } : {}),
    ...(preMutationFailure && cause.recoverySteps ? { recoverySteps: cause.recoverySteps } : {}),
    // Recorded diagnostics do not change post-mutation recovery eligibility.
    failureFacts:
      preMutationFailure || cause instanceof GatewayServiceUpdateOwnershipError
        ? cause.failureFacts
        : [createUpdateErrorFact(phase ?? "update", cause)],
  };
  return { ...result, status: "error", reason, failedStep, steps: [failedStep] };
}

/** Mutable exceptions cannot authorize recovery while command cleanup is unknown. */
export async function resolveMutableUpdateFailure(params: {
  cause: unknown;
  durationMs: number;
  mode: UpdateRunResult["mode"];
  root: string;
  originalRecovery: () => Promise<UpdateRunResult["recovery"]>;
  run?: UpdateCommandOptions["run"];
}): Promise<{ result: UpdateRunResult; failure: { cause: unknown; detail: string } }> {
  if (hasCommandProcessCleanupError(params.cause)) {
    throw params.cause;
  }
  const failure = { cause: params.cause, detail: formatErrorMessage(params.cause) };
  defaultRuntime.error(failure.detail);
  let phase: string | undefined;
  if (params.run) {
    try {
      const current = getUpdateRun(params.run.runId, { env: params.run.env });
      phase =
        current?.steps.findLast((step) => step.status === "in_progress")?.step ?? current?.phase;
    } catch {
      defaultRuntime.error(
        "Warning: Update history could not be read; retaining the original failure without its recorded phase.",
      );
    }
  }
  return {
    failure,
    result: createUpdateCommandFailureResult({
      durationMs: params.durationMs,
      mode: params.mode,
      root: params.root,
      recovery:
        params.cause instanceof UpdatePreMutationError
          ? await params.originalRecovery()
          : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      failure,
      phase,
    }),
  };
}

/** Report rejected read-only admission without creating a run or recovery diagnostics. */
export async function withUpdateAdmissionReporting<T>(
  opts: UpdateCommandOptions,
  admit: () => Promise<T>,
  mode: "unknown" | "finalize" = "unknown",
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await admit();
  } catch (error) {
    if (error instanceof UpdateRunAdmissionBusyError) {
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
      return reportUpdateCommandPendingRecovery(error, opts);
    }
    if (
      !(error instanceof GatewayServiceUpdateOwnershipError) &&
      !(error instanceof FreeBsdPkgOwnershipError)
    ) {
      throw error;
    }
    const message =
      error instanceof FreeBsdPkgOwnershipError
        ? error.message
        : `${error.message} Run \`openclaw gateway status --deep\` from the service's owning account before retrying.`;
    if (opts.json) {
      defaultRuntime.error(message);
    }
    printResult(
      createUpdateCommandFailureResult({
        mode: "unknown",
        admission: true,
        failure: { cause: error },
        durationMs: 0,
      }),
      opts,
      { nextAction: message },
    );
    return exitCliAfterOutput(defaultRuntime, 1);
  }
}

/** Unwind update ownership before diagnostics or an interactive agent can run. */
export class UpdateCommandFailure extends Error {
  readonly automaticTriage?: TriageFailureContext;

  constructor(
    readonly result: UpdateRunResult,
    readonly exitCode = 1,
    readonly detail?: string,
    options?: ErrorOptions & { automaticTriage?: TriageFailureContext },
  ) {
    super(detail ?? result.reason ?? "Update failed", options);
    this.name = "UpdateCommandFailure";
    this.automaticTriage = options?.automaticTriage;
  }
}

/** A conservative pending outcome, never a grant of recovery or mutation authority. */
export class UpdateCommandPendingRecoveryFailure extends UpdateCommandFailure {
  constructor(result: UpdateRunResult, detail?: string, options?: ErrorOptions) {
    super(
      {
        ...result,
        status: "error",
        recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      },
      1,
      detail,
      options,
    );
    this.name = "UpdateCommandPendingRecoveryFailure";
  }
}

export function reportUpdateCommandPendingRecovery(
  error: UpdateCommandPendingRecoveryFailure,
  opts: Pick<UpdateCommandOptions, "json">,
): never {
  // printResult resolves history, which may be part of the retained evidence.
  if (opts.json) {
    defaultRuntime.writeJson(error.result);
  }
  defaultRuntime.error(
    `Update recovery remains pending (${error.result.reason ?? "update-failed"}). Retained state and artifacts were left for the owning updater to reconcile; automatic restart and repair were not attempted.${error.detail ? `\n${error.detail}` : ""}`,
  );
  return exitCliAfterOutput(defaultRuntime, error.exitCode);
}

/** Reporting-only marker: the outcome was recorded and printed; no follow-up triage. */
export class UpdateCommandFinalizedRecoveryFailure extends UpdateCommandFailure {
  constructor(result: UpdateRunResult) {
    super(result, 1);
  }
}

export function mergeWindowsTaskRecoveryFailure(
  failure: { error: unknown } | undefined,
  recoveryError: unknown,
): { error: unknown } {
  if (failure?.error instanceof UpdateCommandFailure) {
    // A rejected restore promise can be observed again during unwinding.
    // Keep the reported failure and never turn cleanup into safe-exit 80.
    return {
      error: new UpdateCommandFailure(
        { ...failure.error.result, status: "error" },
        1,
        `${failure.error.message}; Windows autostart recovery: ${formatErrorMessage(recoveryError)}`,
        { cause: recoveryError, automaticTriage: failure.error.automaticTriage },
      ),
    };
  }
  return {
    error: failure
      ? new AggregateError(
          [failure.error, recoveryError],
          `Update failed (${formatErrorMessage(failure.error)}) and Windows autostart recovery failed (${formatErrorMessage(recoveryError)})`,
          { cause: failure.error },
        )
      : recoveryError,
  };
}

/** The restored package and its running service have both passed verification. */
export function isVerifiedUpdateRollback(result: UpdateRunResult): boolean {
  return (
    result.recovery?.serviceRestartSafe === true &&
    result.recovery.packageRollbackVerified === true &&
    result.recovery.service === "healthy"
  );
}

export function resolveAutomaticUpdateTriage(
  result: UpdateRunResult,
  detail: string | undefined,
  params: {
    mutationStarted: boolean;
    root: string;
    installKindChanged: boolean;
    expectedVersion?: string;
    gateway: TriageFailureContext["gateway"];
    preManagedServiceStop?: Pick<PreManagedServiceStop, "serviceMutationAllowed">;
  },
): TriageFailureContext | undefined {
  // Triage follows a failed update, never a verified rollback: the restored
  // generation is serving, and an autonomous repair turn there is unwanted.
  const eligible =
    !isVerifiedUpdateRollback(result) &&
    (params.mutationStarted || result.reason === "restart-unhealthy") &&
    result.reason !== "service-revalidation-failed" &&
    !(
      result.recovery?.serviceRestartSafe === false &&
      result.recovery.reason === "rollback-checkout-dirty"
    ) &&
    !result.postUpdate?.plugins?.npm.outcomes.some(
      (outcome) => outcome.code === PLUGIN_CAPABILITY_CONSENT_REQUIRED,
    ) &&
    params.preManagedServiceStop?.serviceMutationAllowed !== false &&
    !result.steps.some((step) => step.termination === "signal");
  const failedStep = result.steps.find((step) => step.exitCode !== 0 && !step.advisory);
  const phase = result.reason ?? "update";
  return eligible
    ? {
        kind: "update",
        phase,
        error: detail ?? failedStep?.stderrTail ?? failedStep?.stdoutTail ?? phase,
        // Global exposure, not the candidate checkout, identifies a package-to-Git target.
        installationRoot:
          params.installKindChanged && result.mode === "git"
            ? params.root
            : (result.root ?? params.root),
        expectedVersion: params.expectedVersion ?? result.after?.version ?? undefined,
        gateway: params.gateway,
      }
    : undefined;
}

export type UpdateAdmissionReportParams = {
  mode?: UpdateRunResult["mode"];
  recoverySteps?: readonly UpdateRecoveryStep[];
  failureFacts?: readonly UpdateFailureFact[];
  root: string;
  installKind: "git" | "package" | "unknown";
  reason: string;
  message?: string;
  opts: UpdateCommandOptions;
  controlPlaneUpdateSentinelMeta: ControlPlaneUpdateSentinelMetaFile["meta"] | null;
};

export type RefuseUpdate = (
  reason: string,
  message?: string,
  failureFacts?: readonly UpdateFailureFact[],
  recoverySteps?: readonly UpdateRecoveryStep[],
) => Promise<void>;

/** A fresh admission decision is data until its staging and executor owners settle. */
export class UnreportedUpdateAdmissionOutcome extends Error {
  constructor(
    readonly report: UpdateAdmissionReportParams,
    readonly skipped?: { exitCode: 0 | 1 },
  ) {
    super(report.message ?? report.reason);
    this.name = "UnreportedUpdateAdmissionOutcome";
  }
}

export async function writeControlPlaneUpdateRestartSentinelBestEffort(params: {
  meta: ControlPlaneUpdateSentinelMetaFile["meta"] | null;
  result: UpdateRunResult;
  jsonMode: boolean;
  env: NodeJS.ProcessEnv | undefined;
}): Promise<void> {
  if (!params.meta) {
    return;
  }
  try {
    await writeControlPlaneUpdateRestartSentinel(
      { meta: params.meta, result: params.result },
      params.env,
    );
  } catch (err) {
    const message = `Failed to write update.run restart sentinel: ${String(err)}`;
    if (params.jsonMode) {
      defaultRuntime.error(message);
    } else {
      defaultRuntime.log(theme.warn(message));
    }
  }
}

export async function markControlPlaneUpdateRestartSentinelFailureBestEffort(params: {
  meta: ControlPlaneUpdateSentinelMetaFile["meta"] | null;
  reason: string;
  jsonMode: boolean;
  env: NodeJS.ProcessEnv | undefined;
}): Promise<void> {
  if (!params.meta) {
    return;
  }
  try {
    await markControlPlaneUpdateRestartSentinelFailure(params.reason, params.meta, params.env);
  } catch (err) {
    const message = `Failed to mark update.run restart sentinel failed: ${String(err)}`;
    if (params.jsonMode) {
      defaultRuntime.error(message);
    } else {
      defaultRuntime.log(theme.warn(message));
    }
  }
}

export function recordUpdateResultNextAction(
  params: Pick<FinishUpdateParams, "opts" | "coreAlreadyCurrent" | "ownedManagedUpdateEnv">,
  result: UpdateRunResult,
  committed?: UpdateRunRecord,
) {
  const run = params.opts.run;
  const active = committed ?? (run ? getUpdateRun(run.runId, { env: run.env }) : undefined);
  const nextAction = resolveUpdateResultNextAction({
    result,
    restart: params.coreAlreadyCurrent ? params.opts.restart : undefined,
    serviceRunning: active?.verification.serviceRunning,
    runningVersion: active?.verification.runningVersion,
    verificationFailure: active?.steps.findLast(
      (step) => step.step === "gateway verification" && step.status === "failed",
    )?.detail,
    env: run?.env ?? params.ownedManagedUpdateEnv ?? process.env,
  });
  if (run && active?.status === "running" && active.origin.nextAction !== nextAction) {
    recordUpdateRunPhase(run.runId, active.phase, { origin: { nextAction } }, { env: run.env });
  }
  return nextAction;
}
