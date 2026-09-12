import path from "node:path";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { hashConfigRaw } from "../../config/io.read-helpers.js";
import { resolveConfigPath } from "../../config/paths.js";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import { createLowDiskSpaceWarning } from "../../infra/disk-space.js";
import {
  markPackagePostInstallDoctorAdvisory,
  runGlobalPackageUpdateSteps,
  type PackageUpdateTransaction,
} from "../../infra/package-update-steps.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  formatUpdateDoctorConfigWriteRefusal,
  getUpdateDoctorConfigFailureReason,
  type UpdateDoctorConfigChange,
} from "../../infra/update-doctor-config.js";
import {
  consumeUpdatePostInstallDoctorResult,
  createUpdatePostInstallDoctorResultPath,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
} from "../../infra/update-doctor-result.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import {
  canResolveRegistryVersionForPackageTarget,
  createGlobalInstallEnv,
  resolveGlobalInstallSpec,
  resolveGlobalInstallTarget,
  verifyPackageUpdateRecovery,
  type ResolvedGlobalInstallTarget,
} from "../../infra/update-global.js";
import type { UpdateRequester } from "../../infra/update-requester-authority.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { normalizeFallbackFailureReason } from "../../infra/update-runner-command.js";
import { buildUpdateDoctorEnv } from "../../infra/update-runner-doctor.js";
import {
  resolveUpdateDoctorExecutionPolicy,
  type UpdateRunResult,
  type UpdateStepResult,
} from "../../infra/update-runner.js";
import { runCommandWithTimeout, runUtf8CommandWithTimeout } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
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
import {
  withUpdateCommandExecutorChild,
  type UpdateCommandChildGrant,
} from "./update-command-executor.js";
import type { UpdateDoctorInput } from "./update-command-migrated-types.js";
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
  timeoutMs: number;
  progress: ReturnType<typeof createUpdateProgress>["progress"];
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
        assertCurrent: () => void;
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
  assertCurrent: () => void;
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
    assertCurrent: params.assertCurrent,
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
  const runDoctor = (executor?: UpdateCommandChildGrant, beforeInput?: (pid: number) => void) => {
    context?.assertCurrent();
    const input: UpdateDoctorInput | undefined =
      context && executor
        ? {
            executor,
            runId: context.runId,
            root: params.root,
            configInputHash: context.inputHash,
            requester: context.requester,
            repair: doctorPolicy.fix,
          }
        : undefined;
    return runUpdateStep({
      name: `${CLI_NAME} doctor`,
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
      timeoutMs: params.timeoutMs,
      ...(input
        ? {
            runCommand: async (argv, options) => {
              const result = await runUtf8CommandWithTimeout(argv, {
                ...options,
                input: JSON.stringify(input),
                beforeInput,
                killProcessTree: true,
                requireProcessTreeExtinction: true,
              });
              if (result.cleanup !== "normal") {
                throw new Error("Doctor executor did not settle its child processes.");
              }
              return result;
            },
          }
        : {}),
    });
  };
  const doctorStep = context
    ? await withUpdateCommandExecutorChild(context.executorFence, params.root, (grant, bindChild) =>
        runDoctor(grant, (pid) => {
          context.assertCurrent();
          bindChild(pid);
        }),
      )
    : await runDoctor();
  const doctorResult = await consumeUpdatePostInstallDoctorResult(doctorResultPath);
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
  const refusal = doctorResult?.configWriteRefusal;
  const configWriteRefusal = refusal
    ? {
        ...refusal,
        keys: [
          ...new Set([
            ...refusal.keys,
            ...(context?.changes.flatMap((change) => (change.kind === "key" ? [change.key] : [])) ??
              []),
          ]),
        ].toSorted(),
      }
    : undefined;
  const completedDoctorStep = markPackagePostInstallDoctorAdvisory(
    {
      ...doctorStep,
      ...(doctorResult?.configChanges?.length ? { configChanges: doctorResult.configChanges } : {}),
      ...(configWriteRefusal
        ? {
            configWriteRefusal,
            exitCode: 1,
            stderrTail: formatUpdateDoctorConfigWriteRefusal(configWriteRefusal),
          }
        : {}),
    },
    doctorResult,
  );
  params.progress?.onStepComplete?.({
    ...doctorProgressInfo,
    durationMs: completedDoctorStep.durationMs,
    exitCode: completedDoctorStep.exitCode,
    stdoutTail: completedDoctorStep.stdoutTail,
    stderrTail: completedDoctorStep.stderrTail,
    signal: completedDoctorStep.signal,
    killed: completedDoctorStep.killed,
    termination: completedDoctorStep.termination,
    advisory: completedDoctorStep.advisory,
    warnings: completedDoctorStep.warnings,
    configChanges: completedDoctorStep.configChanges,
    configWriteRefusal: completedDoctorStep.configWriteRefusal,
  });
  return completedDoctorStep;
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
  root: string;
  installKind: "git" | "package" | "unknown";
  tag: string;
  installSpec?: string;
  timeoutMs: number;
  startedAt: number;
  progress: ReturnType<typeof createUpdateProgress>["progress"];
  jsonMode: boolean;
  managedServiceEnv?: NodeJS.ProcessEnv;
  invocationCwd?: string;
  honorPackageRoot?: boolean;
  nodeRunner?: string;
  installEnv?: NodeJS.ProcessEnv;
  installTarget?: ResolvedGlobalInstallTarget;
  validateCandidate: (root: string) => Promise<UpdateStepResult[]>;
  beforeActivate: () => Promise<void>;
  onTransaction: (transaction: PackageUpdateTransaction) => void;
  onConfigSnapshot?: PackageDoctorOptions["onConfigSnapshot"];
  getDoctorContext?: PackageDoctorOptions["getDoctorContext"];
};

