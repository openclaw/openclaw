import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  readConfigFileSnapshot,
} from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { tryProcessCwd } from "../../infra/safe-cwd.js";
import {
  DEFAULT_PACKAGE_CHANNEL,
  normalizeUpdateChannel,
  type UpdateChannel,
  UPDATE_EFFECTIVE_CHANNEL_ENV,
} from "../../infra/update-channels.js";
import { resolveUpdateInstallKind } from "../../infra/update-check.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import {
  DoctorMaintenanceRefusalError,
  normalizeUpdatePostInstallDoctorWarnings,
} from "../../infra/update-doctor-result.js";
import { POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV } from "../../infra/update-post-core-context.js";
import {
  acknowledgeAbandonedUpdateRun,
  getUpdateRun,
  reconcileAbandonedUpdateRuns,
} from "../../infra/update-run-ledger.js";
import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { createNonExitingRuntime, defaultRuntime } from "../../runtime.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../../state/openclaw-state-ownership.js";
import { formatCliCommand } from "../command-format.js";
import { exitCliAfterOutput } from "../one-shot-exit.js";
import { retainCliProcessJobUntilExit } from "../runtime-cleanup-scope.js";
import {
  parseTimeoutMsOrExit,
  parseUpdateTimeoutMs,
  readPackageVersion,
  resolveUpdateRoot,
  tryWriteCompletionCache,
  type UpdateFinalizeOptions,
} from "./shared.js";
import { suppressDeprecations } from "./suppress-deprecations.js";
import { createUpdateConfigSnapshot } from "./update-command-config-snapshot.js";
import {
  persistRequestedUpdateChannel,
  preparePostCorePluginConfig,
  persistValidatedDowngradeConfig,
  readPostCorePreUpdateSourceConfig,
} from "./update-command-config.js";
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
import {
  UpdateCommandFailure,
  UpdateCommandFinalizedRecoveryFailure,
  withUpdateAdmissionReporting,
} from "./update-command-result.js";
import { completeSourceUpdateRuntime } from "./update-command-runtime.js";
import { resolveServiceRefreshEnv, withUpdateInProgressEnv } from "./update-command-service-env.js";
import { reportPreMutationUpdateResult } from "./update-command-terminal.js";
import { withUpdateFailureTriage, type UpdateTriageTarget } from "./update-command-triage.js";
import {
  UpdateFinalizationLifecycle,
  type UpdateFinalizationPhase,
} from "./update-finalization-lifecycle.js";

