import path from "node:path";
import { UPDATE_PARENT_RUNS_POST_ACTIVATION_INSPECTIONS_ENV } from "../../commands/doctor/shared/update-phase.js";
import { resolveConfigPath } from "../../config/paths.js";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import { resolveInstallWorkTimeoutMs } from "../../infra/install-mode-options.js";
import { runGlobalPackageUpdateSteps } from "../../infra/package-update-steps.js";
import type {
  PackageActivationOptions,
  PackageUpdateTransaction,
} from "../../infra/package-update-swap-contract.js";
import { PackageUpdateActivationError } from "../../infra/package-update-swap-contract.js";
import { deferPackageStateVerification } from "../../infra/package-update-verification-step.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import type { UpdateDatabaseBackup } from "../../infra/update-database-backup.js";
import {
  getUpdateDoctorConfigFailureReason,
  type UpdateDoctorConfigChange,
} from "../../infra/update-doctor-config.js";
import {
  consumeUpdatePostInstallDoctorResult,
  createUpdatePostInstallDoctorResultPath,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
} from "../../infra/update-doctor-result.js";
import { createUpdateDoctorSectionTiming } from "../../infra/update-doctor-section-timing.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import {
  createGlobalInstallEnv,
  resolveGlobalInstallSpec,
  resolveGlobalInstallTarget,
  verifyPackageUpdateRecovery,
  type ResolvedGlobalInstallTarget,
} from "../../infra/update-global.js";
import type { UpdateRecoveryBaselineRef } from "../../infra/update-recovery-baseline-capture.js";
import type { UpdateRequester } from "../../infra/update-requester-authority.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { normalizeFallbackFailureReason } from "../../infra/update-runner-command.js";
import {
  buildUpdateDoctorEnv,
  resolveUpdateDoctorExecutionPolicy,
} from "../../infra/update-runner-doctor.js";
import type { UpdateRunResult, UpdateStepProgress } from "../../infra/update-runner-types.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { CLI_NAME } from "../cli-name.js";
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
  captureUpdateConfigSnapshot,
  type UpdateConfigSnapshot,
} from "./update-command-config-snapshot.js";
import { withUpdateDoctorChild } from "./update-command-doctor-child.js";
import { createPackageUpdateDoctorCompletion } from "./update-command-doctor-completion.js";
import { readPackageUpdateIdentity } from "./update-command-package-identity.js";
import { resolveUpdateTargetEnv } from "./update-command-service-env.js";

type PackageDoctorContext = {
  runId: string;
  executorFence: UpdateRecoveryFence;
  requester?: Readonly<UpdateRequester>;
  inputHash: string;
  changes: UpdateDoctorConfigChange[];
  databaseBackup?: UpdateDatabaseBackup;
  originalRecoveryCapture?: UpdateRecoveryBaselineRef;
  assertCurrent: () => void;
  assertBoundChildCurrent: () => void;
  onStateHandoff?: () => void;
};

type PackageDoctorOptions = {
  root: string;
  restart?: boolean;
  timeoutMs?: number;
  /** Null leaves forward work unbounded; omission retains the caller's timeout. */
  workTimeoutMs?: number | null;
  progress: UpdateStepProgress;
  assertCurrent?: () => void;
  results?: UpdateStepResult[];
  managedServiceEnv?: NodeJS.ProcessEnv;
  invocationCwd?: string;
  nodeRunner?: string;
  onConfigSnapshot?: (snapshot: UpdateConfigSnapshot) => void;
  getDoctorContext?: () => PackageDoctorContext | undefined;
};