/** Retain one staged target while its runtime initializes a fresh profile. */
export async function stagePackageInstallUpdate(
  params: Omit<
    PackageInstallUpdateParams,
    "validateCandidate" | "beforeActivate" | "onTransaction" | "onConfigSnapshot"
  >,
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
  const completed = runPackageInstallUpdate(
    {
      ...params,
      progress: {
        onStepStart: (step) => (active?.progress ?? params.progress)?.onStepStart?.(step),
        onStepComplete: (step) => (active?.progress ?? params.progress)?.onStepComplete?.(step),
        onHeartbeat: () => (active?.progress ?? params.progress)?.onHeartbeat?.(),
      },
      validateCandidate: async (root) => {
        staged.resolve(root);
        active = await continuation.promise;
        if (!active) {
          throw new Error("Fresh-state initialization stopped before package activation.");
        }
        return await active.validateCandidate(root);
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
      ready.result.steps.find((step) => step.exitCode !== 0)?.stderrTail ??
        "Package staging did not produce a target runtime.",
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
  const packageName =
    (pkgRoot ? await readPackageName(pkgRoot) : await readPackageName(params.root)) ??
    DEFAULT_PACKAGE_NAME;
  const installSpec =
    params.installSpec ??
    resolveGlobalInstallSpec({
      packageName,
      tag: params.tag,
      env: installEnv,
    });

  const before = pkgRoot ? await readPackageUpdateIdentity(pkgRoot) : { version: null };

  const diskWarning = createLowDiskSpaceWarning({
    targetPath: pkgRoot ? path.dirname(pkgRoot) : params.root,
    purpose: "global package update",
  });
  if (diskWarning) {
    if (params.jsonMode) {
      defaultRuntime.error(`Warning: ${diskWarning}`);
    } else {
      defaultRuntime.log(theme.warn(diskWarning));
    }
  }

  const packageUpdate = await runGlobalPackageUpdateSteps({
    localOverrides: {
      reapply: params.reapplyLocalOverrides === true,
      env: resolveUpdateTargetEnv({
        serviceEnv: params.managedServiceEnv,
        invocationCwd: params.invocationCwd,
      }),
    },
    validateCandidate: params.validateCandidate,
    beforeActivate: params.beforeActivate,
    onTransaction: params.onTransaction,
    installTarget,
    installSpec,
    packageName,
    packageRoot: pkgRoot,
    // Explicit artifacts identify the payload; an equal version is not artifact equality.
    requirePackageReplacement:
      params.installKind === "git" || !canResolveRegistryVersionForPackageTarget(installSpec),
    runCommand: runCommandWithTimeout,
    timeoutMs: params.timeoutMs,
    ...(installEnv === undefined ? {} : { env: installEnv }),
    runStep: (stepParams) =>
      runUpdateStep({
        ...stepParams,
        progress: params.progress,
      }),
    postVerifyStep: (root: string) => runPackageUpdateDoctor({ ...resolveDoctorOptions(), root }),
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
    recovery: packageUpdate.recovery,
    localOverrides: packageUpdate.localOverrides,
    durationMs: Date.now() - params.startedAt,
  };
}
