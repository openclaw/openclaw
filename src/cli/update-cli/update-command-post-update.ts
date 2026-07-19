import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { readRestartSentinel } from "../../infra/restart-sentinel.js";
import { generateSecureUuid } from "../../infra/secure-random.js";
import type { UpdateChannel } from "../../infra/update-channels.js";
import { compareSemverStrings } from "../../infra/update-check.js";
import {
  buildControlPlaneUpdateRestartHealthPendingResult,
  readControlPlaneUpdateSentinelMeta,
} from "../../infra/update-control-plane-sentinel.js";
import { completePreparedUpdateHandover } from "../../infra/update-handover.js";
import {
  UPDATE_RECOVERY_JOURNAL_ENV,
  UPDATE_RECOVERY_LOCATOR_ENV,
} from "../../infra/update-recovery-journal.js";
import type { UpdateRestartSentinelMeta } from "../../infra/update-restart-sentinel-payload.js";
import { restoreRetainedPackageForUpdate } from "../../infra/update-retention.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { removeUpdateStateSnapshot } from "../../infra/update-state-snapshot.js";
import {
  advanceUpdateTransactionMarker,
  claimUpdateTransactionRollback,
  clearUpdateTransactionMarker,
  isUpdateTransactionMarker,
  startUpdateTransactionOwnerLease,
  waitForUpdateTransactionConfirmation,
} from "../../infra/update-transaction-marker.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { defaultRuntime } from "../../runtime.js";
import { VERSION } from "../../version.js";
import { replaceCliName, resolveCliName } from "../cli-name.js";
import { formatCliCommand } from "../command-format.js";
import { printResult } from "./progress.js";
import { prepareRestartScript } from "./restart-helper.js";
import {
  readPackageVersion,
  tryWriteCompletionCache,
  type UpdateCommandOptions,
} from "./shared.js";
import {
  persistRequestedUpdateChannel,
  restoreDroppedPreUpdateChannels,
} from "./update-command-config.js";
import type { PreparedPackageUpdateRollback } from "./update-command-package.js";
import { updatePluginsAfterCoreUpdate } from "./update-command-plugins.js";
import {
  continuePostCoreUpdateInFreshProcess,
  markControlPlaneUpdateRestartSentinelFailureBestEffort,
  shouldResumePostCoreUpdateInFreshProcess,
  writeControlPlaneUpdateRestartSentinelBestEffort,
} from "./update-command-post-core.js";
import {
  gatewayServiceCommandUsesRoot,
  maybeRestartService,
  maybeRestartServiceAfterFailedMutableUpdate,
  resolvePostUpdateServiceStateReadEnv,
  resolveUpdatedGatewayRestartPort,
  restoreWindowsTaskAutoStartOrExit,
  shouldPrepareUpdatedInstallRestart,
  serviceControlStdoutForMode,
  tryInstallShellCompletion,
  type PreManagedServiceStop,
} from "./update-command-service.js";
import {
  restoreUpdateStateWithCompletedRollbackMarker,
  rollbackPreparedPackageUpdate,
} from "./update-command-transaction-rollback.js";

const CLI_NAME = resolveCliName();

const UPDATE_QUIPS = [
  "Leveled up! New skills unlocked. You're welcome.",
  "Fresh code, same lobster. Miss me?",
  "Back and better. Did you even notice I was gone?",
  "Update complete. I learned some new tricks while I was out.",
  "Upgraded! Now with 23% more sass.",
  "I've evolved. Try to keep up.",
  "New version, who dis? Oh right, still me but shinier.",
  "Patched, polished, and ready to pinch. Let's go.",
  "The lobster has molted. Harder shell, sharper claws.",
  "Update done! Check the changelog or just trust me, it's good.",
  "Reborn from the boiling waters of npm. Stronger now.",
  "I went away and came back smarter. You should try it sometime.",
  "Update complete. The bugs feared me, so they left.",
  "New version installed. Old version sends its regards.",
  "Firmware fresh. Brain wrinkles: increased.",
  "I've seen things you wouldn't believe. Anyway, I'm updated.",
  "Back online. The changelog is long but our friendship is longer.",
  "Upgraded! Peter fixed stuff. Blame him if it breaks.",
  "Molting complete. Please don't look at my soft shell phase.",
  "Version bump! Same chaos energy, fewer crashes (probably).",
];

