import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ScheduledTaskAutoStartRecoveryError } from "../../daemon/schtasks-update-recovery.js";
import { tryReadJson } from "../../infra/json-files.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-steps.js";
import type { UpdateStateSchemaVersion } from "../../infra/update-candidate-state.js";
import {
  createUpdateDoctorConfigWarningStep,
  type UpdateDoctorConfigChange,
} from "../../infra/update-doctor-config.js";
import { resolveUpdateFinalizationTimeoutMs } from "../../infra/update-finalization-budget.js";
import { canResolveRegistryVersionForPackageTarget } from "../../infra/update-global.js";
import { updateInstallRootsMatch } from "../../infra/update-install-root.js";
import { recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { defaultRuntime } from "../../runtime.js";
import {
  parsePackageOpenClawSchemaVersions,
  type OpenClawSchemaVersions,
} from "../../state/openclaw-schema-versions.js";
import { formatCliCommand } from "../command-format.js";
import { isCandidateAdmissionContextCovered } from "./schema-preflight.js";
import {
  normalizeTag,
  readPackageVersion,
  resolveGitInstallDir,
  UpdatePreMutationError,
} from "./shared.js";
import { validateUpdateCandidateWithProgress } from "./update-command-candidate-validation.js";
import {
  captureUpdateDatabases,
  restoreFailedUpdateDatabases,
} from "./update-command-database-backup.js";
import {
  inspectUpdateDatabaseContexts,
  revalidateUpdateDatabaseContexts,
} from "./update-command-database-context.js";
import { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";
import type { MutableUpdateExecutionParams } from "./update-command-execution.types.js";
import {
  admitSourceUpdateArtifacts,
  assertGitCandidateSteps,
  assertReadableGitTarget,
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
import { observeOriginalManagedServiceRuntime } from "./update-command-original-service.js";
import {
  runPackageInstallUpdate,
  preparePackageDoctorContext,
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
import { isUpdatedInstallGatewayExecutorSupported } from "./update-command-service-command.js";
import { resolveUpdatedInstallCommandEnv } from "./update-command-service-env.js";
import { GatewayServiceUpdateOwnershipError } from "./update-command-service-plan.js";
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
  const inspectContexts = (roots: string[]) =>
    inspectUpdateDatabaseContexts({
      ...params,
      roots,
      expectedForeground: opts.run?.completionOwner === "gateway-restart" || undefined,
      updateInstallKind: params.updateInstallKind === "git" ? "git" : "package",
      jsonMode: Boolean(opts.json),
      timeoutMs: updateStepTimeoutMs,
      candidateAdmissionChecks,
    });
  const originalRun = opts.run;
  const requesterAuthority = originalRun?.requesterAuthority;
  const {
    assertCurrent: assertExecutionCurrent,
    assertBoundChildCurrent,
    onStateHandoff,
    admitExecutor,
  } = createUpdateCommandExecutionGuards(opts, params.root);
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
        ...params,
        updateInstallKind: params.updateInstallKind === "git" ? "git" : "package",
        jsonMode: Boolean(opts.json),
        timeoutMs: updateStepTimeoutMs,
        candidateAdmissionChecks,
      },
      admission,
      versions,
    );
    admittedTargetSchemaVersions = versions;
  };
  const preflightPlugins = async (targetVersion: string | null) => {
    await recheckSchemas(admittedTargetSchemaVersions);
    const context = admission!.foreground ? admission!.contexts[0]! : admission!.contexts.at(-1)!;
    if (
      candidateAdmissionChecks?.includes("plugin-availability") &&
      isCandidateAdmissionContextCovered(context.env)
    ) {
      return;
    }
    const { preflightConfiguredNpmPluginTargets } =
      await import("./update-command-plugin-preflight.js");
    const warnings = await preflightConfiguredNpmPluginTargets({
      config: context.configSnapshot.sourceConfig,
      env: context.env,
      targetVersion,
      channel: params.channel,
      timeoutMs: params.updateStepTimeoutMs,
    });
    await recheckSchemas(admittedTargetSchemaVersions);
    for (const warning of warnings) {
      defaultRuntime[opts.json ? "error" : "log"](warning.message);
    }
  };
  let recoveryEnv: NodeJS.ProcessEnv | undefined;
  let packageTransaction: PackageUpdateTransaction | undefined;
  let databaseCapture: Awaited<ReturnType<typeof captureUpdateDatabases>> | undefined;
  const onTransaction = async (transaction: PackageUpdateTransaction) => {
    packageTransaction = transaction;
    if (params.updateInstallKind === "package" && originalRun) {
      databaseCapture = await captureUpdateDatabases({
        backupRoot: transaction.backupRoot,
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
  const doctorConfigChanges: UpdateDoctorConfigChange[] = [];
  let validatedConfigSnapshot: { config: OpenClawConfig; hash?: string | null } | undefined;
  const getDoctorContext: PackageInstallUpdateParams["getDoctorContext"] = () => {
    doctorEntered = true;
    return preparePackageDoctorContext({
      capable: doctorConfigWrites,
      runId: originalRun?.runId,
      executorFence: originalRun?.executorFence,
      requester: requesterAuthority?.requester,
      inputHash: validatedConfigSnapshot?.hash,
      changes: doctorConfigChanges,
      databaseBackup: databaseCapture?.backup,
      assertCurrent: assertExecutionCurrent,
      assertBoundChildCurrent,
      onStateHandoff,
    });
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
    if (params.updateInstallKind !== "package" && params.updateInstallKind !== "git") {
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
          updateRun: opts.run,
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
    if (serviceEnvBlock) {
      params.stop();
      throw new UpdatePreMutationError(
        "managed-service-preflight",
        formatUpdateAncestryBlockMessage(serviceEnvBlock.message),
        serviceEnvBlock,
      );
    }

    if (preManagedServiceStop?.blockMessage) {
      params.stop();
      throw new UpdatePreMutationError(
        "managed-service-preflight",
        formatUpdateAncestryBlockMessage(preManagedServiceStop.blockMessage),
        {
          failureFacts:
            preManagedServiceStop.blockFailureFacts ??
            collectServiceInspectionFailureFacts(preManagedServiceStop.serviceUpdateVerdict),
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
    if (opts.run) {
      recordUpdateRunPhase(opts.run.runId, "validating", undefined, { env: opts.run.env });
    }
    const validate = async () => {
      try {
        if (params.updateInstallKind === "package") {
          // The staged manifest owns schema support, including artifacts without registry metadata.
          await recheckSchemas(
            parsePackageOpenClawSchemaVersions(
              await tryReadJson<unknown>(path.join(root, "package.json")),
            ) ?? admittedTargetSchemaVersions,
          );
        } else {
          // Git builds can outlive admission; reject drift before copying state and
          // rehearsing migrations against a configuration activation cannot accept.
          await recheckSchemas(admittedTargetSchemaVersions);
        }
        if (stagedPluginAdmission) {
          // Explicit artifacts acquire their version before rehearsal or activation.
          await preflightPlugins(await readPackageVersion(root));
          await prepareMutableUpdate(ownedManagedUpdateContext?.env ?? admission?.managedEnv);
        }
      } catch (error) {
        if (error instanceof UpdatePreMutationError) {
          candidateFailureReason = error.reason;
        }
        throw error;
      }
      if (
        params.shouldRestart &&
        opts.run &&
        preManagedServiceStop?.serviceUpdateVerdict?.kind === "owned"
      ) {
        const executor = opts.run.executorFence;
        if (!executor) {
          throw new UpdatePreMutationError(
            "target-native-unsupported",
            "Starting the update requires its original update process.",
          );
        }
        const supported = await isUpdatedInstallGatewayExecutorSupported({
          root,
          env: resolveUpdatedInstallCommandEnv({
            processEnv: env,
            invocationCwd: params.invocationCwd,
          }),
          executor,
          timeoutMs: updateStepTimeoutMs,
          nodeRunner: params.packageUpdateNodeRunner,
        });
        assertExecutionCurrent();
        if (!supported) {
          candidateFailureReason = "target-native-unsupported";
          throw new UpdatePreMutationError(
            candidateFailureReason,
            "Target runtime cannot fence update-owned native commands; refusing before Gateway stop or package activation.",
          );
        }
      }
      const snapshot =
        validatedConfigSnapshot ??
        (await readUpdateCandidateSource(env, params.legacyConfigPlan, { configValidation }));
      const validation = await validateUpdateCandidateWithProgress(
        { root, config: snapshot.config, env, assertCurrent: assertExecutionCurrent },
        params,
        originalRun,
      );
      assertExecutionCurrent();
      doctorConfigChanges.push(...(validation.doctorConfigChanges ?? []));
      if (validation.status === "ok") {
        validatedConfigSnapshot = snapshot;
        candidateSchemaVersions = validation.candidateSchemaVersions;
        gatewayRestartCompletion = validation.gatewayRestartCompletion === true;
        doctorConfigWrites = validation.doctorConfigWrites === true;
        observedGatewayStartupMs = validation.steps.find(
          (step) => step.name === "candidate-gateway-startup" && step.exitCode === 0,
        )?.durationMs;
      }
      return validation;
    };
    // Inference repair belongs to triage after the update's terminal failure.
    const validation = await validate();
    candidateFailureReason = validation.status === "error" ? validation.reason : undefined;
    if (validation.status === "ok" && !doctorConfigWrites && doctorConfigChanges.length) {
      const warning = createUpdateDoctorConfigWarningStep(root, doctorConfigChanges);
      validation.steps.push(warning);
      params.progress?.onStepComplete?.({ ...warning, index: 0, total: 0 });
    }
    return validation.steps;
  };
  const beforeActivate = async (roots: readonly string[] = [params.root]) => {
    assertExecutionCurrent();
    if (params.switchToGit && !opts.run?.sourceArtifactLock) {
      await admitSourceUpdateArtifacts(resolveGitInstallDir(), opts.run);
      assertExecutionCurrent();
    }
    const env = ownedManagedUpdateContext?.env ?? opts.run?.env ?? process.env;
    const snapshot = await readUpdateCandidateSource(env, params.legacyConfigPlan, {
      configValidation,
    });
    if (
      validatedConfigSnapshot?.hash !== undefined &&
      snapshot.hash !== validatedConfigSnapshot.hash
    ) {
      throw new UpdatePreMutationError(
        "invalid-config",
        "Config changed during update checks; rerun the update before activating.",
      );
    }
    const config = snapshot.config;
    await recheckSchemas(admittedTargetSchemaVersions);
    const originalServiceVerdict = preManagedServiceStop?.serviceUpdateVerdict;
    const previousRoot =
      originalServiceVerdict?.kind === "owned" && originalServiceVerdict.requiresInstallRootRefresh
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
    originalManagedServiceRuntime = params.shouldRestart
      ? await observeOriginalManagedServiceRuntime(params, preManagedServiceStop)
      : undefined;
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
    if (opts.run) {
      recordUpdateRunPhase(opts.run.runId, "activating", undefined, { env: opts.run.env });
    }
    await stopManagedServiceBeforeMutableUpdate(roots);
    await recheckSchemas(admittedTargetSchemaVersions);
    assertExecutionCurrent();
    const serving = preManagedServiceStop;
    const servingVerdict = serving?.serviceUpdateVerdict;
    if (
      params.updateInstallKind === "git" &&
      serving?.running &&
      !serving.stopped &&
      servingVerdict?.kind === "owned" &&
      roots.some((root) => updateInstallRootsMatch(root, servingVerdict.root))
    ) {
      throw new UpdatePreMutationError(
        "runtime-artifact-publication",
        `Cannot replace Git runtime artifacts in ${servingVerdict.root}: its Gateway${serving.servicePid === undefined ? "" : ` (PID ${serving.servicePid})`} is still running and this update did not stop it. Stop that Gateway through its service manager, then rerun \`${formatCliCommand("openclaw update", serving.serviceEnv)}\` without \`--no-restart\`. The serving runtime was left unchanged.`,
      );
    }
    // Both install paths enter mutation only after the post-stop schema/authority fence.
    preManagedServiceStop?.windowsTaskAutoStartRecovery?.beginMutation();
    mutationStarted = true;
    params.onActivation?.();
  };
  try {
    if (params.updateInstallKind === "package" || params.updateInstallKind === "git") {
      admission = await inspectContexts(gitMutationRoots ?? [params.root]);
    }
    if (params.updateInstallKind === "package") {
      if (!stagedPluginAdmission) {
        await preflightPlugins(params.packageTargetVersion ?? null);
      }
      await stopManagedServiceBeforeMutableUpdate(undefined, "inspect");
      if (!stagedPluginAdmission) {
        await prepareMutableUpdate(admission?.managedEnv);
      }
      const packageUpdate: PackageInstallUpdateParams = {
        // A separate serving root still needs the preparation/activation hooks.
        requirePackageReplacement: params.managedServiceRoot !== undefined,
        reapplyLocalOverrides: opts.reapplyLocalOverrides,
        root: params.root,
        installKind: params.installKind,
        tag: params.tag,
        installSpec: params.packageInstallSpec ?? undefined,
        timeoutMs: updateStepTimeoutMs,
        workTimeoutMs: params.timeoutMs ?? null,
        startedAt: params.startedAt,
        progress: params.progress,
        invocationCwd: params.invocationCwd,
        honorPackageRoot:
          params.managedServiceRootRedirect !== null ||
          params.managedServiceRoot !== undefined ||
          params.managedServiceNodeRunner !== undefined,
        nodeRunner: params.packageUpdateNodeRunner,
        installEnv: params.packageInstallEnv,
        installTarget: params.packageInstallTarget,
        validateCandidate,
        beforeActivate,
        assertCurrent: assertExecutionCurrent,
        managedServiceEnv: preManagedServiceStop?.serviceEnv,
        onTransaction,
        onConfigSnapshot,
        getDoctorContext,
      };
      await recheckSchemas(params.packageTargetSchemaVersions);
      result = params.stagedPackage
        ? await params.stagedPackage.run(packageUpdate)
        : await runPackageInstallUpdate(packageUpdate);
    } else {
      const sourceRoot = params.switchToGit ? resolveGitInstallDir() : params.root;
      const sourceRuntimePrepared = await admitSourceUpdateArtifacts(sourceRoot, opts.run);
      assertExecutionCurrent();
      result = await updateGitInstall({
        root: params.root,
        sourceRuntimePrepared,
        switchToGit: params.switchToGit,
        installKind: params.installKind,
        timeoutMs: params.timeoutMs,
        startedAt: params.startedAt,
        progress: params.progress,
        channel: params.channel,
        devTarget: params.devTarget,
        assertCurrent: assertExecutionCurrent,
        inspectGitTarget: async (target, installTarget) => {
          retentionInstallTarget = installTarget;
          recordInspectedGitTarget(opts.run, target, assertExecutionCurrent);
          await recheckSchemas(target.schemaVersions);
          if (!gitContextPrepared) {
            await stopManagedServiceBeforeMutableUpdate(gitMutationRoots ?? undefined, "inspect");
            await prepareMutableUpdate(admission?.managedEnv);
            // Revalidation retains activation's stop and recovery state.
            gitContextPrepared = true;
          }
        },
        onTransaction: (transaction) => {
          packageTransaction = transaction;
        },
        onConfigSnapshot,
        getDoctorContext,
        // Foreign inspection metadata cannot authorize backup or Doctor writes.
        getManagedServiceEnv: () => ownedManagedUpdateContext?.env,
        getSnapshotSource: async () => {
          const env =
            ownedManagedUpdateContext?.env ?? admission?.managedEnv ?? opts.run?.env ?? process.env;
          const source = await readUpdateCandidateSource(env, params.legacyConfigPlan);
          return { config: source.config, env };
        },
        jsonMode: Boolean(opts.json),
        invocationCwd: params.invocationCwd,
        nodeRunner: params.packageUpdateNodeRunner,
        validateCandidate: async (candidateRoot) => {
          assertGitCandidateSteps(await validateCandidate(candidateRoot));
        },
        beforeGitMutation: async (target) => {
          assertReadableGitTarget(target);
          admittedTargetSchemaVersions = target.schemaVersions;
          await beforeActivate(gitMutationRoots ?? [params.root]);
        },
      });
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
