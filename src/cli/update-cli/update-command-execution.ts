import path from "node:path";
import { readConfigFileSnapshot } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ScheduledTaskAutoStartRecoveryError } from "../../daemon/schtasks-update-recovery.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { tryReadJson } from "../../infra/json-files.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-steps.js";
import { validateUpdateCandidateCanary } from "../../infra/update-candidate-canary.js";
import type { UpdateCandidateRehearsal } from "../../infra/update-candidate-rehearsal.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import {
  createUpdateDoctorConfigWarningStep,
  type UpdateDoctorConfigChange,
} from "../../infra/update-doctor-config.js";
import {
  canResolveRegistryVersionForPackageTarget,
  verifyPackageUpdateRecovery,
} from "../../infra/update-global.js";
import { UpdateRequesterRevokedError } from "../../infra/update-requester-authority.js";
import { recordUpdateRunPhase, recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import { summarizeUpdateStepFailure } from "../../infra/update-run-record.js";
import { readCurrentGitUpdateRecovery } from "../../infra/update-runner-git-recovery.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import {
  parsePackageOpenClawSchemaVersions,
  type OpenClawSchemaVersions,
} from "../../state/openclaw-schema-versions.js";
import { formatCliCommand } from "../command-format.js";
import {
  captureTargetDatabaseSchemaContext,
  checkTargetDatabaseSchemasForContexts,
  formatSchemaRefusalLines,
  hasSchemaRefusal,
} from "./schema-preflight.js";
import {
  normalizeTag,
  readPackageVersion,
  resolveGitInstallDir,
  UpdatePreMutationError,
} from "./shared.js";
import { inspectUpdateDatabaseContexts } from "./update-command-database-context.js";
import type { MutableUpdateExecutionParams } from "./update-command-execution.types.js";
import { createBeforeGitMutation, updateGitInstall } from "./update-command-git.js";
import {
  formatUpdateAncestryBlockMessage,
  handoffUpdateFromGateway,
} from "./update-command-handoff.js";
import {
  captureOwnedManagedUpdateContext,
  revalidateUpdateDatabaseContext,
  type OwnedManagedUpdateContext,
} from "./update-command-managed-context.js";
import {
  runPackageInstallUpdate,
  preparePackageDoctorContext,
  type PackageInstallUpdateParams,
} from "./update-command-package.js";
import { assertUpdateCommandRecovery } from "./update-command-recovery.js";
import { runUpdateCommandRepair } from "./update-command-repair.js";
import type { MutableUpdateExecutionResult } from "./update-command-result.js";
import { isUpdatedInstallGatewayExecutorSupported } from "./update-command-service-command.js";
import {
  resolveUpdatedInstallCommandEnv,
  withOwnedManagedUpdateEnv,
} from "./update-command-service-env.js";
import { GatewayServiceUpdateOwnershipError } from "./update-command-service-plan.js";
import {
  maybeRestartServiceAfterFailedMutableUpdate,
  maybeStopManagedServiceBeforeMutableUpdate,
  shouldBlockMutableUpdateFromGatewayServiceEnv,
  UpdateCommandAbort,
  type PreManagedServiceStop,
} from "./update-command-service.js";
import { verifyPreviousGatewayForUpdate } from "./update-command-verification.js";

