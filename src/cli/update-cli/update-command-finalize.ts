import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { beginDoctorMaintenance } from "../../commands/doctor-maintenance.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  readConfigFileSnapshot,
} from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { copyErrorDiagnostic } from "../../infra/error-diagnostics.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  DEFAULT_PACKAGE_CHANNEL,
  normalizeUpdateChannel,
  type UpdateChannel,
  UPDATE_EFFECTIVE_CHANNEL_ENV,
} from "../../infra/update-channels.js";
import { resolveUpdateInstallKind } from "../../infra/update-check.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import { normalizeUpdatePostInstallDoctorWarnings } from "../../infra/update-doctor-result.js";
import { POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV } from "../../infra/update-post-core-context.js";
import type { UpdateRecoveryBackupRef } from "../../infra/update-recovery-backup-contract.js";
import {
  persistUpdateRecoveryConfigWrites,
  withUpdateRecoveryConfigWrites,
} from "../../infra/update-recovery-config-writes.js";
import { UpdateRecoveryPublicationUnavailableError } from "../../infra/update-recovery-publication.js";
import {
  acknowledgeAbandonedUpdateRun,
  getUpdateRun,
  reconcileAbandonedUpdateRuns,
  recordUpdateRunDiagnostic,
} from "../../infra/update-run-ledger.js";
import {
  assertUpdateRecoveryAdmission,
  bindUnprotectedGatewayUpdateFinalizer,
  readUnprotectedGatewayUpdateParent,
} from "../../infra/update-run-recovery-admission.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { UpdateRecoveryRequiredError } from "../../infra/update-run-recovery.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { createNonExitingRuntime, defaultRuntime } from "../../runtime.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../../state/openclaw-state-ownership.js";
import { exitCliAfterOutput } from "../one-shot-exit.js";
import { retainCliProcessJobUntilExit } from "../runtime-cleanup-scope.js";
import {
  parseTimeoutMsOrExit,
  parseUpdateTimeoutMs,
  readPackageVersion,
  resolveUpdateRoot,
  tryResolveInvocationCwd,
  tryWriteCompletionCache,
  type UpdateFinalizeOptions,
} from "./shared.js";
import { suppressDeprecations } from "./suppress-deprecations.js";
import { createUpdateCommandBackup } from "./update-command-backup-lifecycle.js";
import { createUpdateConfigSnapshot } from "./update-command-config-snapshot.js";
import {
  persistRequestedUpdateChannel,
  preparePostCorePluginConfig,
  persistValidatedDowngradeConfig,
  readPostCorePreUpdateSourceConfig,
} from "./update-command-config.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import {
  completePostCorePluginUpdate,
  runUpdateFinalizationDoctorInFreshProcess,
  withPrePluginUpdateDoctorEnv,
} from "./update-command-fresh-doctor.js";
import {
  collectPostCorePluginAdvisories,
  collectPostCorePluginFailureFacts,
} from "./update-command-plugins-internals.js";
import {
  updatePluginsAfterCoreUpdate,
  type PostCorePluginUpdateResult,
} from "./update-command-plugins.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";
import {
  UpdateCommandFinalizedRecoveryFailure,
  UpdateCommandFailure,
  withUpdateAdmissionReporting,
  UpdateCommandPendingRecoveryFailure,
} from "./update-command-result.js";
import {
  hasUnsettledUpdateProcesses,
  restoreUpdateRecoveryState,
} from "./update-command-rollback-state.js";
import { completeSourceUpdateRuntime } from "./update-command-runtime.js";
import {
  resolveServiceRefreshEnv,
  withOwnedManagedUpdateEnv,
  withUpdateInProgressEnv,
} from "./update-command-service-env.js";
import { reportPreMutationUpdateResult } from "./update-command-terminal.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";
import {
  UpdateFinalizationLifecycle,
  type UpdateFinalizationPhase,
} from "./update-finalization-lifecycle.js";
import { withUpdateFinalizationMaintenance } from "./update-finalization-maintenance.js";

