import path from "node:path";
import { hashConfigRaw } from "../../config/io.read-helpers.js";
import { resolveConfigPath } from "../../config/paths.js";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import { resolveInstallWorkTimeoutMs } from "../../infra/install-mode-options.js";
import {
  runGlobalPackageUpdateSteps,
  type PackageUpdateTransaction,
} from "../../infra/package-update-steps.js";
import { PackageUpdateActivationError } from "../../infra/package-update-swap-contract.js";
import {
  failedPackageVerificationStep,
  markPackagePostInstallDoctorAdvisory,
} from "../../infra/package-update-verification-step.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import type { UpdateDatabaseBackup } from "../../infra/update-database-backup.js";
import {
  formatUpdateDoctorConfigWriteRefusal,
  getUpdateDoctorConfigFailureReason,
  type UpdateDoctorConfigChange,
} from "../../infra/update-doctor-config.js";
import {
  consumeUpdatePostInstallDoctorResult,
  createUpdatePostInstallDoctorResultPath,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  type UpdatePostInstallDoctorResult,
} from "../../infra/update-doctor-result.js";
import {
  createUpdateFailureFact,
  normalizeUpdateFailureFacts,
} from "../../infra/update-failure-facts.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import {
  createGlobalInstallEnv,
  resolveGlobalInstallSpec,
  resolveGlobalInstallTarget,
  verifyPackageUpdateRecovery,
  type ResolvedGlobalInstallTarget,
} from "../../infra/update-global.js";
import type { UpdateRequester } from "../../infra/update-requester-authority.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { normalizeFallbackFailureReason } from "../../infra/update-runner-command.js";
import {
  buildUpdateDoctorEnv,
  resolveUpdateDoctorExecutionPolicy,
} from "../../infra/update-runner-doctor.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { CLI_NAME } from "../cli-name.js";
import { createUpdateProgress } from "./progress.js";
import {
  DEFAULT_PACKAGE_NAME,
  readPackageName,
  readPackageVersion,
  resolveGlobalManager,
  resolveNodeRunner,
  runUpdateStep,
  UpdatePreMutationError,
} from "./shared.js";
import {
  createUpdateConfigSnapshot,
  readUpdateConfigSnapshot,
  type UpdateConfigSnapshot,
} from "./update-command-config-snapshot.js";
import { recordUpdateDatabaseWrites } from "./update-command-database-receipts.js";
import { withUpdateDoctorChild } from "./update-command-doctor-child.js";
import { resolveUpdateTargetEnv } from "./update-command-service-env.js";
export async function readPackageUpdateIdentity(root: string) {
  const [version, buildId] = await Promise.all([
    readPackageVersion(root),
    readBuiltGatewayBuildId(root),
  ]);
  return { version, ...(buildId ? { buildId } : {}) };
}

type PackageDoctorOptions = {
  root: string;
  timeoutMs?: number;
  workTimeoutMs?: number | null;
  progress: ReturnType<typeof createUpdateProgress>["progress"];
  results?: UpdateStepResult[];
  managedServiceEnv?: NodeJS.ProcessEnv;
  invocationCwd?: string;
  nodeRunner?: string;
  onConfigSnapshot?: (snapshot: UpdateConfigSnapshot) => void;
  getDoctorContext?: () =>
    | {
        runId: string;
        executorFence: UpdateRecoveryFence;
        requester?: Readonly<UpdateRequester>;
        inputHash: string;
        changes: UpdateDoctorConfigChange[];
        databaseBackup?: UpdateDatabaseBackup;
        assertCurrent: () => void;
        assertBoundChildCurrent: () => void;
        onStateHandoff?: () => void;
      }
    | undefined;
};