export async function updateFinalizeCommand(
  opts: UpdateFinalizeOptions,
  recoveryRunIds?: readonly string[],
): Promise<void> {
  const invocationCwd = tryProcessCwd();
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
      const { root, installKind, runId } = await withUpdateAdmissionReporting(
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
                };
              }),
            ),
          ),
        recoveryRunIds === undefined ? "finalize" : "unknown",
      );
      lifecycle.root = root;
      const target: UpdateTriageTarget = {
        root,
        env: {
          ...resolveServiceRefreshEnv(process.env, invocationCwd),
          [UPDATE_RUN_ID_ENV]: runId,
        },
      };
      await withUpdateFailureTriage(
        { ...opts, invocationCwd, run: { runId, env: target.env } },
        target,
        () =>
          withUpdateInProgressEnv(invocationCwd, async () => {
            try {
              const complete = await withCommandProcessScope(async () => {
                const prepared = await lifecycle.run("targetConfigValidation", (phase) =>
                  prepareUpdateFinalization(opts, root, installKind, requestedChannel, phase),
                );
                return await updateFinalizeCommandInternal(
                  opts,
                  prepared,
                  lifecycle,
                  recoveryRunIds ?? [],
                  runId,
                  recoveryRunIds !== undefined || lifecycle.ownsUpdateRun,
                );
              });
              await complete();
            } catch (error) {
              if (hasCommandProcessCleanupError(error)) {
                throw error;
              }
              if (
                error instanceof DoctorMaintenanceRefusalError &&
                error.refusal.kind === "deferred"
              ) {
                const warnings = normalizeUpdatePostInstallDoctorWarnings([
                  `Doctor and plugin maintenance remain pending. Resolve the maintenance refusal, then run ${formatCliCommand("openclaw update repair")}. ${error.message}`,
                ]);
                lifecycle.recordWarnings(warnings);
                defaultRuntime.error(warnings[0]);
                if (opts.json) {
                  defaultRuntime.writeJson({
                    status: "warning",
                    mode: "finalize",
                    root,
                    restart: false,
                    phaseTimings: lifecycle.phaseTimings,
                    postUpdate: { doctor: { status: "warning", warnings } },
                  });
                } else {
                  defaultRuntime.log(theme.warn("Update finalization completed with warnings."));
                }
                lifecycle.complete(0);
                return;
              }
              if (!lifecycle.completed) {
                target.failureResult = await lifecycle.observeFailure(error);
              }
              if (error instanceof UpdateCommandFailure) {
                lifecycle.complete(error.exitCode);
              } else {
                lifecycle.fail();
              }
              throw error;
            }
          }),
      );
    } catch (error) {
      if (hasCommandProcessCleanupError(error)) {
        throw error;
      }
      if (error instanceof UpdateCommandFinalizedRecoveryFailure) {
        lifecycle.complete(error.exitCode);
        exitCode = error.exitCode;
        return;
      }
      if (!lifecycle.completed) {
        lifecycle.fail();
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
  let configSnapshot = await readConfigFileSnapshot({ skipPluginValidation: true, observe: false });
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
      const snapshot = await readConfigFileSnapshot({ skipPluginValidation: true, observe: false });
      return await persistRequestedUpdateChannel({
        configSnapshot: snapshot,
        requestedChannel,
        assertCurrent: phase.assertCurrent,
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
  recoveryRunIds: readonly string[],
  invokingRunId: string,
  ownsMaintenance: boolean,
): Promise<() => Promise<void>> {
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

  let maintenance: Awaited<
    ReturnType<typeof import("../../commands/doctor-maintenance.js").beginDoctorMaintenance>
  >;
  const restoreMaintenance = async (cfg: OpenClawConfig) => {
    const owned = maintenance;
    maintenance = undefined;
    await owned?.finish(cfg);
  };
  let outcome: { complete: () => Promise<void> } | { error: unknown };
  try {
    if (prepared.installKind === "git") {
      await withPluginLifecycleLease({}, async (lease) => {
        await withCommandProcessScope(() =>
          completeSourceUpdateRuntime({ root, timeoutMs: lifecycle.budget("plugins"), lease }),
        );
      });
    }
    const initialPluginUpdate = await withPrePluginUpdateDoctorEnv(async () => {
      await lifecycle.run("configSnapshot", () => createUpdateConfigSnapshot());
      await lifecycle.run(
        "doctor",
        () =>
          runUpdateFinalizationDoctorInFreshProcess({
            phase: "pre-plugin",
            root,
            runId: invokingRunId,
            yes: opts.yes === true,
            json: opts.json === true,
            workspaceSuggestions: true,
            timeoutMs: lifecycle.budget("doctor"),
            onWarnings: onDoctorWarnings,
          }),
        undefined,
        {
          enter: async () => {
            if (!ownsMaintenance) {
              return;
            }
            const { beginDoctorMaintenance } = await import("../../commands/doctor-maintenance.js");
            maintenance = await beginDoctorMaintenance({
              root,
              runId: invokingRunId,
              options: { repair: true, nonInteractive: true, json: opts.json },
              runtime: { ...defaultRuntime, log: defaultRuntime.error },
            });
            // Fresh Doctor owns database fences; the parent retains service custody.
            await maintenance?.releaseState();
          },
        },
      );
      return await lifecycle.run(
        "plugins",
        (phase) =>
          withPluginLifecycleLease(phase, async () => {
            return await withCommandProcessScope(async () => {
              const preparedConfig = await preparePostCorePluginConfig({
                requestedChannel,
                preUpdateConfig: preFinalizeConfig,
                assertCurrent: phase.assertCurrent,
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
                assertCurrent: phase.assertCurrent,
                runtime: createNonExitingRuntime(),
              });
            });
          }),
        pluginOutcome,
      );
    });
    // Fresh Doctor acquires this same lease; convergence must run after release.
    const completedPluginUpdate = await lifecycle.run(
      "targetConfigConvergence",
      async (phase) => {
        const result = await completePostCorePluginUpdate({
          root,
          runId: invokingRunId,
          pluginUpdate: initialPluginUpdate,
          freshDoctorRequired: initialPluginUpdate.changed,
          yes: opts.yes === true,
          json: opts.json === true,
          timeoutMs: lifecycle.budget("targetConfigConvergence"),
          onWarnings: onDoctorWarnings,
        });
        await persistValidatedDowngradeConfig(result.configSnapshot, phase.assertCurrent);
        return result;
      },
      (result) => pluginOutcome(result.pluginUpdate),
      { restore: (result) => restoreMaintenance(result.configSnapshot.config) },
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

    const reconciledRuns: string[] = [];
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
      ...(recoveryRunIds.length ? { reconciledRuns } : {}),
      phaseTimings: lifecycle.phaseTimings,
      postUpdate: {
        doctor: {
          status: doctorWarnings.length > 0 ? "warning" : "ok",
          ...(doctorWarnings.length > 0 ? { warnings: doctorWarnings } : {}),
        },
        plugins: pluginUpdate,
      },
    };
    outcome = {
      complete: async () => {
        if (result.status !== "error" && recoveryRunIds.length) {
          // Publish successful recovery only after convergence and the ledger's
          // transactional inactivity/driver check both finish.
          reconcileAbandonedUpdateRuns({ explicit: true, runIds: recoveryRunIds });
          if (recoveryRunIds.some((runId) => getUpdateRun(runId)?.status === "running")) {
            throw new Error(
              "An update resumed while repair was running; wait for that update before retrying repair.",
            );
          }
          for (const runId of recoveryRunIds) {
            if (acknowledgeAbandonedUpdateRun(runId)) {
              reconciledRuns.push(runId);
            }
          }
        }
        const failure =
          result.status === "error"
            ? new UpdateCommandFailure({
                status: "error",
                mode: "unknown",
                root,
                reason: "post-update-plugins",
                postUpdate: { plugins: pluginUpdate },
                steps: [],
                durationMs: Math.round(performance.now() - lifecycle.startedAt),
              })
            : undefined;
        const observed = failure ? await lifecycle.observeFailure(failure) : undefined;
        if (opts.json) {
          defaultRuntime.writeJson({
            ...result,
            ...(observed
              ? { recovery: observed.recovery, verification: observed.verification }
              : {}),
          });
        } else if (result.status === "ok") {
          defaultRuntime.log(theme.muted("Update finalization completed."));
        } else if (result.status === "warning") {
          defaultRuntime.log(theme.warn("Update finalization completed with warnings."));
        } else {
          defaultRuntime.log(theme.error("Update finalization failed."));
        }
        lifecycle.complete(result.status === "error" ? 1 : 0);
        if (failure) {
          throw failure;
        }
      },
    };
  } catch (error) {
    outcome = { error };
  }
  if (maintenance && !("error" in outcome && hasCommandProcessCleanupError(outcome.error))) {
    const owned = maintenance;
    const failures = "error" in outcome ? [outcome.error] : [];
    for (const restore of [
      async () =>
        restoreMaintenance(
          (await readConfigFileSnapshot({ skipPluginValidation: true, observe: false })).config,
        ),
      () => owned.release(),
    ]) {
      if (failures.some(hasCommandProcessCleanupError)) {
        break;
      }
      try {
        await withCommandProcessScope(restore);
      } catch (error) {
        if (!failures.includes(error)) {
          failures.push(error);
        }
      }
    }
    if (failures.length === 1) {
      outcome = { error: failures[0] };
    } else if (failures.length > 1) {
      outcome = {
        error: new AggregateError(failures, "Update finalization and service restoration failed", {
          cause: failures[0],
        }),
      };
    }
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.complete;
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