export async function updateFinalizeCommand(
  opts: UpdateFinalizeOptions,
  recoveryRunIds?: readonly string[],
): Promise<void> {
  const invocationCwd = tryResolveInvocationCwd();
  suppressDeprecations();
  const timeoutMs = parseTimeoutMsOrExit(opts.timeout);
  if (timeoutMs === null) {
    return;
  }
  const requestedChannel = normalizeUpdateChannel(opts.channel);
  if (opts.channel !== undefined && !requestedChannel) {
    defaultRuntime.error(
      `--channel must be "stable", "extended-stable", "beta", or "dev" (got "${opts.channel}")`,
    );
    defaultRuntime.exit(1);
    return;
  }

  let exitCode: number | undefined;
  await withCommandProcessScope(async (stopChildren) => {
    const lifecycle = new UpdateFinalizationLifecycle(Boolean(opts.json), timeoutMs, stopChildren);
    try {
      const { root, installKind, runId, unprotected } = await withUpdateAdmissionReporting(
        opts,
        () =>
          withCommandProcessScope(() =>
            withUpdateInProgressEnv(invocationCwd, () =>
              lifecycle.run("preflight", async (phase) => {
                // Refused invocations cannot create a ledger or write failure-triage artifacts.
                // A missing canonical path can be an interrupted publication, not a
                // fresh installation. Only the recovery executor may reconcile it.
                await assertUpdateRecoveryAdmission({ env: process.env });
                assertConfigWriteAllowedInCurrentMode();
                await assertOpenClawStateWriteAllowedAtPath({
                  databasePath: resolveOpenClawStateSqlitePath(process.env),
                  recoverOrphanedSidecars: false,
                });
                await retainCliProcessJobUntilExit();
                phase.assertCurrent();
                const parent = readUnprotectedGatewayUpdateParent();
                const unprotectedParent = parent
                  ? bindUnprotectedGatewayUpdateFinalizer(parent)
                  : undefined;
                // Public repair supplies a recovery selection, even when it is empty.
                const admittedRunId = lifecycle.attachLedger(recoveryRunIds !== undefined);
                const resolvedRoot = await resolveUpdateRoot();
                const resolvedInstallKind = await resolveUpdateInstallKind(resolvedRoot, {
                  timeoutMs: lifecycle.budget("preflight"),
                });
                lifecycle.recordInstallKind(
                  resolvedInstallKind,
                  await readPackageVersion(resolvedRoot),
                );
                return {
                  root: resolvedRoot,
                  installKind: resolvedInstallKind,
                  runId: admittedRunId,
                  unprotected: unprotectedParent,
                };
              }),
            ),
          ),
        recoveryRunIds === undefined ? "finalize" : "unknown",
      );
      lifecycle.root = root;
      const target = {
        root,
        env: {
          ...resolveServiceRefreshEnv(process.env, invocationCwd),
          [UPDATE_RUN_ID_ENV]: runId,
        },
      };
      const run = { runId, env: target.env };
      await withUpdateFailureTriage({ ...opts, invocationCwd, run }, target, () =>
        withUpdateInProgressEnv(invocationCwd, async () => {
          let finalResult: Awaited<ReturnType<typeof updateFinalizeCommandInternal>> | undefined;
          try {
            const finalize = async (recovery: FinalizationRecovery) => {
              lifecycle.updateRecoveryBackup = recovery.backup;
              const prepared = await lifecycle.run("targetConfigValidation", (phase) =>
                prepareUpdateFinalization(opts, root, installKind, requestedChannel, {
                  ...phase,
                  assertCurrent() {
                    phase.assertCurrent();
                    recovery.assertCurrent();
                  },
                }),
              );
              const result = await updateFinalizeCommandInternal(
                opts,
                prepared,
                lifecycle,
                recovery,
                runId,
              );
              finalResult = result;
              if (result.status === "error") {
                throw new UpdateCommandFailure({
                  status: "error",
                  mode: "unknown",
                  root,
                  reason: "post-update-plugins",
                  postUpdate: { plugins: result.postUpdate.plugins },
                  steps: [],
                  durationMs: Math.round(performance.now() - lifecycle.startedAt),
                });
              }
              return result;
            };
            const result = await withOwnedManagedUpdateEnv(
              { ...run.env, [UPDATE_RUN_ID_ENV]: run.runId },
              () =>
                unprotected
                  ? finalize({
                      assertCurrent: unprotected.assertCurrent,
                      updateRecoveryOwner: "unprotected",
                      beforeDoctor: async () => unprotected.assertCurrent(),
                    })
                  : withUpdateFinalizationMaintenance(
                      {
                        repair: recoveryRunIds !== undefined,
                        root,
                        runId,
                        json: opts.json,
                        recoveryPending: (error) =>
                          asPendingFinalizationFailure(error, root, runId) !== undefined,
                      },
                      () => withFinalizationRecovery(root, run, finalize),
                    ),
            );
            if (recoveryRunIds?.length) {
              const reconciled = reconcileAbandonedUpdateRuns({
                explicit: true,
                runIds: recoveryRunIds,
              });
              if (
                recoveryRunIds.some(
                  (recoveryRunId) => getUpdateRun(recoveryRunId)?.status === "running",
                )
              ) {
                throw new Error(
                  "An update resumed while repair was running; wait for that update before retrying repair.",
                );
              }
              for (const recoveryRunId of recoveryRunIds) {
                acknowledgeAbandonedUpdateRun(recoveryRunId);
              }
              Object.assign(result, { reconciledRuns: reconciled.map((record) => record.runId) });
            }
            lifecycle.complete(0);
            if (opts.json) {
              defaultRuntime.writeJson(result);
            } else {
              defaultRuntime.log(
                result.status === "ok"
                  ? theme.muted("Update finalization completed.")
                  : theme.warn("Update finalization completed with warnings."),
              );
            }
          } catch (error) {
            // Executor and child settlement sit outside recovery's catch. Never
            // let their pending authority enter ordinary failure/triage reporting.
            const pending = asPendingFinalizationFailure(error, root, run.runId);
            if (pending) {
              throw pending;
            }
            if (
              error instanceof UpdateCommandFailure &&
              !(error instanceof UpdateCommandPendingRecoveryFailure)
            ) {
              lifecycle.complete(error.exitCode);
              if (finalResult) {
                if (opts.json) {
                  defaultRuntime.writeJson(finalResult);
                } else {
                  defaultRuntime.log(theme.error("Update finalization failed."));
                }
              }
            }
            throw error;
          }
        }),
      );
    } catch (error) {
      if (
        error instanceof UpdateCommandFinalizedRecoveryFailure &&
        !hasCommandProcessCleanupError(error)
      ) {
        lifecycle.complete(error.exitCode);
        exitCode = error.exitCode;
        return;
      }
      if (!lifecycle.completed) {
        lifecycle.fail(error);
      }
      throw error;
    } finally {
      lifecycle.finishRecovery();
    }
  });
  if (exitCode !== undefined) {
    exitCliAfterOutput(defaultRuntime, exitCode);
  }
}

