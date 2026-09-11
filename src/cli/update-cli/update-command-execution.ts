import path from "node:path";
import { readConfigFileSnapshot } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ScheduledTaskAutoStartRecoveryError } from "../../daemon/schtasks-update-recovery.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { tryReadJson } from "../../infra/json-files.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-steps.js";
import { validateUpdateCandidateCanary } from "../../infra/update-candidate-canary.js";
import type { UpdateCandidateRehearsal } from "../../infra/update-candidate-rehearsal.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import {
  canResolveRegistryVersionForPackageTarget,
  verifyPackageUpdateRecovery,
} from "../../infra/update-global.js";
import type { UpdateRecoveryBackupRef } from "../../infra/update-recovery-backup-contract.js";
import { recordUpdateRunPhase, recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import { readCurrentGitUpdateRecovery } from "../../infra/update-runner-git-recovery.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import {
  parsePackageOpenClawSchemaVersions,
  type OpenClawSchemaVersions,
} from "../../state/openclaw-schema-versions.js";
import { formatCliCommand } from "../command-format.js";
import {
  inspectGatewayRestart,
  waitForGatewayHttpReadiness,
} from "../daemon-cli/restart-health.js";
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
import {
  assertUpdateCommandBackupRecovery,
  createUpdateCommandBackup,
  preflightUpdateCommandBackup,
} from "./update-command-backup-lifecycle.js";
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
import {
  GatewayServiceUpdateOwnershipError,
  gatewayServiceCommandUsesRoot,
} from "./update-command-service-plan.js";
import {
  maybeRestartServiceAfterFailedMutableUpdate,
  maybeStopManagedServiceBeforeMutableUpdate,
  resolveUpdatedGatewayRestartPort,
  shouldBlockMutableUpdateFromGatewayServiceEnv,
  UpdateCommandAbort,
  type PreManagedServiceStop,
} from "./update-command-service.js";