export async function runPackageUpdateDoctor(params: PackageDoctorOptions) {
  const assertRequesterCurrent = params.assertCurrent;
  const context = params.getDoctorContext?.();
  const assertCurrent = () => {
    assertRequesterCurrent?.();
    context?.assertCurrent();
  };
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
  const sectionTiming = createUpdateDoctorSectionTiming();
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
  let configSnapshot: UpdateConfigSnapshot | undefined;
  try {
    configSnapshot = params.onConfigSnapshot
      ? await captureUpdateConfigSnapshot(resolveConfigPath(doctorEnv), doctorEnv)
      : undefined;
  } catch (error) {
    assertCurrent();
    return await deferPackageStateVerification({ ...params, assertCurrent }, error);
  }
  await params.progress?.onStepStart?.(doctorProgressInfo);
  assertCurrent();
  const completeDoctorStep = createPackageUpdateDoctorCompletion({
    root: params.root,
    progress: params.progress,
    onConfigSnapshot: params.onConfigSnapshot,
    context,
    configSnapshot,
    sectionTiming,
    assertCurrent,
    doctorProgressInfo,
  });
  const completedSteps: UpdateStepResult[] = [];
  let processSettlement: UpdateStepResult | undefined;
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
        ...sectionTiming.env,
        [UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]: doctorResultPath,
        // finishUpdate runs the deferred inspections once the restarted Gateway is ready.
        [UPDATE_PARENT_RUNS_POST_ACTIVATION_INSPECTIONS_ENV]: params.restart === false ? "0" : "1",
      },
      timeoutMs: resolveInstallWorkTimeoutMs(params.workTimeoutMs, params.timeoutMs),
      runCommand: sectionTiming.wrap(runCommand ?? runCommandWithTimeout),
    });
  let outcome: { step: UpdateStepResult } | { error: unknown };
  try {
    outcome = {
      step: context
        ? await withUpdateDoctorChild(
            {
              root: params.root,
              context: {
                ...context,
                assertRequesterCurrent: context.assertBoundChildCurrent,
                onProcessSettlement: (step) => {
                  processSettlement = step;
                },
              },
              input: {
                configInputHash: context.inputHash,
                repair: doctorPolicy.fix,
                databaseGenerations: context.databaseBackup?.sourceGenerations,
                originalRecoveryCapture: context.originalRecoveryCapture,
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
      outcome = { step: await completeDoctorStep(recorded, doctorResult, outcome) };
    } else {
      outcome = { step: await completeDoctorStep(outcome.step, doctorResult) };
    }
  } catch (error) {
    outcome = { error };
  }
  try {
    params.results?.push(...(processSettlement ? [processSettlement] : []), ...completedSteps);
    if (processSettlement) {
      await params.progress?.onStepComplete?.({ ...processSettlement, index: 0, total: 0 });
      assertCurrent();
    }
  } catch (error) {
    if ("error" in outcome) {
      throw new AggregateError([outcome.error, error], "Doctor settlement recording failed", {
        cause: error,
      });
    }
    throw error;
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.step;
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

export type PackageInstallUpdateParams = Omit<PackageDoctorOptions, "results"> & {
  reapplyLocalOverrides?: boolean;
  requirePackageReplacement?: boolean;
  installKind: "git" | "package" | "unknown";
  tag: string;
  installSpec?: string;
  timeoutMs: number;
  startedAt: number;
  honorPackageRoot?: boolean;
  resolveLifecycleNodeRunner?: () => string | undefined;
  installEnv?: NodeJS.ProcessEnv;
  installTarget?: ResolvedGlobalInstallTarget;
  beforeVerifyCandidate?: (root: string) => Promise<void>;
  validateCandidate: (root: string) => Promise<UpdateStepResult[]>;
  beforeActivate: () => Promise<void>;
  reserveInstallSlot?: (root: string) => void;
  onTransaction: (transaction: PackageUpdateTransaction) => void | Promise<void>;
  getActivation?: () => PackageActivationOptions | undefined;
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
  let deliveredFailure: { error: unknown } | undefined;
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
      assertCurrent: () => requireActive().assertCurrent?.(),
      reserveInstallSlot: (root) => requireActive().reserveInstallSlot?.(root),
      getActivation: () => requireActive().getActivation?.(),
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
      try {
        return await completed;
      } catch (error) {
        deliveredFailure = { error };
        throw error;
      }
    },
    async close() {
      if (!continued) {
        continued = true;
        continuation.resolve(undefined);
      }
      try {
        await completed;
      } catch (error) {
        // Closing joins the same operation; a delivered refusal is not a new cleanup failure.
        if (
          !deliveredFailure ||
          deliveredFailure.error !== error ||
          hasCommandProcessCleanupError(error)
        ) {
          throw error;
        }
      }
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
  const doctorSettlements: UpdateStepResult[] = [];

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
    reserveInstallSlot: params.reserveInstallSlot,
    onTransaction: params.onTransaction,
    getActivation: params.getActivation,
    installTarget,
    installSpec,
    installCwd: params.invocationCwd,
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
    postVerifyStep: async (root, results) => {
      try {
        return await runPackageUpdateDoctor({ ...resolveDoctorOptions(), root, results });
      } finally {
        doctorSettlements.push(
          ...(results?.filter((result) => result.name === "doctor process settlement") ?? []),
        );
      }
    },
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
    steps: [...packageUpdate.steps, ...doctorSettlements],
    failedStep: packageUpdate.failedStep ?? undefined,
    recovery: packageUpdate.recovery,
    localOverrides: packageUpdate.localOverrides,
    durationMs: Date.now() - params.startedAt,
  };
}