function asPendingFinalizationFailure(error: unknown, root: string, runId: string) {
  if (error instanceof UpdateCommandPendingRecoveryFailure) {
    return error;
  }
  const causes = collectNestedErrorCandidates(error);
  if (
    !hasUnsettledUpdateProcesses(error) &&
    !causes.some(
      (cause) =>
        cause instanceof UpdateCommandRecoveryPendingError ||
        cause instanceof UpdateRecoveryRequiredError ||
        cause instanceof UpdateCommandPendingRecoveryFailure,
    )
  ) {
    return undefined;
  }
  // Nested results supply failure facts only. The pending owner clears restart
  // safety and never recovers the nested ordinary exception's triage policy.
  const primary = causes.find((cause) => cause instanceof UpdateCommandFailure);
  return new UpdateCommandPendingRecoveryFailure(
    primary instanceof UpdateCommandFailure
      ? primary.result
      : {
          status: "error",
          mode: "unknown",
          root,
          runId,
          reason: "finalization-settlement-pending",
          steps: [],
          durationMs: 0,
        },
    formatErrorMessage(error),
    { cause: error },
  );
}

type FinalizationRecovery = {
  executorFence?: UpdateRecoveryFence;
  backup?: UpdateRecoveryBackupRef;
  updateRecoveryOwner?: "unprotected";
  assertCurrent: () => void;
  beforeDoctor: () => Promise<void>;
};