function pickUpdateQuip(): string {
  return UPDATE_QUIPS[Math.floor(Math.random() * UPDATE_QUIPS.length)] ?? "Update complete.";
}

export function buildLateUpdateFailureResult(
  result: UpdateRunResult,
  reason: string,
): UpdateRunResult {
  return { ...result, status: "error", reason };
}

function writeLateUpdateFailureJson(params: {
  result: UpdateRunResult;
  reason: string;
  jsonMode: boolean;
}): void {
  if (params.jsonMode) {
    defaultRuntime.writeJson(buildLateUpdateFailureResult(params.result, params.reason));
  }
}

async function markUpdateTransactionRollbackFailureBestEffort(params: {
  meta: UpdateRestartSentinelMeta;
  reason: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  if (!params.meta.handoffId) {
    return;
  }
  try {
    const marker = await readRestartSentinel(params.env);
    if (
      !marker ||
      !isUpdateTransactionMarker(marker.payload) ||
      marker.payload.stats?.handoffId !== params.meta.handoffId ||
      marker.payload.stats.updatePhase === "failed"
    ) {
      return;
    }
    await advanceUpdateTransactionMarker({
      handoffId: params.meta.handoffId,
      phase: "failed",
      rollbackOwner: marker.payload.stats.updateRollbackOwner,
      confirmationStatus: "failed",
      status: "error",
      reason: params.reason,
      env: params.env,
    });
  } catch {
    // Preserve the transaction marker rather than replacing it with a legacy
    // sentinel when even the best-effort terminal transition cannot persist.
  }
}

export async function finishUpdate(params: {
  result: UpdateRunResult;
  root: string;
  configSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  requestedChannel: UpdateChannel | null;
  storedChannel: UpdateChannel | null;
  channel: UpdateChannel;
  downgradeRisk: boolean;
  shouldRestart: boolean;
  opts: UpdateCommandOptions;
  showProgress: boolean;
  preManagedServiceStop?: PreManagedServiceStop;
  controlPlaneUpdateSentinelMeta: Awaited<ReturnType<typeof readControlPlaneUpdateSentinelMeta>>;
  preUpdatePluginInstallRecords: Awaited<ReturnType<typeof loadInstalledPluginIndexInstallRecords>>;
  startedAt: number;
  packageUpdateNodeRunner?: string;
  updateStepTimeoutMs: number;
  invocationCwd?: string;
  preparedPackageRollback: PreparedPackageUpdateRollback | null;
  updateTransactionMeta: UpdateRestartSentinelMeta | null;
  stopPreparedTransactionOwnerLease?: () => Promise<void>;
}): Promise<void> {
  let preparedTransactionOwnerLeaseStopped = false;
  const stopPreparedTransactionOwnerLease = async () => {
    if (preparedTransactionOwnerLeaseStopped) {
      return;
    }
    await params.stopPreparedTransactionOwnerLease?.();
    preparedTransactionOwnerLeaseStopped = true;
  };
  if (!params.opts.json || params.result.status !== "ok") {
    printResult(params.result, { ...params.opts, hideSteps: params.showProgress });
  }

  if (params.result.status === "error") {
    const updateTransactionMeta = params.updateTransactionMeta;
    if (params.preparedPackageRollback && updateTransactionMeta) {
      await stopPreparedTransactionOwnerLease();
      await rollbackPreparedPackageUpdate({
        rollback: params.preparedPackageRollback,
        meta: updateTransactionMeta,
        result: params.result,
        reason: params.result.reason ?? "package update failed",
        preManagedServiceStop: params.preManagedServiceStop,
        jsonMode: Boolean(params.opts.json),
      }).catch(async (error: unknown) => {
        await markUpdateTransactionRollbackFailureBestEffort({
          meta: updateTransactionMeta,
          reason: `update-rollback-failed: ${String(error)}`,
          env: params.preManagedServiceStop?.serviceEnv,
        });
      });
      defaultRuntime.exit(1);
      return;
    }
    if (!(await restoreWindowsTaskAutoStartOrExit(params.preManagedServiceStop))) {
      return;
    }
    await writeControlPlaneUpdateRestartSentinelBestEffort({
      meta: params.controlPlaneUpdateSentinelMeta,
      result: params.result,
      jsonMode: Boolean(params.opts.json),
    });
    await maybeRestartServiceAfterFailedMutableUpdate({
      preManagedServiceStop: params.preManagedServiceStop,
      jsonMode: Boolean(params.opts.json),
    });
    defaultRuntime.exit(1);
    return;
  }

  if (params.result.status === "skipped") {
    if (!(await restoreWindowsTaskAutoStartOrExit(params.preManagedServiceStop))) {
      return;
    }
    await writeControlPlaneUpdateRestartSentinelBestEffort({
      meta: params.controlPlaneUpdateSentinelMeta,
      result: params.result,
      jsonMode: Boolean(params.opts.json),
    });
    await maybeRestartServiceAfterFailedMutableUpdate({
      preManagedServiceStop: params.preManagedServiceStop,
      jsonMode: Boolean(params.opts.json),
    });
    if (params.result.reason === "dirty") {
      defaultRuntime.error(theme.error("Update blocked: local files are edited in this checkout."));
      defaultRuntime.log(
        theme.warn(
          "Git-based updates need a clean working tree before they can switch commits, fetch, or rebase.",
        ),
      );
      defaultRuntime.log(
        theme.muted("Commit, stash, or discard the local changes, then rerun `openclaw update`."),
      );
    }
    if (params.result.reason === "not-git-install") {
      defaultRuntime.log(
        theme.warn(
          `Skipped: this OpenClaw install isn't a git checkout, and the package manager couldn't be detected. Update via your package manager, then run \`${replaceCliName(formatCliCommand("openclaw doctor"), CLI_NAME)}\` and \`${replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME)}\`.`,
        ),
      );
      defaultRuntime.log(
        theme.muted(
          `Examples: \`${replaceCliName("npm i -g openclaw@latest", CLI_NAME)}\` or \`${replaceCliName("pnpm add -g openclaw@latest", CLI_NAME)}\``,
        ),
      );
    }
    defaultRuntime.exit(0);
    return;
  }

  const shouldResumePostCoreInFreshProcess = shouldResumePostCoreUpdateInFreshProcess({
    result: params.result,
    downgradeRisk: params.downgradeRisk,
  });

  let postUpdateConfigSnapshot = await readConfigFileSnapshot({
    skipPluginValidation: true,
    suppressFutureVersionWarning: shouldResumePostCoreInFreshProcess,
  });
  if (!shouldResumePostCoreInFreshProcess) {
    postUpdateConfigSnapshot = await persistRequestedUpdateChannel({
      configSnapshot: postUpdateConfigSnapshot,
      requestedChannel: params.requestedChannel,
    });
  }
  if (
    params.requestedChannel &&
    params.configSnapshot.valid &&
    params.requestedChannel !== params.storedChannel &&
    !shouldResumePostCoreInFreshProcess &&
    !params.opts.json
  ) {
    defaultRuntime.log(theme.muted(`Update channel set to ${params.requestedChannel}.`));
  } else if (
    params.requestedChannel &&
    params.configSnapshot.valid &&
    params.requestedChannel !== params.storedChannel &&
    shouldResumePostCoreInFreshProcess &&
    !params.opts.json
  ) {
    defaultRuntime.log(theme.muted(`Update channel will be set to ${params.requestedChannel}.`));
  }

  const postUpdateRoot = params.result.root ?? params.root;

  let postCorePluginUpdate;
  let pluginsUpdatedInFreshProcess = false;
  if (shouldResumePostCoreInFreshProcess) {
    const freshProcessResult = await continuePostCoreUpdateInFreshProcess({
      root: postUpdateRoot,
      channel: params.channel,
      requestedChannel: params.requestedChannel,
      opts: params.opts,
      pluginInstallRecords: params.preUpdatePluginInstallRecords,
      updateStartedAtMs: params.startedAt,
      nodeRunner: params.packageUpdateNodeRunner,
      preUpdateConfig: params.configSnapshot.valid
        ? {
            sourceConfig: params.configSnapshot.sourceConfig,
            authoredConfig: isRecord(params.configSnapshot.parsed)
              ? (params.configSnapshot.parsed as OpenClawConfig)
              : params.configSnapshot.sourceConfig,
          }
        : undefined,
    });
    if (freshProcessResult.exitCode !== undefined) {
      if (!(await restoreWindowsTaskAutoStartOrExit(params.preManagedServiceStop))) {
        return;
      }
      defaultRuntime.exit(freshProcessResult.exitCode);
      throw new Error(`post-update process exited with code ${freshProcessResult.exitCode}`);
    }
    pluginsUpdatedInFreshProcess = freshProcessResult.resumed;
    postCorePluginUpdate = freshProcessResult.pluginUpdate;
  }

  if (!pluginsUpdatedInFreshProcess) {
    if (shouldResumePostCoreInFreshProcess) {
      postUpdateConfigSnapshot = await persistRequestedUpdateChannel({
        configSnapshot: postUpdateConfigSnapshot,
        requestedChannel: params.requestedChannel,
      });
    }
    const restoredConfig = restoreDroppedPreUpdateChannels(
      postUpdateConfigSnapshot,
      params.configSnapshot.valid
        ? {
            sourceConfig: params.configSnapshot.sourceConfig,
            authoredConfig: isRecord(params.configSnapshot.parsed)
              ? (params.configSnapshot.parsed as OpenClawConfig)
              : params.configSnapshot.sourceConfig,
          }
        : undefined,
    );
    postUpdateConfigSnapshot = restoredConfig.snapshot;
    // Current-process post-core convergence still reports the pre-update
    // VERSION. During downgrades, pin compatibility checks to the installed
    // target so incompatible newer plugins are disabled before restart.
    const postUpdateInstalledVersion = await readPackageVersion(postUpdateRoot);
    const versionComparison =
      postUpdateInstalledVersion && VERSION
        ? compareSemverStrings(VERSION, postUpdateInstalledVersion)
        : null;
    const compatibilityDowngradeTarget =
      versionComparison != null && versionComparison > 0 ? postUpdateInstalledVersion : null;
    const previousCompatibilityHostVersion = process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
    if (compatibilityDowngradeTarget) {
      process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION = compatibilityDowngradeTarget;
    }
    try {
      postCorePluginUpdate = await updatePluginsAfterCoreUpdate({
        root: postUpdateRoot,
        channel: params.channel,
        configSnapshot: postUpdateConfigSnapshot,
        configChanged: restoredConfig.changed,
        restoredAuthoredChannels: restoredConfig.authoredChannels,
        opts: params.opts,
        timeoutMs: params.updateStepTimeoutMs,
        pluginInstallRecords: params.preUpdatePluginInstallRecords,
      });
    } finally {
      if (compatibilityDowngradeTarget) {
        if (previousCompatibilityHostVersion === undefined) {
          delete process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
        } else {
          process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION = previousCompatibilityHostVersion;
        }
      }
    }
  }

  const resultWithPostUpdate: UpdateRunResult = postCorePluginUpdate
    ? {
        ...params.result,
        status: postCorePluginUpdate.status === "error" ? "error" : params.result.status,
        ...(postCorePluginUpdate.status === "error" ? { reason: "post-update-plugins" } : {}),
        postUpdate: {
          ...params.result.postUpdate,
          plugins: postCorePluginUpdate,
        },
      }
    : params.result;

  if (postCorePluginUpdate?.status === "error") {
    const updateTransactionMeta = params.updateTransactionMeta;
    if (params.preparedPackageRollback && updateTransactionMeta) {
      await stopPreparedTransactionOwnerLease();
      await rollbackPreparedPackageUpdate({
        rollback: params.preparedPackageRollback,
        meta: updateTransactionMeta,
        result: resultWithPostUpdate,
        reason: "post-update plugin sync failed",
        preManagedServiceStop: params.preManagedServiceStop,
        jsonMode: Boolean(params.opts.json),
      }).catch(async (error: unknown) => {
        await markUpdateTransactionRollbackFailureBestEffort({
          meta: updateTransactionMeta,
          reason: `update-rollback-failed: ${String(error)}`,
          env: params.preManagedServiceStop?.serviceEnv,
        });
      });
      writeLateUpdateFailureJson({
        result: resultWithPostUpdate,
        reason: "post-update plugin sync failed",
        jsonMode: Boolean(params.opts.json),
      });
      defaultRuntime.exit(1);
      return;
    }
    if (!(await restoreWindowsTaskAutoStartOrExit(params.preManagedServiceStop))) {
      return;
    }
    await writeControlPlaneUpdateRestartSentinelBestEffort({
      meta: params.controlPlaneUpdateSentinelMeta,
      result: resultWithPostUpdate,
      jsonMode: Boolean(params.opts.json),
    });
    if (params.opts.json) {
      defaultRuntime.writeJson(resultWithPostUpdate);
    } else {
      defaultRuntime.error(theme.error("Update failed during plugin post-update sync."));
    }
    defaultRuntime.exit(1);
    return;
  }

  let restartScriptPath: string | null = null;
  let refreshGatewayServiceEnv = false;
  let gatewayServiceEnv: NodeJS.ProcessEnv | undefined;
  let skipLegacyServiceRestart = false;
  let gatewayPort = resolveUpdatedGatewayRestartPort({
    config: postUpdateConfigSnapshot.valid ? postUpdateConfigSnapshot.config : undefined,
    processEnv: process.env,
  });
  if (params.shouldRestart) {
    try {
      const serviceState = await readGatewayServiceState(resolveGatewayService(), {
        env: resolvePostUpdateServiceStateReadEnv({
          updateMode: resultWithPostUpdate.mode,
          processEnv: process.env,
          preManagedServiceEnv: params.preManagedServiceStop?.serviceEnv,
        }),
      });
      const serviceMatchesUpdateRoot =
        (await gatewayServiceCommandUsesRoot({
          root: postUpdateRoot,
          command: serviceState.command,
        })) ?? undefined;
      const serviceOwnershipConfirmed =
        params.preManagedServiceStop?.serviceMatchesMutationRoot === true ||
        serviceMatchesUpdateRoot === true;
      const knownForeignService =
        params.preManagedServiceStop?.serviceMatchesMutationRoot === false &&
        serviceMatchesUpdateRoot !== true;
      skipLegacyServiceRestart =
        knownForeignService ||
        (resultWithPostUpdate.mode === "git" &&
          serviceState.installed &&
          serviceState.loaded &&
          params.preManagedServiceStop?.stopped !== true &&
          serviceMatchesUpdateRoot === false);
      if (
        !knownForeignService &&
        shouldPrepareUpdatedInstallRestart({
          updateMode: resultWithPostUpdate.mode,
          serviceInstalled: serviceState.installed,
          serviceLoaded: serviceState.loaded,
          serviceStoppedForUpdate: params.preManagedServiceStop?.stopped,
          serviceMatchesMutationRoot: serviceOwnershipConfirmed
            ? true
            : params.preManagedServiceStop?.serviceMatchesMutationRoot,
          serviceMatchesUpdateRoot,
        })
      ) {
        gatewayServiceEnv = serviceState.env;
        gatewayPort = resolveUpdatedGatewayRestartPort({
          config: postUpdateConfigSnapshot.valid ? postUpdateConfigSnapshot.config : undefined,
          processEnv: process.env,
          serviceEnv: gatewayServiceEnv,
        });
        restartScriptPath = await prepareRestartScript(
          serviceState.env,
          gatewayPort,
          serviceOwnershipConfirmed ? serviceState.command?.programArguments : undefined,
        );
        // An ambiguous wrapper may be stopped and restored, but only proven
        // ownership authorizes rewriting the service definition.
        refreshGatewayServiceEnv = serviceOwnershipConfirmed;
      }
    } catch {
      // Ignore errors during pre-check; fallback to standard restart
    }
  }

  await tryWriteCompletionCache(postUpdateRoot, Boolean(params.opts.json));
  await tryInstallShellCompletion({
    jsonMode: Boolean(params.opts.json),
    skipPrompt: Boolean(params.opts.yes),
  });

  const transactionalRollback = params.preparedPackageRollback;
  const transactionMeta = params.updateTransactionMeta;
  const confirmationTier = transactionMeta?.confirmationTier ?? "delivery";
  const recoveryLocatorPath = process.env[UPDATE_RECOVERY_LOCATOR_ENV];
  const transactionServiceEnv = {
    ...(params.preManagedServiceStop?.serviceEnv ?? gatewayServiceEnv ?? process.env),
    ...(transactionalRollback
      ? { [UPDATE_RECOVERY_JOURNAL_ENV]: transactionalRollback.recoveryJournalPath }
      : {}),
    ...(recoveryLocatorPath ? { [UPDATE_RECOVERY_LOCATOR_ENV]: recoveryLocatorPath } : {}),
  };
  if (transactionalRollback && transactionMeta?.handoffId) {
    try {
      const advanced = await advanceUpdateTransactionMarker({
        handoffId: transactionMeta.handoffId,
        phase: "restart",
        result: resultWithPostUpdate,
        env: transactionServiceEnv,
      });
      if (!advanced) {
        throw new Error("update transaction ownership lost before restart");
      }
    } catch (error) {
      const reason = `update marker write failed: ${String(error)}`;
      await stopPreparedTransactionOwnerLease();
      await rollbackPreparedPackageUpdate({
        rollback: transactionalRollback,
        meta: transactionMeta,
        result: resultWithPostUpdate,
        reason,
        preManagedServiceStop: params.preManagedServiceStop,
        jsonMode: Boolean(params.opts.json),
      });
      writeLateUpdateFailureJson({
        result: resultWithPostUpdate,
        reason,
        jsonMode: Boolean(params.opts.json),
      });
      defaultRuntime.exit(1);
      return;
    }
  } else {
    await writeControlPlaneUpdateRestartSentinelBestEffort({
      meta: params.controlPlaneUpdateSentinelMeta,
      result: buildControlPlaneUpdateRestartHealthPendingResult(resultWithPostUpdate),
      jsonMode: Boolean(params.opts.json),
    });
  }

  if (!(await restoreWindowsTaskAutoStartOrExit(params.preManagedServiceStop))) {
    return;
  }
  let restartOk = false;
  const restartUpdatedService = async () => {
    restartOk = await maybeRestartService({
      shouldRestart: params.shouldRestart,
      result: resultWithPostUpdate,
      opts: params.opts,
      refreshServiceEnv: refreshGatewayServiceEnv,
      serviceEnv: gatewayServiceEnv,
      gatewayPort,
      restartScriptPath,
      invocationCwd: params.invocationCwd,
      nodeRunner: params.packageUpdateNodeRunner,
      skipLegacyServiceRestart,
      requireRunningServiceAfterRestart:
        resultWithPostUpdate.mode === "git" && params.preManagedServiceStop?.stopped === true,
      timeoutMs: params.updateStepTimeoutMs,
    });
  };

  if (transactionalRollback && transactionMeta?.handoffId) {
    const service = resolveGatewayService();
    const serviceEnv = transactionServiceEnv;
    let rollbackFailureReason = "update transaction failed";
    let completedSnapshotCleanup = false;
    const rollbackOwner = generateSecureUuid();
    const stopOwnerLease = await startUpdateTransactionOwnerLease({
      handoffId: transactionMeta.handoffId,
      rollbackOwner,
      env: serviceEnv,
      onError: (error) => {
        defaultRuntime.error(`Warning: update owner lease refresh failed: ${String(error)}`);
      },
    });
    // Transfer ownership before either rollback path can replace state files.
    // Draining the prepared lease also joins any in-flight SQLite refresh.
    await stopPreparedTransactionOwnerLease();
    const state = await completePreparedUpdateHandover({
      confirmationTier,
      restartService: restartUpdatedService,
      waitForHealthy: async () => restartOk,
      waitForConfirmation: async () =>
        await waitForUpdateTransactionConfirmation({
          handoffId: transactionMeta.handoffId!,
          rollbackOwner,
          timeoutMs: Math.min(
            params.updateStepTimeoutMs,
            confirmationTier === "human" ? 10 * 60_000 : 2 * 60_000,
          ),
          env: serviceEnv,
        }),
      cleanupCompleted: async () => {
        await removeUpdateStateSnapshot(transactionalRollback.stateSnapshot);
        completedSnapshotCleanup = true;
      },
      onCleanupError: (error) => {
        defaultRuntime.error(
          `Warning: update completed, but retained state snapshot cleanup failed: ${String(error)}`,
        );
      },
      stopService: async () => {
        // The outer managed-handoff helper remains alive while this detached
        // update child stops the service. A child exit makes it restore the
        // retained package from the marker before service activation.
        await service.stop({
          env: serviceEnv,
          stdout: serviceControlStdoutForMode(Boolean(params.opts.json)),
        });
      },
      restorePackage: async () => {
        await restoreRetainedPackageForUpdate({
          retainedRoot: transactionalRollback.retainedPackageRoot,
          packageRoot: transactionalRollback.packageRoot,
        });
      },
      restoreState: async () => {
        // No SQLite-backed lease writer may survive canonical state replacement.
        // Awaiting stop also drains an in-flight refresh before files move.
        await stopPreparedTransactionOwnerLease();
        await stopOwnerLease();
        await restoreUpdateStateWithCompletedRollbackMarker({
          snapshot: transactionalRollback.stateSnapshot,
          handoffId: transactionMeta.handoffId!,
          reason: rollbackFailureReason,
          rollbackOwner,
          env: serviceEnv,
        });
      },
      startService: async () => {
        await service.start({
          env: serviceEnv,
          stdout: serviceControlStdoutForMode(Boolean(params.opts.json)),
        });
      },
      claimRollback: async (reason) =>
        (await claimUpdateTransactionRollback({
          handoffId: transactionMeta.handoffId!,
          rollbackOwner,
          reason,
          env: serviceEnv,
        })) !== null,
      onPhase: async ({ phase, failureReason }) => {
        rollbackFailureReason = failureReason ?? rollbackFailureReason;
        const markerReason =
          phase === "rolled-back"
            ? `update-rollback-completed: ${rollbackFailureReason}`
            : failureReason;
        const advanced = await advanceUpdateTransactionMarker({
          handoffId: transactionMeta.handoffId!,
          phase,
          rollbackOwner,
          env: serviceEnv,
          ...(phase === "failed" || phase === "rolled-back"
            ? { confirmationStatus: "failed" as const, status: "error" as const }
            : {}),
          ...(markerReason ? { reason: markerReason } : {}),
        });
        if (
          !advanced &&
          phase !== "rolling-back" &&
          phase !== "rolled-back" &&
          phase !== "failed"
        ) {
          throw new Error(`update transaction ownership lost before ${phase}`);
        }
      },
      markFailed: async (reason) => {
        rollbackFailureReason = reason;
        await advanceUpdateTransactionMarker({
          handoffId: transactionMeta.handoffId!,
          phase: "rolling-back",
          rollbackOwner,
          env: serviceEnv,
          confirmationStatus: "failed",
          status: "error",
          reason,
        });
      },
    })
      .catch(async (error: unknown) => {
        const reason = `update-rollback-failed: ${String(error)}`;
        await advanceUpdateTransactionMarker({
          handoffId: transactionMeta.handoffId!,
          phase: "failed",
          rollbackOwner,
          env: serviceEnv,
          confirmationStatus: "failed",
          status: "error",
          reason,
        }).catch(() => undefined);
        return {
          phase: "failed" as const,
          confirmationTier,
          failureReason: String(error),
        };
      })
      .finally(stopOwnerLease);
    if (state.phase !== "complete") {
      const reason = state.failureReason ?? rollbackFailureReason;
      if (!params.opts.json) {
        defaultRuntime.error(`Update rolled back: ${reason}`);
      }
      writeLateUpdateFailureJson({
        result: resultWithPostUpdate,
        reason,
        jsonMode: Boolean(params.opts.json),
      });
      defaultRuntime.exit(1);
      return;
    }
    if (completedSnapshotCleanup) {
      try {
        await clearUpdateTransactionMarker({
          handoffId: transactionMeta.handoffId,
          env: serviceEnv,
        });
      } catch (error) {
        defaultRuntime.error(
          `Warning: confirmed update marker cleanup failed; startup will retry: ${String(error)}`,
        );
      }
    }
  } else {
    await restartUpdatedService();
  }
  if (!restartOk) {
    await markControlPlaneUpdateRestartSentinelFailureBestEffort({
      meta: params.controlPlaneUpdateSentinelMeta,
      reason: "restart-unhealthy",
      jsonMode: Boolean(params.opts.json),
    });
    writeLateUpdateFailureJson({
      result: resultWithPostUpdate,
      reason: "restart-unhealthy",
      jsonMode: Boolean(params.opts.json),
    });
    defaultRuntime.exit(1);
    return;
  }

  if (!transactionalRollback || !transactionMeta?.handoffId) {
    await writeControlPlaneUpdateRestartSentinelBestEffort({
      meta: params.controlPlaneUpdateSentinelMeta,
      result: resultWithPostUpdate,
      jsonMode: Boolean(params.opts.json),
    });
  }

  if (!params.opts.json) {
    defaultRuntime.log(theme.muted(pickUpdateQuip()));
  } else {
    defaultRuntime.writeJson(resultWithPostUpdate);
  }
}
