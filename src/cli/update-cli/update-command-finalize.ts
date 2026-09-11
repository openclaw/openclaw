import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { beginDoctorMaintenance } from "../../commands/doctor-maintenance.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  readConfigFileSnapshot,
} from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../../state/openclaw-state-ownership.js";
import { retainCliProcessJobUntilExit } from "../runtime-cleanup-scope.js";
import {
  parseTimeoutMsOrExit,
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
  updatePluginsAfterCoreUpdate,
  type PostCorePluginUpdateResult,
} from "./update-command-plugins.js";
import { UpdateCommandFailure } from "./update-command-result.js";
import {
  hasUnsettledUpdateProcesses,
  restoreUpdateRecoveryState,
} from "./update-command-rollback-state.js";
import {
  resolveServiceRefreshEnv,
  withOwnedManagedUpdateEnv,
  withUpdateInProgressEnv,
} from "./update-command-service-env.js";
import { reportPreMutationUpdateFailure } from "./update-command-terminal.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";
import { UpdateFinalizationLifecycle } from "./update-finalization-lifecycle.js";

export async function updateFinalizeCommand(
  opts: UpdateFinalizeOptions,
  recoveryRunIds: readonly string[] = [],
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

  await withCommandProcessScope(async (stopChildren) => {
    const lifecycle = new UpdateFinalizationLifecycle(Boolean(opts.json), timeoutMs, stopChildren);
    try {
      const admitted = await withUpdateInProgressEnv(invocationCwd, () =>
        lifecycle.run("preflight", async () => {
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
          const parent = readUnprotectedGatewayUpdateParent();
          const unprotected = parent ? bindUnprotectedGatewayUpdateFinalizer(parent) : undefined;
          const run = lifecycle.attachLedger();
          return { root: await resolveUpdateRoot(), run, unprotected };
        }),
      );
      const { root, run, unprotected } = admitted;
      lifecycle.root = root;
      const target = { root, env: resolveServiceRefreshEnv(process.env, invocationCwd) };
      await withUpdateFailureTriage({ ...opts, invocationCwd }, target, () =>
        withUpdateInProgressEnv(invocationCwd, async () => {
          let finalResult: Awaited<ReturnType<typeof updateFinalizeCommandInternal>> | undefined;
          try {
            const finalize = async (recovery: FinalizationRecovery) => {
              lifecycle.updateRecoveryBackup = recovery.backup;
              const prepared = await lifecycle.run("targetConfigValidation", () =>
                prepareUpdateFinalization(opts, root, requestedChannel, recovery.assertCurrent),
              );
              const result = await updateFinalizeCommandInternal(
                opts,
                prepared,
                lifecycle,
                recovery,
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
                  : withFinalizationRecovery(root, run, finalize),
            );
            if (recoveryRunIds.length) {
              const reconciled = reconcileAbandonedUpdateRuns({
                explicit: true,
                runIds: recoveryRunIds,
              });
              if (recoveryRunIds.some((runId) => getUpdateRun(runId)?.status === "running")) {
                throw new Error(
                  "An update resumed while repair was running; wait for that update before retrying repair.",
                );
              }
              for (const runId of recoveryRunIds) {
                acknowledgeAbandonedUpdateRun(runId);
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
            if (error instanceof UpdateCommandFailure) {
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
      if (!lifecycle.completed) {
        lifecycle.fail();
      }
      throw error;
    } finally {
      lifecycle.finishRecovery();
    }
  });
}

type FinalizationRecovery = {
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
      if (hasUnsettledUpdateProcesses(error)) {
        throw error;
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
        } finally {
          await recoveryMaintenance.release();
        }
      } catch (cause) {
        throw new AggregateError(
          [error, cause],
          `Update finalization recovery failed. ${guidance}`,
          {
            cause,
          },
        );
      }
      throw error;
    }
  });
}

async function prepareUpdateFinalization(
  opts: UpdateFinalizeOptions,
  root: string,
  requestedChannel: UpdateChannel | null,
  beforePersistentEffect: () => void,
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
  if (requestedChannel === "extended-stable") {
    const installKind = await resolveUpdateInstallKind(root);
    if (installKind === "git") {
      await reportPreMutationUpdateFailure({
        root,
        installKind,
        reason: "unsupported_git_channel",
        opts,
        controlPlaneUpdateSentinelMeta: null,
      });
    }
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
    configSnapshot = await withPluginLifecycleLease({}, async () => {
      const snapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
      return await persistRequestedUpdateChannel({
        configSnapshot: snapshot,
        requestedChannel,
        beforePersistentEffect,
      });
    });
  }
  return {
    root,
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

  const initialPluginUpdate = await withPrePluginUpdateDoctorEnv(async () => {
    await lifecycle.run("configSnapshot", createUpdateConfigSnapshot);
    await lifecycle.run("doctor", async () => {
      await recovery.beforeDoctor();
      await runUpdateFinalizationDoctorInFreshProcess({
        updateRecoveryBackup: recovery.backup,
        updateRecoveryOwner: recovery.updateRecoveryOwner,
        phase: "pre-plugin",
        root,
        yes: opts.yes === true,
        json: opts.json === true,
        workspaceSuggestions: true,
        timeoutMs: lifecycle.budget("doctor"),
        onWarnings: onDoctorWarnings,
      });
    });
    return await lifecycle.run(
      "plugins",
      () =>
        withPluginLifecycleLease({}, async () => {
          const preparedConfig = await preparePostCorePluginConfig({
            requestedChannel,
            preUpdateConfig: preFinalizeConfig,
            beforePersistentEffect: recovery.assertCurrent,
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
            pluginInstallRecords,
            beforePersistentEffect: recovery.assertCurrent,
          });
        }),
      pluginOutcome,
    );
  });
  // Fresh Doctor acquires this same lease; convergence must run after release.
  const completedPluginUpdate = await lifecycle.run(
    "targetConfigConvergence",
    async () => {
      const result = await completePostCorePluginUpdate({
        root,
        updateRecoveryBackup: recovery.backup,
        updateRecoveryOwner: recovery.updateRecoveryOwner,
        beforeDoctor: recovery.beforeDoctor,
        pluginUpdate: initialPluginUpdate,
        freshDoctorRequired: initialPluginUpdate.changed,
        yes: opts.yes === true,
        json: opts.json === true,
        timeoutMs: lifecycle.budget("targetConfigConvergence"),
        onWarnings: onDoctorWarnings,
      });
      await persistValidatedDowngradeConfig(result.configSnapshot, recovery.assertCurrent);
      return result;
    },
    (result) => pluginOutcome(result.pluginUpdate),
  );
  const pluginUpdate = completedPluginUpdate.pluginUpdate;
  lifecycle.recordWarnings(
    (pluginUpdate.warnings ?? [])
      .filter((warning) => warning.reason === "plugin-target-unavailable")
      .map((warning) => warning.message),
    "plugins",
  );
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

function pluginOutcome(result: PostCorePluginUpdateResult): "failed" | "warning" | "completed" {
  return result.status === "error"
    ? "failed"
    : result.status === "warning"
      ? "warning"
      : "completed";
}