async function withFinalizationRecovery<T>(
  root: string,
  run: { runId: string; env: NodeJS.ProcessEnv },
  operation: (recovery: FinalizationRecovery) => Promise<T>,
): Promise<T> {
  return await withUpdateCommandExecutor(run.runId, async (executor) => {
    const fence = await executor.enter(root);
    const backup = await createUpdateCommandBackup({
      opts: { run: { ...run, executorFence: fence } },
      root,
      env: process.env,
    });
    const authority = { assertOwned: () => fence.assertCurrent() };
    const guidance = `Update recovery capture retained at ${backup.manifestPath}. Inspect with openclaw update status --json; resolve with npx openclaw@latest doctor --fix.`;
    const report = () => {
      defaultRuntime.error(guidance);
      try {
        fence.assertCurrent();
        recordUpdateRunDiagnostic(run.runId, guidance, { env: run.env });
      } catch {
        // The retained capture and stderr remain inspectable if reporting fails.
      }
    };
    try {
      const result = await withUpdateRecoveryConfigWrites(backup, authority, () =>
        withCommandProcessScope(() =>
          operation({
            backup,
            executorFence: fence,
            assertCurrent: authority.assertOwned,
            beforeDoctor: async () => {
              await persistUpdateRecoveryConfigWrites(backup, authority);
              authority.assertOwned();
            },
          }),
        ),
      );
      // Finalization never starts the Gateway and cannot establish runtime health.
      report();
      return result;
    } catch (error) {
      report();
      const pending = asPendingFinalizationFailure(error, root, run.runId);
      if (pending) {
        throw pending;
      }
      try {
        authority.assertOwned();
        const recoveryMaintenance = await beginDoctorMaintenance({
          root: null,
          options: { repair: true },
          runtime: defaultRuntime,
        });
        if (!recoveryMaintenance) {
          throw new Error("Update finalization could not enter offline recovery maintenance.", {
            cause: error,
          });
        }
        let reverseFailure: { error: unknown } | undefined;
        try {
          await recoveryMaintenance.closeStores();
          const { warnings } = await restoreUpdateRecoveryState(backup, {
            assertOwned() {
              authority.assertOwned();
              recoveryMaintenance.assertCurrent();
            },
          });
          for (const warning of warnings) {
            defaultRuntime.error(`Warning: ${warning}`);
          }
        } catch (cause) {
          reverseFailure = { error: cause };
        }
        if (reverseFailure && hasUnsettledUpdateProcesses(reverseFailure.error)) {
          throw reverseFailure.error;
        }
        try {
          await recoveryMaintenance.release();
          authority.assertOwned();
        } catch (cause) {
          throw new AggregateError(
            [...(reverseFailure ? [reverseFailure.error] : []), cause],
            "Finalization recovery settlement failed.",
            { cause },
          );
        }
        if (reverseFailure) {
          throw reverseFailure.error;
        }
      } catch (cause) {
        const combined = new AggregateError(
          [error, cause],
          `Update finalization recovery failed. ${guidance}`,
          { cause },
        );
        if (cause instanceof UpdateRecoveryPublicationUnavailableError) {
          // Only a cleanly released, no-publication refusal preserves ordinary
          // failure policy. The enclosing executor must still settle before reporting.
          defaultRuntime.error(formatErrorMessage(cause));
          if (!(error instanceof UpdateCommandFailure)) {
            // A no-publication refusal did not replace the original operation's
            // outcome. Preserve cancellation/error identity for its settlement owner;
            // the retained capture and refusal have already been reported above.
            throw error;
          }
          const failure = new UpdateCommandFailure(error.result, error.exitCode, error.detail, {
            cause: combined,
            automaticTriage: error.automaticTriage,
          });
          copyErrorDiagnostic(error, failure);
          throw failure;
        }
        throw new UpdateCommandPendingRecoveryFailure(
          error instanceof UpdateCommandFailure
            ? error.result
            : {
                status: "error",
                mode: "unknown",
                root,
                runId: run.runId,
                reason: "finalization-recovery-pending",
                steps: [],
                durationMs: 0,
              },
          `${formatErrorMessage(error)}; ${formatErrorMessage(cause)} ${guidance}`,
          { cause: combined },
        );
      }
      throw error;
    }
  });
}