export async function executeMutableUpdate(
  params: MutableUpdateExecutionParams,
): Promise<MutableUpdateExecutionResult | null> {
  const { opts, updateStepTimeoutMs } = params;
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
    await recheckSchemas(params.packageTargetSchemaVersions);
    const { preflightConfiguredNpmPluginTargets } =
      await import("./update-command-plugin-preflight.js");
    const context = admission!.contexts.at(-1)!;
    await preflightConfiguredNpmPluginTargets({
      config: context.configSnapshot.sourceConfig,
      env: context.env,
      targetVersion,
      channel: params.channel,
      timeoutMs: params.updateStepTimeoutMs,
    });
    await recheckSchemas(params.packageTargetSchemaVersions);
  };
  let recoveryEnv: NodeJS.ProcessEnv | undefined;
  let packageTransaction: PackageUpdateTransaction | undefined;
  let unchangedCore: MutableUpdateExecutionResult["unchangedCore"];
  let updateRecoveryBackup: UpdateRecoveryBackupRef | undefined;
  const doctorEnv = () => ownedManagedUpdateContext?.env ?? opts.run?.env ?? process.env;
  let schemaVersions: Awaited<ReturnType<typeof readUpdateStateSchemaVersions>> | undefined;
  let candidateSchemaVersions: OpenClawSchemaVersions | undefined;
  let candidateUpdateRecovery: "parent-v1" | undefined;
  const doctorRecoveryBackup = () =>
    candidateUpdateRecovery === "parent-v1" ? updateRecoveryBackup : undefined;
  let previousSchemaVersions: OpenClawSchemaVersions | undefined;
  let previousVerified = false;
  let activationConfig: MutableUpdateExecutionResult["activationConfig"];
  const onConfigSnapshot: PackageInstallUpdateParams["onConfigSnapshot"] = (snapshot) => {
    activationConfig = snapshot;
  };
  let candidateFailureReason: string | undefined;
  let validatedConfigSnapshot: { config: OpenClawConfig; hash?: string | null } | undefined;
  const originalRecovery = () =>
    params.installKind === "git"
      ? readCurrentGitUpdateRecovery(params.root)
      : verifyPackageUpdateRecovery(params.root);
  const recoverStoppedService = async () =>
    maybeRestartServiceAfterFailedMutableUpdate({
      recovery: await originalRecovery(),
      preManagedServiceStop,
      jsonMode: Boolean(opts.json),
      nodeRunner: params.packageUpdateNodeRunner,
      timeoutMs: updateStepTimeoutMs,
      invocationCwd: params.invocationCwd,
    });
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
              mode:
                params.updateInstallKind === "git"
                  ? "git"
                  : (params.packageInstallTarget?.manager ?? "unknown"),
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
      await recoverStoppedService();
      throw new Error(`Failed to capture managed gateway update state: ${String(err)}`, {
        cause: err,
      });
    }

    if (shouldBlockMutableUpdateFromGatewayServiceEnv({ preManagedServiceStop })) {
      params.stop();
      const updateLabel = params.updateInstallKind === "git" ? "Git updates" : "Package updates";
      throw new UpdatePreMutationError(
        "managed-service-preflight",
        [
          `${updateLabel} cannot run from inside the gateway service process.`,
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
    if (!params.legacyConfigPlan) {
      return withOwnedManagedUpdateEnv(env, () =>
        readConfigFileSnapshot({ skipPluginValidation: true, observe: false }),
      );
    }
    const context = await captureTargetDatabaseSchemaContext(env, {
      legacyConfigPlan: params.legacyConfigPlan,
    });
    if (!context.legacyConfigPlan) {
      return withOwnedManagedUpdateEnv(env, () =>
        readConfigFileSnapshot({ skipPluginValidation: true, observe: false }),
      );
    }
    return { config: context.config, hash: context.configSnapshot.hash };
  };
  const validateCandidate = async (root: string) => {
    assertUpdateCommandRecovery(opts);
    const env = ownedManagedUpdateContext?.env ?? opts.run?.env ?? process.env;
    if (opts.run) {
      recordUpdateRunPhase(opts.run.runId, "validating", undefined, {
        env: opts.run.env,
      });
    }
    const validate = async (
      signal?: AbortSignal,
      rehearsal?: UpdateCandidateRehearsal,
      assertCurrent?: () => void,
    ) => {
      signal?.throwIfAborted();
      if (stagedPluginAdmission) {
        // Explicit artifacts acquire their version from the private staged package,
        // before rehearsal or activation can mutate any serving state.
        try {
          await preflightPlugins(await readPackageVersion(root));
          signal?.throwIfAborted();
          assertCurrent?.();
          await params.prepareMutableUpdate(
            ownedManagedUpdateContext?.env ?? admission?.managedEnv,
          );
          signal?.throwIfAborted();
          assertCurrent?.();
        } catch (error) {
          if (error instanceof UpdatePreMutationError) {
            candidateFailureReason = error.reason;
          }
          throw error;
        }
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
      if (validation.status === "ok") {
        validatedConfigSnapshot = snapshot;
        candidateSchemaVersions = validation.candidateSchemaVersions;
        candidateUpdateRecovery = validation.candidateUpdateRecovery;
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
          mode:
            params.updateInstallKind === "git"
              ? "git"
              : (params.packageInstallTarget?.manager ?? "unknown"),
          root,
          reason: validation.reason,
          before: { version: await readPackageVersion(params.root) },
          after: { version: await readPackageVersion(root) },
          steps: validation.steps,
          durationMs: validation.durationMs,
        },
        validate: async (signal, assertCurrent, rehearsal) => {
          const repairValidation = await validate(signal, rehearsal, assertCurrent);
          return {
            ok: repairValidation.status === "ok",
            score: repairValidation.steps.filter((step) => step.exitCode === 0).length,
            summary:
              repairValidation.status === "ok"
                ? "Candidate validation passed."
                : repairValidation.logTail.join("\n"),
          };
        },
      });
      if (repair.status !== "repaired") {
        if (
          repair.reason === "repair-requires-config-change" ||
          repair.reason === "requester-revoked"
        ) {
          candidateFailureReason = repair.reason;
        }
        return validation.steps;
      }
      candidateFailureReason = undefined;
      // Repair's disposable state is gone; only surviving candidate changes may authorize activation.
      validation = await validate();
      if (validation.status === "error") {
        candidateFailureReason = validation.reason;
      }
    }
    return validation.steps;
  };
  const beforeActivate = async (roots: readonly string[] = [params.root]) => {
    assertUpdateCommandRecovery(opts);
    const env = ownedManagedUpdateContext?.env ?? opts.run?.env ?? process.env;
    const snapshot = await readCandidateSource(env);
    if (
      validatedConfigSnapshot?.hash !== undefined &&
      snapshot.hash !== validatedConfigSnapshot.hash
    ) {
      throw new UpdatePreMutationError(
        "invalid-config",
        "Config changed during candidate validation; rerun the update before activating.",
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
      const port = await resolveUpdatedGatewayRestartPort({ config, serviceEnv: env });
      const [expectedVersion, expectedBuildId] = await Promise.all([
        readPackageVersion(params.root),
        readBuiltGatewayBuildId(params.root),
      ]);
      const [health, readiness, servesPreviousPackage] = await Promise.all([
        inspectGatewayRestart({
          service: resolveGatewayService(),
          env,
          port,
          expectedVersion,
          expectedBuildId: expectedBuildId ?? undefined,
        }),
        waitForGatewayHttpReadiness({
          config,
          port,
          deadlineAt: Date.now() + 3_000,
          attempts: 1,
          delayMs: 0,
        }),
        gatewayServiceCommandUsesRoot({ root: params.root, env }),
      ]);
      previousVerified = Boolean(
        expectedVersion &&
        servesPreviousPackage === true &&
        health.healthy &&
        health.runtime.status === "running" &&
        readiness.readyz === 200,
      );
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
    if (opts.run) {
      recordUpdateRunPhase(opts.run.runId, "activating", undefined, {
        env: opts.run.env,
      });
      await preflightUpdateCommandBackup({ opts, root: params.root, env });
    }
    await stopManagedServiceBeforeMutableUpdate(roots);
    await recheckSchemas(admittedTargetSchemaVersions);
    assertUpdateCommandRecovery(opts);
    if (opts.run) {
      try {
        updateRecoveryBackup = await createUpdateCommandBackup({ opts, root: params.root, env });
      } catch (cause) {
        assertUpdateCommandRecovery(opts);
        throw new UpdatePreMutationError("update-capture-failed", formatErrorMessage(cause), {
          cause,
        });
      }
      assertUpdateCommandRecovery(opts);
    }
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
    await assertUpdateCommandBackupRecovery({
      opts,
      root: params.root,
      env: admission?.managedEnv ?? opts.run?.env ?? process.env,
    });
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
        managedServiceEnv: preManagedServiceStop?.serviceEnv ?? opts.run?.env,
        get updateRecoveryBackup() {
          return doctorRecoveryBackup();
        },
        onTransaction: (transaction) => {
          packageTransaction = transaction;
        },
        onConfigSnapshot,
      };
      await recheckSchemas(params.packageTargetSchemaVersions);
      result = await runPackageInstallUpdate(packageUpdate);
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
        onUnchangedCore: (core) => {
          unchangedCore = core;
        },
        onConfigSnapshot,
        // Foreign inspection metadata cannot authorize backup or Doctor writes.
        getManagedServiceEnv: doctorEnv,
        getUpdateRecoveryBackup: doctorRecoveryBackup,
        invocationCwd: params.invocationCwd,
        nodeRunner: params.packageUpdateNodeRunner,
        validateCandidate: async (candidateRoot) => {
          const steps = await validateCandidate(candidateRoot);
          const failed = steps.find((step) => step.exitCode !== 0 && !step.advisory);
          if (failed) {
            throw new UpdatePreMutationError(
              failed.name,
              failed.stderrTail ?? "Candidate validation failed.",
            );
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
    defaultRuntime.error(message);
    const durationMs = Date.now() - params.startedAt;
    // Only explicit pre-mutation refusal permits original-runtime recovery.
    // Mutable exceptions retain an unsafe outcome through cleanup/reporting.
    result = {
      status: "error",
      mode:
        params.updateInstallKind === "git"
          ? "git"
          : (params.packageInstallTarget?.manager ?? "unknown"),
      root: params.root,
      reason: preMutationFailure ? err.reason : "update-failed",
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
    unchangedCore,
    updateRecoveryBackup,
    schemaVersions,
    candidateSchemaVersions,
    candidateUpdateRecovery,
    previousSchemaVersions,
    previousVerified,
    activationConfig,
  };
}
