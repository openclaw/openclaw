import path from "node:path";
import { hashConfigRaw } from "../../config/io.read-helpers.js";
import { ScheduledTaskAutoStartRecoveryError } from "../../daemon/schtasks-update-recovery.js";
import { tryReadJson } from "../../infra/json-files.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-swap-contract.js";
import type { UpdateStateSchemaVersion } from "../../infra/update-candidate-state.js";
import type { UpdateDoctorConfigChange } from "../../infra/update-doctor-config.js";
import { resolveUpdateFinalizationTimeoutMs } from "../../infra/update-finalization-budget.js";
import { canResolveRegistryVersionForPackageTarget } from "../../infra/update-global.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import {
  parsePackageOpenClawSchemaVersions,
  type OpenClawSchemaVersions,
} from "../../state/openclaw-schema-versions.js";
import { assertReadableGitMetadata } from "./schema-preflight.js";
import {
  normalizeTag,
  readPackageVersion,
  resolveGitInstallDir,
  UpdatePreMutationError,
} from "./shared.js";
import {
  assertUpdateCandidateExecutor,
  assertUpdateCandidateSteps,
  createUpdateCandidateConfigRefresh,
  preflightUpdateCandidatePlugins,
  validateUpdateCandidateWithProgress,
} from "./update-command-candidate-validation.js";
import {
  captureUpdateDatabases,
  restoreFailedUpdateDatabases,
} from "./update-command-database-backup.js";
import {
  inspectUpdateDatabaseContexts,
  revalidateUpdateDatabaseContexts,
} from "./update-command-database-context.js";
import type { MutableUpdateExecutionParams } from "./update-command-execution.types.js";
import {
  admitSourceUpdateArtifacts,
  recordInspectedGitTarget,
} from "./update-command-git-admission.js";
import { updateGitInstall } from "./update-command-git.js";
import {
  formatUpdateAncestryBlockMessage,
  handoffUpdateFromGateway,
  parkForegroundUpdateForActivation,
} from "./update-command-handoff.js";
import {
  captureOwnedManagedUpdateContext,
  readUpdateCandidateSource,
  type OwnedManagedUpdateContext,
} from "./update-command-managed-context.js";
import {
  recordMutableUpdateInterruption,
  withMutableUpdateForwardScope,
} from "./update-command-mutable-signals.js";
import { observeOriginalManagedServiceRuntime } from "./update-command-original-service.js";
import { createPackageUpdateActivationOptions } from "./update-command-package-activation.js";
import {
  runPackageInstallUpdate,
  type PackageInstallUpdateParams,
} from "./update-command-package.js";
import {
  assertUpdateCommandRecovery,
  readOriginalUpdateRecovery,
} from "./update-command-recovery.js";
import {
  collectServiceInspectionFailureFacts,
  resolveMutableUpdateFailure,
  type MutableUpdateExecutionResult,
} from "./update-command-result.js";
import { captureUpdateActivationSchemas } from "./update-command-schema.js";
import { GatewayServiceUpdateOwnershipError } from "./update-command-service-plan.js";
import { assertManagedGatewayArtifactPublication } from "./update-command-service-revalidation.js";
import {
  maybeRestartServiceAfterFailedMutableUpdate,
  maybeStopManagedServiceBeforeMutableUpdate,
  mutableUpdateGatewayServiceBlock,
  UpdateCommandAbort,
  type PreManagedServiceStop,
} from "./update-command-service.js";
import { verifyPreviousManagedGatewayForUpdate } from "./update-command-verification.js";