async function prepareUpdateFinalization(
  opts: UpdateFinalizeOptions,
  root: string,
  installKind: "git" | "package" | "unknown",
  requestedChannel: UpdateChannel | null,
  phase: UpdateFinalizationPhase,
) {
  await assertOpenClawStateWriteAllowedAtPath({
    databasePath: resolveOpenClawStateSqlitePath(process.env),
  });
  let configSnapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
  const preFinalizeConfig =
    (await readPostCorePreUpdateSourceConfig({
      sourceConfigPath: process.env[POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV],
      currentSnapshot: configSnapshot,
    })) ??
    (configSnapshot.valid
      ? {
          sourceConfig: configSnapshot.sourceConfig,
          authoredConfig: isRecord(configSnapshot.parsed)
            ? (configSnapshot.parsed as OpenClawConfig) // SAFETY: snapshot parser validated this config record.
            : configSnapshot.sourceConfig,
        }
      : undefined);
  if (requestedChannel === "extended-stable" && installKind === "git") {
    await reportPreMutationUpdateResult({
      root,
      installKind,
      reason: "unsupported_git_channel",
      opts,
      controlPlaneUpdateSentinelMeta: null,
    });
  }
  const storedChannel = configSnapshot.valid
    ? normalizeUpdateChannel(configSnapshot.config.update?.channel)
    : null;
  // Effective channel the core update actually ran on (e.g. git/dev for an
  // unconfigured source update), passed by the caller via env. Used only as a
  // convergence fallback; it is never persisted (that stays gated on
  // `requestedChannel`), so a default source update does not write update.channel.
  const effectiveChannel = normalizeUpdateChannel(
    process.env[UPDATE_EFFECTIVE_CHANNEL_ENV]?.trim(),
  );
  const channel = requestedChannel ?? storedChannel ?? effectiveChannel ?? DEFAULT_PACKAGE_CHANNEL;
  if (requestedChannel) {
    configSnapshot = await withPluginLifecycleLease(phase, async () => {
      const snapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
      return await persistRequestedUpdateChannel({
        configSnapshot: snapshot,
        requestedChannel,
        assertCurrent: phase.assertCurrent,
        beforePersistentEffect: phase.assertCurrent,
      });
    });
  }
  return {
    root,
    installKind,
    configSnapshot,
    preFinalizeConfig,
    requestedChannel,
    storedChannel,
    effectiveChannel,
    channel,
  };
}

