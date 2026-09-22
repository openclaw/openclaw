import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ScheduledTaskAutoStartRecoveryError } from "../../daemon/schtasks-update-recovery.js";
import { tryReadJson } from "../../infra/json-files.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-steps.js";
import { validateUpdateCandidateCanary } from "../../infra/update-candidate-canary.js";
import type { UpdateStateSchemaVersion } from "../../infra/update-candidate-state.js";
import {
  createUpdateDoctorConfigWarningStep,
  type UpdateDoctorConfigChange,
} from "../../infra/update-doctor-config.js";
import { resolveUpdateFinalizationTimeoutMs } from "../../infra/update-finalization-budget.js";
import {
  canResolveRegistryVersionForPackageTarget,
  verifyPackageUpdateRecovery,
} from "../../infra/update-global.js";
import { recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import { isFailedUpdateStep } from "../../infra/update-run-step.js";
import { readCurrentGitUpdateRecovery } from "../../infra/update-runner-git-recovery.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { defaultRuntime } from "../../runtime.js";
import {
  parsePackageOpenClawSchemaVersions,
  type OpenClawSchemaVersions,
} from "../../state/openclaw-schema-versions.js";
import { formatCliCommand } from "../command-format.js";
import {
  normalizeTag,
  readPackageVersion,
  resolveGitInstallDir,
  UpdatePreMutationError,
} from "./shared.js";
import {
  inspectUpdateDatabaseContexts,
  revalidateUpdateDatabaseContexts,
} from "./update-command-database-context.js";
import { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";
import type { MutableUpdateExecutionParams } from "./update-command-execution.types.js";
import {
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
import { assertUpdateCommandRecovery } from "./update-command-recovery.js";
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
  shouldBlockMutableUpdateFromGatewayServiceEnv,
  UpdateCommandAbort,
  type PreManagedServiceStop,
} from "./update-command-service.js";
import { verifyPreviousManagedGatewayForUpdate } from "./update-command-verification.js";

export async function executeMutableUpdate(
  params: MutableUpdateExecutionParams,
): Promise<MutableUpdateExecutionResult | null> {
  const { opts, updateStepTimeoutMs } = params;
  const inspectContexts = (roots: string[]) =>
    inspectUpdateDatabaseContexts({
      ...params,
      roots,
      expectedForeground: opts.run?.completionOwner === "gateway-restart" || undefined,
      updateInstallKind: params.updateInstallKind === "git" ? "git" : "package",
      jsonMode: Boolean(opts.json),
      timeoutMs: updateStepTimeoutMs,
    });
  const originalRun = opts.run;
  const requesterAuthority = originalRun?.requesterAuthority;
  const {
    assertCurrent: assertExecutionCurrent,
    assertBoundChildCurrent,
    admitExecutor,
  } = createUpdateCommandExecutionGuards(opts, params.root);
  const prepareMutableUpdate = async (env?: NodeJS.ProcessEnv, activationTimeoutMs?: number) => {
    assertExecutionCurrent();
    await params.prepareMutableUpdate(env, activationTimeoutMs, admitExecutor);
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
      },
      admission,
      versions,
    );
    admittedTargetSchemaVersions = versions;
  };
  const preflightPlugins = async (targetVersion: string | null) => {
    await recheckSchemas(admittedTargetSchemaVersions);
    const { preflightConfiguredNpmPluginTargets } =
      await import("./update-command-plugin-preflight.js");
    const context = admission!.foreground ? admission!.contexts[0]! : admission!.contexts.at(-1)!;
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
  const onTransaction = (transaction: PackageUpdateTransaction) => {
    packageTransaction = transaction;
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
  const doctorConfigChanges: UpdateDoctorConfigChange[] = [];
  let validatedConfigSnapshot: { config: OpenClawConfig; hash?: string | null } | undefined;
  const getDoctorContext: PackageInstallUpdateParams["getDoctorContext"] = () =>
    preparePackageDoctorContext({
      capable: doctorConfigWrites,
      runId: originalRun?.runId,
      executorFence: originalRun?.executorFence,
      requester: requesterAuthority?.requester,
      inputHash: validatedConfigSnapshot?.hash,
      changes: doctorConfigChanges,
      assertCurrent: assertExecutionCurrent,
      assertBoundChildCurrent,
    });
  const originalRecovery = () =>
    params.installKind === "git"
      ? readCurrentGitUpdateRecovery(params.root, updateStepTimeoutMs)
      : verifyPackageUpdateRecovery(params.root);
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
          shouldBlockMutableUpdateFromGatewayServiceEnv({ preManagedServiceStop }) ||
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

    const inspectionFailure = {
      failureFacts: collectServiceInspectionFailureFacts(
        preManagedServiceStop?.serviceUpdateVerdict,
      ),
    };
    if (shouldBlockMutableUpdateFromGatewayServiceEnv({ preManagedServiceStop })) {
      params.stop();
      throw new UpdatePreMutationError(
        "managed-service-preflight",
        [
          `${params.updateInstallKind === "git" ? "Git updates" : "Package updates"} cannot run from inside the gateway service process.`,
          "That path replaces the active OpenClaw dist tree while the live gateway may still lazy-load old chunks.",
          `Run \`${formatCliCommand("openclaw update")}\` from a terminal outside the gateway service.`,
        ].join("\n"),
        inspectionFailure,
      );
    }

    if (preManagedServiceStop?.blockMessage) {
      params.stop();
      throw new UpdatePreMutationError(
        "managed-service-preflight",
        formatUpdateAncestryBlockMessage(preManagedServiceStop.blockMessage),
        inspectionFailure,
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
        validatedConfigSnapshot ?? (await readUpdateCandidateSource(env, params.legacyConfigPlan));
      const validation = await validateUpdateCandidateCanary({
        root,
        config: snapshot.config,
        stateDir: resolveStateDir(env),
        env,
        assertCurrent: assertExecutionCurrent,
        nodeRunner: params.packageUpdateNodeRunner,
        timeoutMs: params.timeoutMs,
        onStep: (step) => params.progress?.onStepComplete?.({ ...step, index: 0, total: 0 }),
      });
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
    const env = ownedManagedUpdateContext?.env ?? opts.run?.env ?? process.env;
    const snapshot = await readUpdateCandidateSource(env, params.legacyConfigPlan);
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
      result = await updateGitInstall({
        root: params.root,
        switchToGit: params.switchToGit,
        installKind: params.installKind,
        timeoutMs: params.timeoutMs,
        startedAt: params.startedAt,
        progress: params.progress,
        channel: params.channel,
        devTarget: params.devTarget,
        assertCurrent: assertExecutionCurrent,
        inspectGitTarget: async (target) => {
          recordInspectedGitTarget(opts.run, target, assertExecutionCurrent);
          await recheckSchemas(target.schemaVersions);
          if (!gitContextPrepared) {
            await stopManagedServiceBeforeMutableUpdate(gitMutationRoots ?? undefined, "inspect");
            await prepareMutableUpdate(admission?.managedEnv);
            // Revalidation retains activation's stop and recovery state.
            gitContextPrepared = true;
          }
        },
        onTransaction,
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
          const steps = await validateCandidate(candidateRoot);
          const failed = steps.find(isFailedUpdateStep);
          if (failed) {
            throw new UpdatePreMutationError(
              failed.name,
              failed.stderrTail ?? "Update checks failed.",
              { failureFacts: failed.failureFacts },
            );
          }
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
      run: params.opts.run,
    }));
  }

  if (candidateFailureReason && result.status === "error") {
    result.reason = candidateFailureReason;
  }
  return {
    result,
    failure,
    mutationStarted,
    preManagedServiceStop,
    ownedManagedUpdateContext,
    recoveryEnv,
    packageTransaction,
    schemaVersions,
    candidateSchemaVersions,
    previousSchemaVersions,
    previousVerified,
    originalManagedServiceRuntime,
    activationConfig,
  };
}