export async function executeMutableUpdate(
  params: MutableUpdateExecutionParams,
): Promise<MutableUpdateExecutionResult | null> {
  const { opts, updateStepTimeoutMs, updateInstallKind } = params;
  const mode =
    updateInstallKind === "git" ? "git" : (params.packageInstallTarget?.manager ?? "unknown");
  const originalRun = opts.run;
  const requesterAuthority = originalRun?.requesterAuthority;
  const assertRequesterCurrent = () => {
    if (opts.run !== originalRun || requesterAuthority?.isCurrent() === false) {
      throw new UpdateRequesterRevokedError();
    }
  };
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
    if (!admission) {
      throw new UpdatePreMutationError(
        "database-schema-preflight",
        "Database admission was not inspected.",
      );
    }
    await inspectUpdateDatabaseContexts({
      roots: [...admission.services.keys()],
      updateInstallKind: params.updateInstallKind === "git" ? "git" : "package",
      shouldRestart: params.shouldRestart,
      jsonMode: Boolean(opts.json),
      timeoutMs: updateStepTimeoutMs,
      invocationCwd: params.invocationCwd,
      managedServiceRootRedirect: params.managedServiceRootRedirect,
      expectedServices: admission.services,
      legacyConfigPlan: params.legacyConfigPlan,
    });
    admission.contexts = await Promise.all(admission.contexts.map(revalidateUpdateDatabaseContext));
    const schemas = await checkTargetDatabaseSchemasForContexts(versions, admission.contexts);
    if (hasSchemaRefusal(schemas)) {
      throw new UpdatePreMutationError(
        "database-schema-preflight",
        formatSchemaRefusalLines(schemas).join("\n"),
      );
    }
    admittedTargetSchemaVersions = versions;
  };
  const preflightPlugins = async (targetVersion: string | null) => {
    await recheckSchemas(admittedTargetSchemaVersions);
    const { preflightConfiguredNpmPluginTargets } =
      await import("./update-command-plugin-preflight.js");
    const context = admission!.contexts.at(-1)!;
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
  let schemaVersions: Awaited<ReturnType<typeof readUpdateStateSchemaVersions>> | undefined;
  let candidateSchemaVersions: OpenClawSchemaVersions | undefined;
  let previousSchemaVersions: OpenClawSchemaVersions | undefined;
  let previousVerified = false;
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
      assertCurrent: assertRequesterCurrent,
    });
  const originalRecovery = () =>
    params.installKind === "git"
      ? readCurrentGitUpdateRecovery(params.root)
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
    if (params.updateInstallKind !== "package" && params.updateInstallKind !== "git") {
      return;
    }
    try {
      for (const mutationRoot of new Set(mutationRoots)) {
        preManagedServiceStop = await maybeStopManagedServiceBeforeMutableUpdate({
          updateInstallKind: params.updateInstallKind,
          root: mutationRoot,
          shouldRestart: params.shouldRestart,
          jsonMode: Boolean(opts.json),
          timeoutMs: updateStepTimeoutMs,
          phase,
          expectedService: admission?.services.get(mutationRoot),
          updateRun: opts.run,
          recovery: opts.recovery,
          onStopped: (state) => {
            preManagedServiceStop = state;
          },
          handoffFromGateway: (state) =>
            handoffUpdateFromGateway({
              state,
              root: mutationRoot,
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
        throw new UpdatePreMutationError("managed-service-preflight", err.message);
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

    if (shouldBlockMutableUpdateFromGatewayServiceEnv({ preManagedServiceStop })) {
      params.stop();
      throw new UpdatePreMutationError(
        "managed-service-preflight",
        [
          `${params.updateInstallKind === "git" ? "Git updates" : "Package updates"} cannot run from inside the gateway service process.`,
          "That path replaces the active OpenClaw dist tree while the live gateway may still lazy-load old chunks.",
          `Run \`${formatCliCommand("openclaw update")}\` from a terminal outside the gateway service.`,
        ].join("\n"),
      );
    }

    if (preManagedServiceStop?.blockMessage) {
      params.stop();
      throw new UpdatePreMutationError(
        "managed-service-preflight",
        formatUpdateAncestryBlockMessage(preManagedServiceStop.blockMessage),
      );
    }
  };

  let result: UpdateRunResult;
  let failure: MutableUpdateExecutionResult["failure"];
  let mutationStarted = false;
  const readCandidateSource = async (env: NodeJS.ProcessEnv) => {
    if (params.legacyConfigPlan) {
      const context = await captureTargetDatabaseSchemaContext(env, {
        legacyConfigPlan: params.legacyConfigPlan,
      });
      if (context.legacyConfigPlan) {
        return { config: context.config, hash: context.configSnapshot.hash };
      }
    }
    return withOwnedManagedUpdateEnv(env, () =>
      readConfigFileSnapshot({ skipPluginValidation: true, observe: false }),
    );
  };
  const validateCandidate = async (root: string) => {
    assertUpdateCommandRecovery(opts);
    const env = ownedManagedUpdateContext?.env ?? opts.run?.env ?? process.env;
    if (opts.run) {
      recordUpdateRunPhase(opts.run.runId, "validating", undefined, { env: opts.run.env });
    }
    const validate = async (
      signal?: AbortSignal,
      rehearsal?: UpdateCandidateRehearsal,
      assertCurrent?: () => void,
    ) => {
      signal?.throwIfAborted();
      try {
        if (params.updateInstallKind === "package") {
          // The staged manifest owns schema support, including artifacts without registry metadata.
          await recheckSchemas(
            parsePackageOpenClawSchemaVersions(
              await tryReadJson<unknown>(path.join(root, "package.json")),
            ) ?? admittedTargetSchemaVersions,
          );
          signal?.throwIfAborted();
          assertCurrent?.();
        }
        if (stagedPluginAdmission) {
          // Explicit artifacts acquire their version before rehearsal or activation.
          await preflightPlugins(await readPackageVersion(root));
          signal?.throwIfAborted();
          assertCurrent?.();
          await params.prepareMutableUpdate(
            ownedManagedUpdateContext?.env ?? admission?.managedEnv,
          );
          signal?.throwIfAborted();
          assertCurrent?.();
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
            "Native candidate admission requires its original update executor.",
          );
        }
        const supported = await isUpdatedInstallGatewayExecutorSupported({
          root,
          env: resolveUpdatedInstallCommandEnv({
            processEnv: env,
            invocationCwd: params.invocationCwd,
          }),
          executor,
          nodeRunner: params.packageUpdateNodeRunner,
          signal,
        });
        assertUpdateCommandRecovery(opts);
        if (!supported) {
          candidateFailureReason = "target-native-unsupported";
          throw new UpdatePreMutationError(
            candidateFailureReason,
            "Target runtime cannot fence update-owned native commands; refusing before Gateway stop or package activation.",
          );
        }
      }
      const snapshot = rehearsal
        ? { config: rehearsal.sourceConfig, hash: rehearsal.sourceConfigHash }
        : (validatedConfigSnapshot ?? (await readCandidateSource(env)));
      const validation = await validateUpdateCandidateCanary({
        root,
        config: snapshot.config,
        stateDir: resolveStateDir(env),
        env,
        signal,
        rehearsal,
        assertCurrent,
        nodeRunner: params.packageUpdateNodeRunner,
        timeoutMs: updateStepTimeoutMs,
        onStep: (step) => params.progress?.onStepComplete?.({ ...step, index: 0, total: 0 }),
      });
      assertUpdateCommandRecovery(opts);
      doctorConfigChanges.push(...(validation.doctorConfigChanges ?? []));
      if (validation.status === "ok") {
        validatedConfigSnapshot = snapshot;
        candidateSchemaVersions = validation.candidateSchemaVersions;
        doctorConfigWrites = validation.doctorConfigWrites === true;
      }
      return validation;
    };
    let validation = await validate();
    if (validation.status === "error") {
      candidateFailureReason = validation.reason;
      const repair = await runUpdateCommandRepair({
        root: params.root,
        candidateRoot: root,
        env,
        run: opts.run,
        phase: "validating",
        nodeRunner: params.packageUpdateNodeRunner,
        result: {
          status: "error",
          mode,
          root,
          reason: validation.reason,
          before: { version: await readPackageVersion(params.root) },
          after: { version: await readPackageVersion(root) },
          steps: validation.steps,
          durationMs: validation.durationMs,
        },
        validate: async (signal, assertCurrent, rehearsal) => {
          const repairValidation = await validate(signal, rehearsal, assertCurrent);
          const failedStep = repairValidation.steps.find(
            (step) => step.exitCode !== 0 && !step.advisory,
          );
          return {
            ok: repairValidation.status === "ok",
            score: repairValidation.steps.filter((step) => step.exitCode === 0).length,
            summary:
              repairValidation.status === "ok"
                ? "Update checks passed."
                : failedStep
                  ? summarizeUpdateStepFailure(failedStep)
                  : "Update checks failed.",
          };
        },
      });
      if (repair.status !== "repaired") {
        if (repair.reason === "requester-revoked") {
          candidateFailureReason = repair.reason;
        }
        return validation.steps;
      }
      candidateFailureReason = undefined;
      // Repair's disposable state is gone; only surviving candidate changes may authorize activation.
      validation = await validate();
      candidateFailureReason = validation.status === "error" ? validation.reason : undefined;
    }
    if (validation.status === "ok" && !doctorConfigWrites && doctorConfigChanges.length) {
      const warning = createUpdateDoctorConfigWarningStep(root, doctorConfigChanges);
      validation.steps.push(warning);
      params.progress?.onStepComplete?.({ ...warning, index: 0, total: 0 });
    }
    return validation.steps;
  };
  const beforeActivate = async (roots: readonly string[] = [params.root]) => {
    assertUpdateCommandRecovery(opts);
    assertRequesterCurrent();
    const env = ownedManagedUpdateContext?.env ?? opts.run?.env ?? process.env;
    const snapshot = await readCandidateSource(env);
    if (
      validatedConfigSnapshot?.hash !== undefined &&
      snapshot.hash !== validatedConfigSnapshot.hash
    ) {
      throw new UpdatePreMutationError(
        "invalid-config",
        "Configuration changed during update checks. Rerun the update.",
      );
    }
    const config = snapshot.config;
    await recheckSchemas(admittedTargetSchemaVersions);
    previousSchemaVersions = parsePackageOpenClawSchemaVersions(
      await tryReadJson<unknown>(path.join(params.root, "package.json")),
    );
    schemaVersions = candidateSchemaVersions
      ? await readUpdateStateSchemaVersions({
          stateDir: resolveStateDir(env),
          config,
          env,
        })
      : undefined;
    if (
      preManagedServiceStop?.running &&
      preManagedServiceStop.serviceUpdateVerdict?.kind === "owned"
    ) {
      previousVerified = await verifyPreviousGatewayForUpdate({ root: params.root, config, env });
      if (opts.run) {
        recordUpdateRunStep(
          opts.run.runId,
          {
            step: "previous gateway verification",
            status: "completed",
            detail: previousVerified
              ? "Previous package is running and ready."
              : "Previous gateway was not verified; automatic rollback cannot restart it.",
            endedAtMs: Date.now(),
          },
          { env: opts.run.env },
        );
      }
    }
    // Health and candidate work can outlive the inspected service/config generation.
    await recheckSchemas(admittedTargetSchemaVersions);
    assertUpdateCommandRecovery(opts);
    assertRequesterCurrent();
    if (opts.run) {
      recordUpdateRunPhase(opts.run.runId, "activating", undefined, { env: opts.run.env });
    }
    await stopManagedServiceBeforeMutableUpdate(roots);
    await recheckSchemas(admittedTargetSchemaVersions);
    assertUpdateCommandRecovery(opts);
    assertRequesterCurrent();
    // Git owns this fence after its post-stop schema check completes.
    if (params.updateInstallKind === "package") {
      preManagedServiceStop?.windowsTaskAutoStartRecovery?.beginMutation();
    }
    mutationStarted = true;
    params.onActivation?.();
  };
  try {
    if (params.updateInstallKind === "package" || params.updateInstallKind === "git") {
      admission = await inspectUpdateDatabaseContexts({
        roots: gitMutationRoots ?? [params.root],
        updateInstallKind: params.updateInstallKind,
        shouldRestart: params.shouldRestart,
        jsonMode: Boolean(opts.json),
        timeoutMs: updateStepTimeoutMs,
        invocationCwd: params.invocationCwd,
        managedServiceRootRedirect: params.managedServiceRootRedirect,
        legacyConfigPlan: params.legacyConfigPlan,
      });
    }
    if (params.updateInstallKind === "package") {
      if (!stagedPluginAdmission) {
        await preflightPlugins(params.packageTargetVersion ?? null);
      }
      await stopManagedServiceBeforeMutableUpdate(undefined, "inspect");
      if (!stagedPluginAdmission) {
        await params.prepareMutableUpdate(admission?.managedEnv);
      }
      const packageUpdate: PackageInstallUpdateParams = {
        reapplyLocalOverrides: opts.reapplyLocalOverrides,
        root: params.root,
        installKind: params.installKind,
        tag: params.tag,
        installSpec: params.packageInstallSpec ?? undefined,
        timeoutMs: updateStepTimeoutMs,
        startedAt: params.startedAt,
        progress: params.progress,
        jsonMode: Boolean(opts.json),
        invocationCwd: params.invocationCwd,
        honorPackageRoot:
          params.managedServiceRootRedirect !== null ||
          params.managedServiceNodeRunner !== undefined,
        nodeRunner: params.packageUpdateNodeRunner,
        installEnv: params.packageInstallEnv,
        installTarget: params.packageInstallTarget,
        validateCandidate,
        beforeActivate,
        managedServiceEnv: preManagedServiceStop?.serviceEnv,
        onTransaction: (transaction) => {
          packageTransaction = transaction;
        },
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
        tag: params.tag,
        devTarget: params.devTarget,
        inspectGitTarget: async (target) => {
          if (target.metadataUnreadable) {
            throw new UpdatePreMutationError(
              "target-metadata-preflight",
              `Update refused: could not inspect the target's schema support (${target.metadataUnreadable}).`,
            );
          }
          await recheckSchemas(target.schemaVersions);
          if (!gitContextPrepared) {
            await stopManagedServiceBeforeMutableUpdate(gitMutationRoots ?? undefined, "inspect");
            await params.prepareMutableUpdate(admission?.managedEnv);
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
        invocationCwd: params.invocationCwd,
        nodeRunner: params.packageUpdateNodeRunner,
        validateCandidate: async (candidateRoot) => {
          const steps = await validateCandidate(candidateRoot);
          const failed = steps.find((step) => step.exitCode !== 0 && !step.advisory);
          if (failed) {
            throw new UpdatePreMutationError(failed.name, summarizeUpdateStepFailure(failed), {
              reported: Boolean(params.progress?.onStepComplete),
            });
          }
        },
        beforeGitMutation:
          params.updateInstallKind === "git"
            ? createBeforeGitMutation({
                updateRun: opts.run,
                roots: gitMutationRoots ?? [params.root],
                shouldRestart: params.shouldRestart,
                stopManagedService: beforeActivate,
                getPreManagedServiceStop: () => preManagedServiceStop,
                checkTargetSchemas: recheckSchemas,
                prepareMutableUpdate: () =>
                  params.prepareMutableUpdate(
                    ownedManagedUpdateContext?.env ?? admission?.managedEnv,
                  ),
                switchToGit: params.switchToGit,
              })
            : undefined,
        allowGatewayServiceRepair: false,
        allowGatewayActivation: false,
      });
    }
  } catch (err) {
    params.stop();
    if (err instanceof UpdateCommandAbort) {
      return null;
    }
    const preMutationFailure = err instanceof UpdatePreMutationError;
    const message = formatErrorMessage(err);
    failure = { cause: err, detail: message };
    if (!(err instanceof UpdatePreMutationError && err.reported)) {
      defaultRuntime.error(message);
    }
    const durationMs = Date.now() - params.startedAt;
    // Only explicit pre-mutation refusal permits original-runtime recovery.
    // Mutable exceptions retain an unsafe outcome through cleanup/reporting.
    result = {
      status: "error",
      mode,
      root: params.root,
      reason:
        err instanceof UpdateRequesterRevokedError
          ? err.code
          : preMutationFailure
            ? err.reason
            : "update-failed",
      recovery: preMutationFailure
        ? await originalRecovery()
        : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      steps: [
        {
          name: preMutationFailure ? err.reason : "update",
          command: "openclaw update",
          cwd: params.root,
          durationMs,
          exitCode: 1,
          ...(isAbortError(err) ? { termination: "signal" as const } : {}),
          stderrTail: message,
        },
      ],
      durationMs,
    };
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
    activationConfig,
  };
}