async function updateFinalizeCommandInternal(
  opts: UpdateFinalizeOptions,
  prepared: Awaited<ReturnType<typeof prepareUpdateFinalization>>,
  lifecycle: UpdateFinalizationLifecycle,
  recovery: FinalizationRecovery,
  invokingRunId: string,
) {
  const { root, preFinalizeConfig, requestedChannel, storedChannel, effectiveChannel, channel } =
    prepared;
  let { configSnapshot } = prepared;
  let doctorWarnings: string[] = [];
  const onDoctorWarnings = (warnings: string[]) => {
    doctorWarnings = normalizeUpdatePostInstallDoctorWarnings([
      ...new Set([...doctorWarnings, ...warnings]),
    ]);
    lifecycle.recordWarnings(doctorWarnings);
  };

  if (prepared.installKind === "git") {
    await withPluginLifecycleLease({}, async (lease) => {
      await completeSourceUpdateRuntime({ root, timeoutMs: lifecycle.budget("plugins"), lease });
    });
  }
  const initialPluginUpdate = await withPrePluginUpdateDoctorEnv(async () => {
    await lifecycle.run("configSnapshot", () => createUpdateConfigSnapshot());
    await lifecycle.run("doctor", async (phase) => {
      phase.assertCurrent();
      await recovery.beforeDoctor();
      phase.assertCurrent();
      await runUpdateFinalizationDoctorInFreshProcess({
        updateRecoveryBackup: recovery.backup,
        updateRecoveryOwner: recovery.updateRecoveryOwner,
        executorFence: recovery.executorFence,
        assertCurrent: () => {
          phase.assertCurrent();
          recovery.assertCurrent();
        },
        phase: "pre-plugin",
        root,
        runId: invokingRunId,
        yes: opts.yes === true,
        json: opts.json === true,
        workspaceSuggestions: true,
        timeoutMs: lifecycle.budget("doctor"),
        onWarnings: onDoctorWarnings,
      });
    });
    return await lifecycle.run(
      "plugins",
      (phase) =>
        withPluginLifecycleLease(phase, async () => {
          const assertCurrent = () => {
            phase.assertCurrent();
            recovery.assertCurrent();
          };
          const preparedConfig = await preparePostCorePluginConfig({
            requestedChannel,
            preUpdateConfig: preFinalizeConfig,
            beforePersistentEffect: assertCurrent,
            assertCurrent,
          });
          configSnapshot = preparedConfig.configSnapshot;
          const postDoctorStoredChannel = configSnapshot.valid
            ? normalizeUpdateChannel(configSnapshot.config.update?.channel)
            : null;
          const postDoctorChannel =
            requestedChannel ??
            postDoctorStoredChannel ??
            storedChannel ??
            effectiveChannel ??
            DEFAULT_PACKAGE_CHANNEL;
          const pluginInstallRecords = await loadInstalledPluginIndexInstallRecords();
          return await updatePluginsAfterCoreUpdate({
            root,
            channel: postDoctorChannel,
            ...preparedConfig,
            json: opts.json,
            acceptCapabilities: opts.acceptCapabilities,
            timeoutMs: lifecycle.budget("plugins"),
            workTimeoutMs: parseUpdateTimeoutMs(opts.timeout) ?? null,
            pluginInstallRecords,
            assertCurrent,
            runtime: createNonExitingRuntime(),
          });
        }),
      pluginOutcome,
    );
  });
  // Fresh Doctor acquires this same lease; convergence must run after release.
  const completedPluginUpdate = await lifecycle.run(
    "targetConfigConvergence",
    async (phase) => {
      const assertCurrent = () => {
        phase.assertCurrent();
        recovery.assertCurrent();
      };
      const result = await completePostCorePluginUpdate({
        root,
        updateRecoveryBackup: recovery.backup,
        updateRecoveryOwner: recovery.updateRecoveryOwner,
        executorFence: recovery.executorFence,
        beforeDoctor: recovery.beforeDoctor,
        runId: invokingRunId,
        pluginUpdate: initialPluginUpdate,
        freshDoctorRequired: initialPluginUpdate.changed,
        yes: opts.yes === true,
        json: opts.json === true,
        timeoutMs: lifecycle.budget("targetConfigConvergence"),
        onWarnings: onDoctorWarnings,
        assertCurrent,
      });
      await persistValidatedDowngradeConfig(result.configSnapshot, assertCurrent);
      return result;
    },
    (result) => pluginOutcome(result.pluginUpdate),
  );
  const pluginUpdate = completedPluginUpdate.pluginUpdate;
  lifecycle.recordWarnings(collectPostCorePluginAdvisories(pluginUpdate), "plugins");
  configSnapshot = completedPluginUpdate.configSnapshot;
  const completionBudget = lifecycle.budget("completionCache");
  // Leave shutdown time inside the phase deadline so optional cache failures can settle.
  const completionTimeout = completionBudget - Math.min(1_000, completionBudget / 2);
  await lifecycle.run(
    "completionCache",
    async () =>
      opts.deferCompletionCache
        ? ("deferred" as const)
        : await tryWriteCompletionCache(root, Boolean(opts.json), completionTimeout),
    (result) => result,
  );

  const result = {
    status:
      pluginUpdate.status === "error"
        ? "error"
        : pluginUpdate.status === "warning" || doctorWarnings.length > 0
          ? "warning"
          : "ok",
    mode: "finalize",
    root,
    channel:
      requestedChannel ??
      (configSnapshot.valid
        ? normalizeUpdateChannel(configSnapshot.config.update?.channel)
        : null) ??
      channel,
    restart: false,
    phaseTimings: lifecycle.phaseTimings,
    postUpdate: {
      doctor: {
        status: doctorWarnings.length > 0 ? "warning" : "ok",
        ...(doctorWarnings.length > 0 ? { warnings: doctorWarnings } : {}),
      },
      plugins: pluginUpdate,
    },
  };
  return result;
}

function pluginOutcome(result: PostCorePluginUpdateResult): {
  outcome: "failed" | "warning" | "completed";
  failureFacts?: PostCorePluginUpdateResult["failureFacts"];
} {
  return {
    outcome:
      result.status === "error" ? "failed" : result.status === "warning" ? "warning" : "completed",
    ...(result.status === "error"
      ? { failureFacts: collectPostCorePluginFailureFacts(result) }
      : {}),
  };
}