export function preparePackageDoctorContext(params: {
  capable: boolean;
  runId?: string;
  executorFence?: UpdateRecoveryFence;
  requester?: Readonly<UpdateRequester>;
  inputHash?: string | null;
  changes: UpdateDoctorConfigChange[];
  databaseBackup?: UpdateDatabaseBackup;
  assertCurrent: () => void;
  assertBoundChildCurrent: () => void;
  onStateHandoff?: () => void;
}) {
  params.assertCurrent();
  if (!params.capable) {
    return undefined;
  }
  if (!params.runId || !params.executorFence || params.inputHash === undefined) {
    throw new Error("Validated Doctor requires its live update executor and captured config hash.");
  }
  return {
    runId: params.runId,
    executorFence: params.executorFence,
    requester: params.requester,
    inputHash: params.inputHash ?? hashConfigRaw(null),
    changes: params.changes,
    databaseBackup: params.databaseBackup,
    assertCurrent: params.assertCurrent,
    assertBoundChildCurrent: params.assertBoundChildCurrent,
    onStateHandoff: params.onStateHandoff,
  };
}

export async function runPackageUpdateDoctor(params: PackageDoctorOptions) {
  const context = params.getDoctorContext?.();
  context?.assertCurrent();
  const entryPath = await resolveGatewayInstallEntrypoint(params.root);
  if (!entryPath) {
    return null;
  }
  const doctorEnv = resolveUpdateTargetEnv({
    serviceEnv: params.managedServiceEnv,
    invocationCwd: params.invocationCwd,
  });
  // Backup and Doctor must select the same installation before Doctor can rewrite it.
  await createUpdateConfigSnapshot(doctorEnv);
  const candidateHostVersion = await readPackageVersion(params.root);
  const doctorResultPath = createUpdatePostInstallDoctorResultPath();
  // Service ownership stays with the finalizer while the retained package
  // transaction protects this migration and the later restart verification.
  const doctorPolicy = resolveUpdateDoctorExecutionPolicy({
    targetVersion: candidateHostVersion,
    allowGatewayServiceRepair: false,
  });
  const doctorArgv = [
    params.nodeRunner ?? resolveNodeRunner(),
    ...(context
      ? [
          path.join(
            params.root,
            "dist",
            runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath,
          ),
          "--doctor",
        ]
      : [entryPath, "doctor", "--non-interactive", ...(doctorPolicy.fix ? ["--fix"] : [])]),
  ];
  const doctorProgressInfo = {
    name: `${CLI_NAME} doctor`,
    command: doctorArgv.join(" "),
    index: 0,
    total: 0,
  };
  params.progress?.onStepStart?.(doctorProgressInfo);
  const configSnapshot = params.onConfigSnapshot
    ? await readUpdateConfigSnapshot(resolveConfigPath(doctorEnv))
    : undefined;
  const completeDoctorStep = async (
    doctorStep: UpdateStepResult,
    doctorResult: UpdatePostInstallDoctorResult | null,
    failure?: { error: unknown },
  ) => {
    let completionFailure = failure;
    if (context?.databaseBackup) {
      const receipt = recordUpdateDatabaseWrites(
        context.databaseBackup,
        doctorResult?.databaseWrites,
        doctorStep,
      );
      if (receipt) {
        params.progress?.onStepComplete?.({ ...receipt, index: 0, total: 0 });
      }
    }
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
        params.onConfigSnapshot?.({
          ...configSnapshot,
          hash,
          doctorOwned:
            doctorInputHash === undefined
              ? hash === configSnapshot.hash
              : doctorInputHash === configSnapshot.hash &&
                hash === (doctorHash === "unchanged" ? doctorInputHash : doctorHash),
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
    try {
      params.progress?.onStepComplete?.({
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
    if (completionFailure) {
      throw completionFailure.error;
    }
    return doctorStep;
  };
  const completedSteps: UpdateStepResult[] = [];
  const runDoctor = (runCommand?: Parameters<typeof runUpdateStep>[0]["runCommand"]) =>
    runUpdateStep({
      name: `${CLI_NAME} doctor`,
      results: completedSteps,
      argv: doctorArgv,
      cwd: params.root,
      env: {
        ...doctorEnv,
        ...buildUpdateDoctorEnv({
          allowGatewayServiceRepair: false,
          allowGatewayActivation: false,
          deferConfiguredPluginInstallRepair: true,
          serviceRepairPolicy: doctorPolicy.serviceRepairPolicy,
          compatibilityHostVersion: candidateHostVersion,
        }),
        [UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]: doctorResultPath,
      },
      timeoutMs: resolveInstallWorkTimeoutMs(params.workTimeoutMs, params.timeoutMs),
      ...(runCommand ? { runCommand } : {}),
    });
  let outcome: { step: UpdateStepResult } | { error: unknown };
  try {
    outcome = {
      step: context
        ? await withUpdateDoctorChild(
            {
              root: params.root,
              context: { ...context, assertRequesterCurrent: context.assertBoundChildCurrent },
              input: {
                configInputHash: context.inputHash,
                repair: doctorPolicy.fix,
                databaseGenerations: context.databaseBackup?.sourceGenerations,
              },
            },
            runDoctor,
          )
        : await runDoctor(),
    };
    context?.assertCurrent();
  } catch (error) {
    outcome = { error };
  }
  try {
    // An uncertain child may still write its receipt and cannot report completion.
    if ("error" in outcome && hasCommandProcessCleanupError(outcome.error)) {
      throw outcome.error;
    }
    const doctorResult = await consumeUpdatePostInstallDoctorResult(doctorResultPath);
    if ("error" in outcome) {
      const recorded = completedSteps.at(-1);
      if (!recorded) {
        throw outcome.error;
      }
      return await completeDoctorStep(recorded, doctorResult, outcome);
    }
    return await completeDoctorStep(outcome.step, doctorResult);
  } finally {
    params.results?.push(...completedSteps);
  }
}

/** Keep package staging open until its source owner publishes the validated checkout. */
export async function prepareGitPackageExposure(
  params: Omit<Parameters<typeof runGlobalPackageUpdateSteps>[0], "beforeActivate">,
) {
  const prepared = createDeferredCore();
  const activation = createDeferredCore<boolean>();
  const cancellation = new Error("Source activation cancelled before global exposure");
  const completed = runGlobalPackageUpdateSteps({
    ...params,
    beforeActivate: async () => {
      prepared.resolve();
      if (!(await activation.promise)) {
        throw cancellation;
      }
    },
  });
  const outcome = await Promise.race([prepared.promise.then(() => null), completed]);
  if (outcome) {
    const failure = outcome.failedStep;
    throw new UpdatePreMutationError(
      outcome.reason ??
        (failure
          ? normalizeFallbackFailureReason(failure.name)
          : "source-exposure-preparation-failed"),
      failure?.stderrTail ?? "Global source exposure did not reach the activation gate",
      {
        failureFacts: failure?.failureFacts,
        stepResult: { steps: outcome.steps, failedStep: failure ?? undefined },
      },
    );
  }
  return {
    activate: () => {
      activation.resolve(true);
      return completed;
    },
    cancel: async () => {
      activation.resolve(false);
      try {
        return await completed;
      } catch (error) {
        if (error !== cancellation) {
          throw error;
        }
        // Only this gate's cancellation leaves the package untouched. Recheck
        // it after staging cleanup without masking the source owner's failure.
        return {
          steps: [],
          recovery: await verifyPackageUpdateRecovery(params.installTarget.packageRoot),
        };
      }
    },
  };
}

export type PackageInstallUpdateParams = {
  reapplyLocalOverrides?: boolean;
  requirePackageReplacement?: boolean;
  root: string;
  installKind: "git" | "package" | "unknown";
  tag: string;
  installSpec?: string;
  timeoutMs: number;
  /** Null leaves forward work unbounded; omission retains the caller's timeout. */
  workTimeoutMs?: number | null;
  startedAt: number;
  progress: ReturnType<typeof createUpdateProgress>["progress"];
  managedServiceEnv?: NodeJS.ProcessEnv;
  invocationCwd?: string;
  honorPackageRoot?: boolean;
  nodeRunner?: string;
  resolveLifecycleNodeRunner?: () => string | undefined;
  installEnv?: NodeJS.ProcessEnv;
  installTarget?: ResolvedGlobalInstallTarget;
  beforeVerifyCandidate?: (root: string) => Promise<void>;
  validateCandidate: (root: string) => Promise<UpdateStepResult[]>;
  beforeActivate: () => Promise<void>;
  assertCurrent?: () => void;
  onTransaction: (transaction: PackageUpdateTransaction) => void | Promise<void>;
  onConfigSnapshot?: PackageDoctorOptions["onConfigSnapshot"];
  getDoctorContext?: PackageDoctorOptions["getDoctorContext"];
};

/** Retain one staged target while its runtime initializes a fresh profile. */
export async function stagePackageInstallUpdate(
  params: Omit<
    PackageInstallUpdateParams,
    "validateCandidate" | "beforeActivate" | "onTransaction" | "onConfigSnapshot"
  > & { pauseBeforeVerification?: boolean },
) {
  const staged = createDeferredCore<string>();
  const continuation = createDeferredCore<PackageInstallUpdateParams | undefined>();
  let continued = false;
  let active: PackageInstallUpdateParams | undefined;
  const requireActive = () => {
    if (!active) {
      throw new Error("Staged update has not been admitted for activation.");
    }
    return active;
  };
  const retainCandidate = async (root: string) => {
    staged.resolve(root);
    active = await continuation.promise;
    if (!active) {
      throw new Error("Staged update stopped before package activation.");
    }
  };
  const completed = runPackageInstallUpdate(
    {
      ...params,
      // Admission pauses before the no-op decision, so its resumed caller can
      // preserve an identical installation. Fresh-profile staging pauses later
      // and must retain the candidate through initialization.
      get requirePackageReplacement() {
        return !params.pauseBeforeVerification || requireActive().requirePackageReplacement;
      },
      beforeVerifyCandidate:
        params.pauseBeforeVerification || params.beforeVerifyCandidate
          ? async (root) => {
              try {
                await params.beforeVerifyCandidate?.(root);
              } catch (error) {
                throw new PackageUpdateActivationError(error);
              }
              if (params.pauseBeforeVerification) {
                await retainCandidate(root);
              }
            }
          : undefined,
      resolveLifecycleNodeRunner: () =>
        active?.nodeRunner ?? params.resolveLifecycleNodeRunner?.() ?? params.nodeRunner,
      progress: {
        onStepStart: (step) => (active?.progress ?? params.progress)?.onStepStart?.(step),
        onStepComplete: (step) => (active?.progress ?? params.progress)?.onStepComplete?.(step),
        onHeartbeat: () => (active?.progress ?? params.progress)?.onHeartbeat?.(),
      },
      validateCandidate: async (root) => {
        if (!params.pauseBeforeVerification) {
          await retainCandidate(root);
        }
        return await requireActive().validateCandidate(root);
      },
      beforeActivate: () => requireActive().beforeActivate(),
      onTransaction: (transaction) => requireActive().onTransaction(transaction),
      onConfigSnapshot: (snapshot) => requireActive().onConfigSnapshot?.(snapshot),
    },
    () => requireActive(),
  );
  const ready = await Promise.race([
    staged.promise.then((root) => ({ root })),
    completed.then((result) => ({ result })),
  ]);
  if ("result" in ready) {
    throw new UpdatePreMutationError(
      ready.result.reason ?? "package-staging-failed",
      ready.result.failedStep?.stderrTail ?? "Package staging did not produce a target runtime.",
      { failureFacts: ready.result.failedStep?.failureFacts, stepResult: ready.result },
    );
  }
  return {
    root: ready.root,
    async run(next: PackageInstallUpdateParams) {
      if (continued) {
        throw new Error("A staged update can be activated only once.");
      }
      continued = true;
      continuation.resolve(next);
      return await completed;
    },
    async close() {
      if (!continued) {
        continued = true;
        continuation.resolve(undefined);
      }
      await completed;
    },
  };
}

export type StagedPackageInstallUpdate = Awaited<ReturnType<typeof stagePackageInstallUpdate>>;

export async function runPackageInstallUpdate(
  params: PackageInstallUpdateParams,
  resolveDoctorOptions: () => PackageDoctorOptions = () => params,
): Promise<UpdateRunResult> {
  const installEnv = params.installEnv ?? (await createGlobalInstallEnv());
  let installTarget = params.installTarget;
  if (!installTarget) {
    const manager = await resolveGlobalManager({
      root: params.root,
      installKind: params.installKind,
      timeoutMs: params.timeoutMs,
    });
    installTarget = await resolveGlobalInstallTarget({
      manager,
      runCommand: runCommandWithTimeout,
      timeoutMs: params.timeoutMs,
      pkgRoot: params.root,
      honorPackageRoot: params.honorPackageRoot === true,
    });
  }
  const pkgRoot = installTarget.packageRoot;
  const packageName = (await readPackageName(pkgRoot || params.root)) ?? DEFAULT_PACKAGE_NAME;
  const installSpec =
    params.installSpec ??
    resolveGlobalInstallSpec({
      packageName,
      tag: params.tag,
      env: installEnv,
    });

  const before = pkgRoot ? await readPackageUpdateIdentity(pkgRoot) : { version: null };

  const packageUpdate = await runGlobalPackageUpdateSteps({
    localOverrides: {
      reapply: params.reapplyLocalOverrides === true,
      env: resolveUpdateTargetEnv({
        serviceEnv: params.managedServiceEnv,
        invocationCwd: params.invocationCwd,
      }),
    },
    validateCandidate: params.validateCandidate,
    beforeVerifyCandidate: params.beforeVerifyCandidate,
    resolveLifecycleNodeRunner: params.resolveLifecycleNodeRunner ?? (() => params.nodeRunner),
    beforeActivate: params.beforeActivate,
    assertCurrent: params.assertCurrent,
    onTransaction: params.onTransaction,
    installTarget,
    installSpec,
    packageName,
    packageRoot: pkgRoot,
    // Artifact equality cannot skip a method switch or retained-runtime staging.
    get requirePackageReplacement() {
      return params.requirePackageReplacement === true || params.installKind === "git";
    },
    runCommand: runCommandWithTimeout,
    timeoutMs: params.timeoutMs,
    workTimeoutMs: params.workTimeoutMs,
    ...(installEnv === undefined ? {} : { env: installEnv }),
    runStep: (stepParams) =>
      runUpdateStep({
        ...stepParams,
        progress: params.progress,
      }),
    postVerifyStep: (root, results) =>
      runPackageUpdateDoctor({ ...resolveDoctorOptions(), root, results }),
  });

  const afterBuildId = packageUpdate.activePackageRoot
    ? await readBuiltGatewayBuildId(packageUpdate.activePackageRoot)
    : null;
  return {
    status:
      packageUpdate.reason === "already-current"
        ? "skipped"
        : packageUpdate.failedStep
          ? "error"
          : "ok",
    mode: installTarget.manager,
    root: packageUpdate.activePackageRoot ?? undefined,
    reason:
      getUpdateDoctorConfigFailureReason(packageUpdate.failedStep?.configWriteRefusal) ??
      packageUpdate.reason ??
      (packageUpdate.failedStep
        ? normalizeFallbackFailureReason(packageUpdate.failedStep.name)
        : undefined),
    before,
    after: {
      version: packageUpdate.afterVersion,
      ...(afterBuildId ? { buildId: afterBuildId } : {}),
    },
    steps: packageUpdate.steps,
    failedStep: packageUpdate.failedStep ?? undefined,
    recovery: packageUpdate.recovery,
    localOverrides: packageUpdate.localOverrides,
    durationMs: Date.now() - params.startedAt,
  };
}