export async function executeMutableUpdate(
  params: MutableUpdateExecutionParams,
): Promise<MutableUpdateExecutionResult | null> {
  const { opts, updateStepTimeoutMs } = params;
  const candidateAdmissionChecks =
    params.updateInstallKind === "package" ? opts.run?.candidateAdmissionChecks : undefined;
  const configValidation = candidateAdmissionChecks?.includes("config")
    ? ("candidate" as const)
    : undefined;
  const databaseContextOptions = {
    ...params,
    jsonMode: Boolean(opts.json),
    timeoutMs: updateStepTimeoutMs,
    candidateAdmissionChecks,
  } satisfies Omit<Parameters<typeof inspectUpdateDatabaseContexts>[0], "roots">;
  const originalRun = opts.run;
  const requesterAuthority = originalRun?.requesterAuthority;
  const {
    assertCurrent: assertExecutionCurrent,
    assertBoundChildCurrent,
    onStateHandoff,
    admitExecutor,
    captureWriteOptions,
    recordPhase,
  } = params.executionGuards;
  let retentionInstallTarget = params.packageInstallTarget;
  const prepareMutableUpdate = async (env?: NodeJS.ProcessEnv, activationTimeoutMs?: number) => {
    assertExecutionCurrent();
    await params.prepareMutableUpdate(
      env,
      activationTimeoutMs,
      admitExecutor,
      retentionInstallTarget,
    );
    assertExecutionCurrent();
  };
  const mode: UpdateRunResult["mode"] =
    params.updateInstallKind === "git"
      ? "git"
      : (params.packageInstallTarget?.manager ?? "unknown");
  if (opts.recovery) {
    throw new UpdatePreMutationError(
      "rollback-state-unverified",
      "Full-state checkpoint recovery is deferred.",
    );
  }
  assertUpdateCommandRecovery(opts);
  const stagedPluginAdmission =
    params.updateInstallKind === "package" &&
    !canResolveRegistryVersionForPackageTarget(params.packageInstallSpec ?? params.tag);
  let preManagedServiceStop: PreManagedServiceStop | undefined;
  let ownedManagedUpdateContext: OwnedManagedUpdateContext | undefined;
  let admission: Awaited<ReturnType<typeof inspectUpdateDatabaseContexts>> | undefined;
  let gitContextPrepared = false;
  let admittedTargetSchemaVersions = params.packageTargetSchemaVersions;
  const recheckSchemas = async (versions: OpenClawSchemaVersions | undefined) => {
    admission = await revalidateUpdateDatabaseContexts(
      {
        ...databaseContextOptions,
        // A stopped systemd unit may need metadata loading under the retained executor.
        assertCurrent: preManagedServiceStop?.stopped ? assertExecutionCurrent : undefined,
      },
      admission,
      versions,
    );
    admittedTargetSchemaVersions = versions;
    return admission;
  };
  const preflightPlugins = (targetVersion: string | null) =>
    preflightUpdateCandidatePlugins(params, {
      targetVersion,
      candidateAdmissionChecks,
      readAdmission: () => recheckSchemas(admittedTargetSchemaVersions),
    });
  let recoveryEnv: NodeJS.ProcessEnv | undefined;
  let packageTransaction: PackageUpdateTransaction | undefined;
  let databaseCapture: Awaited<ReturnType<typeof captureUpdateDatabases>> | undefined;
  const onTransaction = async (transaction: PackageUpdateTransaction) => {
    packageTransaction = transaction;
    if (originalRun) {
      databaseCapture = await captureUpdateDatabases({
        transaction,
        execution: params,
        context: ownedManagedUpdateContext,
        assertCurrent: assertExecutionCurrent,
      });
    }
  };
  let schemaVersions: UpdateStateSchemaVersion[] | undefined;
  let candidateSchemaVersions: OpenClawSchemaVersions | undefined;
  let gatewayRestartCompletion = false;
  let previousSchemaVersions: OpenClawSchemaVersions | undefined;
  let previousVerified = false;
  let originalManagedServiceRuntime: MutableUpdateExecutionResult["originalManagedServiceRuntime"];
  let observedGatewayStartupMs: number | undefined;
  let activationConfig: MutableUpdateExecutionResult["activationConfig"];
  const onConfigSnapshot: PackageInstallUpdateParams["onConfigSnapshot"] = (snapshot) => {
    activationConfig = snapshot;
  };
  let candidateFailureReason: string | undefined;
  let doctorConfigWrites = false;
  let doctorEntered = false;
  let doctorConfigChanges: UpdateDoctorConfigChange[] = [];
  let validatedConfigSnapshot: Awaited<ReturnType<typeof readUpdateCandidateSource>> | undefined;
  let validatedCandidateRoot: string | undefined;
  const readCandidateConfig = (env: NodeJS.ProcessEnv) =>
    readUpdateCandidateSource(env, params.legacyConfigPlan, { configValidation });
  const getDoctorContext: PackageInstallUpdateParams["getDoctorContext"] = () => {
    doctorEntered = true;
    const capable = doctorConfigWrites;
    const runId = originalRun?.runId;
    const executorFence = originalRun?.executorFence;
    const requester = requesterAuthority?.requester;
    const inputHash = validatedConfigSnapshot?.hash;
    const context = {
      requester,
      changes: doctorConfigChanges,
      databaseBackup: databaseCapture?.backup,
      originalRecoveryCapture: originalRun?.originalRecoveryCapture,
      assertCurrent: assertExecutionCurrent,
      assertBoundChildCurrent,
      onStateHandoff,
    };
    assertExecutionCurrent();
    if (!capable) {
      return undefined;
    }
    if (!runId || !executorFence || inputHash === undefined) {
      throw new Error(
        "Validated Doctor requires its live update executor and captured config hash.",
      );
    }
    return { ...context, runId, executorFence, inputHash: inputHash ?? hashConfigRaw(null) };
  };
  const originalRecovery = () => readOriginalUpdateRecovery(params, updateStepTimeoutMs);
  const gitMutationRoots =
    params.updateInstallKind === "git"
      ? params.switchToGit
        ? [params.root, resolveGitInstallDir()]
        : [params.root]
      : null;
  const stopManagedServiceBeforeMutableUpdate = async (
    mutationRoots: readonly string[] = [params.root],
    phase: "inspect" | "prepare" = "prepare",
  ) => {
    if (admission?.foreground) {
      return;
    }
    try {
      for (const mutationRoot of new Set(
        params.managedServiceRoot ? [params.managedServiceRoot] : mutationRoots,
      )) {
        const serviceIdentity = preManagedServiceStop?.serviceIdentity;
        preManagedServiceStop = await maybeStopManagedServiceBeforeMutableUpdate({
          updateInstallKind: params.updateInstallKind,
          root: mutationRoot,
          handoffRoot: params.managedServiceRoot ? params.root : undefined,
          shouldRestart: params.shouldRestart,
          jsonMode: Boolean(opts.json),
          timeoutMs: updateStepTimeoutMs,
          phase,
          expectedService: admission?.services.get(mutationRoot),
          updateRun: originalRun,
          recordPhase,
          assertCurrent: assertExecutionCurrent,
          recovery: opts.recovery,
          onStopped: (state) => {
            preManagedServiceStop = { ...state, ...(serviceIdentity ? { serviceIdentity } : {}) };
          },
          handoffFromGateway: (state) =>
            handoffUpdateFromGateway({
              state,
              root: params.managedServiceRoot ? params.root : mutationRoot,
              opts,
              // Pin the inspected package. Extended-stable resolves its protected
              // selector again because its public CLI contract forbids --tag.
              tag:
                params.updateInstallKind === "package" && params.channel !== "extended-stable"
                  ? (normalizeTag(params.packageInstallSpec) ?? undefined)
                  : undefined,
              mode,
              timeoutMs: updateStepTimeoutMs,
              devTarget: params.devTarget,
              nodeRunner: params.packageUpdateNodeRunner,
              invocationCwd: params.invocationCwd,
              stopProgress: params.stop,
            }),
        });
        if (serviceIdentity) {
          preManagedServiceStop.serviceIdentity = serviceIdentity;
        }
        if (preManagedServiceStop.windowsTaskAutoStartRecovery) {
          params.recoveryState.windowsTaskAutoStartRecovery =
            preManagedServiceStop.windowsTaskAutoStartRecovery;
        }
        if (
          preManagedServiceStop.stopped ||
          preManagedServiceStop.serviceUpdateVerdict?.kind === "owned" ||
          preManagedServiceStop.blockMessage ||
          (await mutableUpdateGatewayServiceBlock({
            preManagedServiceStop,
            root: params.managedServiceRoot ? params.root : mutationRoot,
            runId: opts.run?.runId,
          })) ||
          !preManagedServiceStop.inspected ||
          !preManagedServiceStop.running ||
          !params.shouldRestart
        ) {
          break;
        }
      }
    } catch (err) {
      if (err instanceof ScheduledTaskAutoStartRecoveryError) {
        recoveryEnv = err.serviceEnv;
        params.recoveryState.triageTarget.env = err.serviceEnv;
        throw err;
      }
      if (err instanceof UpdateCommandAbort || err instanceof UpdatePreMutationError) {
        throw err;
      }
      if (err instanceof GatewayServiceUpdateOwnershipError) {
        throw new UpdatePreMutationError("managed-service-preflight", err.message, {
          failureFacts: err.failureFacts,
        });
      }
      params.stop();
      throw new UpdatePreMutationError(
        "managed-service-stop-failed",
        `Failed to stop managed gateway service before update: ${String(err)}`,
        { cause: err },
      );
    }

    if (phase === "inspect" && preManagedServiceStop?.serviceUpdateVerdict?.kind === "foreign") {
      preManagedServiceStop = undefined;
    }

    try {
      ownedManagedUpdateContext = await captureOwnedManagedUpdateContext({
        stopState: preManagedServiceStop,
        processEnv: process.env,
        invocationCwd: params.invocationCwd,
      });
      if (ownedManagedUpdateContext) {
        params.recoveryState.triageTarget.env = ownedManagedUpdateContext.env;
      }
    } catch (err) {
      params.stop();
      await maybeRestartServiceAfterFailedMutableUpdate({
        recovery: await originalRecovery(),
        originalManagedServiceRuntime,
        updateRun: opts.run,
        preManagedServiceStop,
        jsonMode: Boolean(opts.json),
        nodeRunner: params.packageUpdateNodeRunner,
        timeoutMs: updateStepTimeoutMs,
        invocationCwd: params.invocationCwd,
      });
      throw new Error(`Failed to capture managed gateway update state: ${String(err)}`, {
        cause: err,
      });
    }

    const serviceEnvBlock = await mutableUpdateGatewayServiceBlock({
      preManagedServiceStop,
      root: params.root,
      runId: opts.run?.runId,
    });
    const blockMessage = serviceEnvBlock?.message ?? preManagedServiceStop?.blockMessage ?? "";
    if (serviceEnvBlock || blockMessage) {
      params.stop();
      throw new UpdatePreMutationError(
        "managed-service-preflight",
        formatUpdateAncestryBlockMessage(blockMessage),
        serviceEnvBlock ?? {
          failureFacts:
            preManagedServiceStop?.blockFailureFacts ??
            collectServiceInspectionFailureFacts(preManagedServiceStop?.serviceUpdateVerdict),
        },
      );
    }
  };

  let result: UpdateRunResult;
  let failure: MutableUpdateExecutionResult["failure"];
  let mutationStarted = false;
  const validateCandidate = async (root: string) => {
    assertUpdateCommandRecovery(opts);
    const env = ownedManagedUpdateContext?.env ?? opts.run?.env ?? process.env;
    await recordPhase("validating");
    assertExecutionCurrent();
    try {
      // Staged manifests own package schema support; Git builds refresh their admitted versions.
      const versions =
        params.updateInstallKind === "package"
          ? (parsePackageOpenClawSchemaVersions(
              await tryReadJson<unknown>(path.join(root, "package.json")),
            ) ?? admittedTargetSchemaVersions)
          : admittedTargetSchemaVersions;
      await recheckSchemas(versions);
      if (stagedPluginAdmission) {
        // Explicit artifacts acquire their version before rehearsal or activation.
        await preflightPlugins(await readPackageVersion(root));
        await prepareMutableUpdate(ownedManagedUpdateContext?.env ?? admission?.managedEnv);
      }
      await assertUpdateCandidateExecutor({
        root,
        env,
        run: originalRun,
        shouldRestart: params.shouldRestart,
        serviceOwned: preManagedServiceStop?.serviceUpdateVerdict?.kind === "owned",
        invocationCwd: params.invocationCwd,
        timeoutMs: updateStepTimeoutMs,
        nodeRunner: params.packageUpdateNodeRunner,
        assertCurrent: assertExecutionCurrent,
      });
    } catch (error) {
      if (error instanceof UpdatePreMutationError) {
        candidateFailureReason = error.reason;
      }
      throw error;
    }
    const snapshot = await readCandidateConfig(env);
    const validation = await validateUpdateCandidateWithProgress(
      {
        root,
        sourcePackageRoot: params.root,
        config: snapshot.config,
        env,
        assertCurrent: assertExecutionCurrent,
        writeOptions: captureWriteOptions(),
      },
      params,
      originalRun,
    );
    assertExecutionCurrent();
    doctorConfigChanges = [...(validation.doctorConfigChanges ?? [])];
    if (validation.status === "ok") {
      validatedConfigSnapshot = snapshot;
      validatedCandidateRoot = root;
      candidateSchemaVersions = validation.candidateSchemaVersions;
      gatewayRestartCompletion = validation.gatewayRestartCompletion === true;
      doctorConfigWrites = validation.doctorConfigWrites === true;
      observedGatewayStartupMs = validation.steps.find(
        (step) => step.name === "candidate-gateway-startup" && step.exitCode === 0,
      )?.durationMs;
    }
    candidateFailureReason = validation.status === "error" ? validation.reason : undefined;
    return validation.steps;
  };
  let servicePrepared = false;
  let refreshCandidate: ReturnType<typeof createUpdateCandidateConfigRefresh> | undefined;
  const beforeActivate = async (roots: readonly string[] = [params.root]) => {
    assertExecutionCurrent();
    if (params.switchToGit && !opts.run?.sourceArtifactLock) {
      await admitSourceUpdateArtifacts(resolveGitInstallDir(), opts.run);
      assertExecutionCurrent();
    }
    const env = ownedManagedUpdateContext?.env ?? opts.run?.env ?? process.env;
    refreshCandidate ??= createUpdateCandidateConfigRefresh({
      read: () =>
        readCandidateConfig(ownedManagedUpdateContext?.env ?? opts.run?.env ?? process.env),
      getValidated: () => validatedConfigSnapshot,
      validate: () => validateCandidate(validatedCandidateRoot!),
      assertCurrent: assertExecutionCurrent,
      timeoutMs: updateStepTimeoutMs,
    });
    for (;;) {
      const snapshot = await refreshCandidate();
      if (!snapshot) {
        continue;
      }
      const config = snapshot.config;
      await recheckSchemas(admittedTargetSchemaVersions);
      const originalServiceVerdict = preManagedServiceStop?.serviceUpdateVerdict;
      const previousRoot =
        originalServiceVerdict?.kind === "owned" &&
        originalServiceVerdict.requiresInstallRootRefresh
          ? originalServiceVerdict.root
          : params.root;
      ({ previousSchemaVersions, schemaVersions } = await captureUpdateActivationSchemas({
        root: previousRoot,
        env,
        config,
        run: opts.run,
        candidateSchemaVersions,
        gatewayRestartCompletion,
        timeoutMs: params.updateStepTimeoutMs,
      }));
      if (
        preManagedServiceStop?.running &&
        !servicePrepared &&
        preManagedServiceStop.serviceUpdateVerdict?.kind === "owned"
      ) {
        await verifyPreviousManagedGatewayForUpdate({
          root: previousRoot,
          config,
          env,
          opts,
          timeoutMs: params.timeoutMs,
          observedStartupMs: observedGatewayStartupMs,
          assertCurrent: assertExecutionCurrent,
          service: preManagedServiceStop,
          onVerification: (verified) => {
            previousVerified = verified;
          },
        });
      }
      // A separate serving runtime needs complete compensation evidence before
      // its stop. --no-restart neither needs nor acquires restart authority.
      if (params.shouldRestart && !servicePrepared) {
        originalManagedServiceRuntime = await observeOriginalManagedServiceRuntime(
          params,
          preManagedServiceStop,
        );
      }
      // Health and candidate work can outlive the inspected service/config generation.
      await recheckSchemas(admittedTargetSchemaVersions);
      assertExecutionCurrent();
      const activationTimeoutMs =
        params.timeoutMs === undefined
          ? undefined
          : await resolveUpdateFinalizationTimeoutMs(updateStepTimeoutMs, {
              env,
              databases: schemaVersions,
              observedStartupMs: observedGatewayStartupMs,
              pluginCount: Object.keys(config.plugins?.entries ?? {}).length,
              nodeRunner: params.packageUpdateNodeRunner,
            });
      await parkForegroundUpdateForActivation(params, assertExecutionCurrent);
      await prepareMutableUpdate(env, activationTimeoutMs);
      assertExecutionCurrent();
      await recordPhase("activating");
      assertExecutionCurrent();
      const publication = {
        roots,
        env,
        timeoutMs: updateStepTimeoutMs,
        assertCurrent: assertExecutionCurrent,
        updateInstallKind: params.updateInstallKind,
        shouldRestart: params.shouldRestart,
      };
      await assertManagedGatewayArtifactPublication({
        ...publication,
        selected: preManagedServiceStop,
        phase: "before-stop",
      });
      if (!(await refreshCandidate())) {
        continue;
      }
      if (!servicePrepared) {
        await stopManagedServiceBeforeMutableUpdate(roots);
        // Preparation can hold Windows recovery custody without stopping a process.
        servicePrepared = true;
      }
      await recheckSchemas(admittedTargetSchemaVersions);
      assertExecutionCurrent();
      await assertManagedGatewayArtifactPublication({
        ...publication,
        selected: preManagedServiceStop,
      });
      // Post-stop awaits can observe another save. Rebuild the activation facts before mutation.
      if (!(await refreshCandidate())) {
        continue;
      }
      // Both install paths enter mutation only after the post-stop schema/authority fence.
      if (!mutationStarted) {
        preManagedServiceStop?.windowsTaskAutoStartRecovery?.beginMutation();
        mutationStarted = true;
        params.onActivation?.();
      }
      return;
    }
  };
  const installOptions = {
    root: params.root,
    installKind: params.installKind,
    startedAt: params.startedAt,
    progress: params.progress,
    invocationCwd: params.invocationCwd,
    nodeRunner: params.packageUpdateNodeRunner,
    assertCurrent: assertExecutionCurrent,
    onConfigSnapshot,
    getDoctorContext,
  };
  try {
    admission = await inspectUpdateDatabaseContexts({
      ...databaseContextOptions,
      roots: gitMutationRoots ?? [params.root],
      expectedForeground: opts.run?.completionOwner === "gateway-restart" || undefined,
    });
    if (params.updateInstallKind === "package") {
      if (!stagedPluginAdmission) {
        await preflightPlugins(params.packageTargetVersion ?? null);
      }
      await stopManagedServiceBeforeMutableUpdate(undefined, "inspect");
      if (!stagedPluginAdmission) {
        await prepareMutableUpdate(admission?.managedEnv);
      }
      const packageUpdate: PackageInstallUpdateParams = {
        ...installOptions,
        // A separate serving root still needs the preparation/activation hooks.
        requirePackageReplacement: params.managedServiceRoot !== undefined,
        reapplyLocalOverrides: opts.reapplyLocalOverrides,
        tag: params.tag,
        installSpec: params.packageInstallSpec ?? undefined,
        timeoutMs: updateStepTimeoutMs,
        workTimeoutMs: params.timeoutMs ?? null,
        honorPackageRoot:
          params.managedServiceRootRedirect !== null ||
          params.managedServiceRoot !== undefined ||
          params.managedServiceNodeRunner !== undefined,
        installEnv: params.packageInstallEnv,
        installTarget: params.packageInstallTarget,
        validateCandidate,
        beforeActivate,
        ...createPackageUpdateActivationOptions({
          run: opts.run,
          runtime: params.packageActivationRuntime,
          assertCurrent: assertExecutionCurrent,
        }),
        managedServiceEnv: preManagedServiceStop?.serviceEnv,
        onTransaction,
      };
      await recheckSchemas(params.packageTargetSchemaVersions);
      result = await withMutableUpdateForwardScope(opts, () =>
        params.stagedPackage
          ? params.stagedPackage.run(packageUpdate)
          : runPackageInstallUpdate(packageUpdate),
      );
    } else {
      const sourceRoot = params.switchToGit ? resolveGitInstallDir() : params.root;
      const sourceRuntimePrepared = await admitSourceUpdateArtifacts(sourceRoot, opts.run);
      assertExecutionCurrent();
      const gitUpdate: Parameters<typeof updateGitInstall>[0] = {
        ...installOptions,
        sourceRuntimePrepared,
        switchToGit: params.switchToGit,
        timeoutMs: params.timeoutMs,
        channel: params.channel,
        devTarget: params.devTarget,
        inspectGitTarget: async (target, installTarget) => {
          retentionInstallTarget = installTarget;
          await recordInspectedGitTarget(target, recordPhase, assertExecutionCurrent);
          assertExecutionCurrent();
          await recheckSchemas(target.schemaVersions);
          if (!gitContextPrepared) {
            await stopManagedServiceBeforeMutableUpdate(gitMutationRoots ?? undefined, "inspect");
            await prepareMutableUpdate(admission?.managedEnv);
            // Revalidation retains activation's stop and recovery state.
            gitContextPrepared = true;
          }
          if (mutationStarted) {
            await beforeActivate(gitMutationRoots ?? [params.root]);
          }
        },
        onTransaction,
        // Foreign inspection metadata cannot authorize backup or Doctor writes.
        getManagedServiceEnv: () => ownedManagedUpdateContext?.env,
        getSnapshotSource: async () => {
          const env =
            ownedManagedUpdateContext?.env ?? admission?.managedEnv ?? opts.run?.env ?? process.env;
          const source = await readUpdateCandidateSource(env, params.legacyConfigPlan);
          return { config: source.config, env };
        },
        jsonMode: Boolean(opts.json),
        validateCandidate: async (candidateRoot) => {
          assertUpdateCandidateSteps(await validateCandidate(candidateRoot));
        },
        beforeGitMutation: async (target) => {
          assertReadableGitMetadata(target.metadataUnreadable);
          admittedTargetSchemaVersions = target.schemaVersions;
          await beforeActivate(gitMutationRoots ?? [params.root]);
        },
      };
      result = await withMutableUpdateForwardScope(opts, () => updateGitInstall(gitUpdate));
    }
  } catch (err) {
    params.stop();
    if (err instanceof UpdateCommandAbort && !hasCommandProcessCleanupError(err)) {
      return null;
    }
    ({ result, failure } = await resolveMutableUpdateFailure({
      cause: err,
      durationMs: Date.now() - params.startedAt,
      mode,
      root: params.root,
      originalRecovery,
      run: mutationStarted ? undefined : params.opts.run,
    }));
  }

  result = recordMutableUpdateInterruption(opts, result);
  if (candidateFailureReason && result.status === "error") {
    result.reason = candidateFailureReason;
  }
  result.steps = databaseCapture ? [databaseCapture.step, ...result.steps] : result.steps;
  const doctorSettled = doctorEntered && !hasCommandProcessCleanupError(failure?.cause);
  if (databaseCapture?.backup && originalRun && result.status === "error" && doctorSettled) {
    // Execution has not entered finalization or admitted any candidate Gateway.
    // Restore before schema inspection can hand an incompatible ledger to the candidate.
    await restoreFailedUpdateDatabases({
      backup: databaseCapture.backup,
      result,
      runId: originalRun.runId,
      env: ownedManagedUpdateContext?.env ?? originalRun.env,
      assertCurrent: () => assertExecutionCurrent("restore"),
      assertRollbackSafe: packageTransaction?.assertRollbackSafe,
      progress: params.progress,
    });
  }
  return {
    result,
    failure,
    mutationStarted,
    preManagedServiceStop,
    ownedManagedUpdateContext,
    recoveryEnv,
    packageTransaction,
    databaseBackup: databaseCapture?.backup,
    schemaVersions,
    candidateSchemaVersions,
    previousSchemaVersions,
    previousVerified,
    originalManagedServiceRuntime,
    activationConfig,
  };
}
