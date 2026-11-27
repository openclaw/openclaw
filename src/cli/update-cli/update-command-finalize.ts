import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  readConfigFileSnapshot,
} from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { retainCurrentDeferredUpdateWarnings } from "../../infra/deferred-update-warnings.js";
import { readInstallOwner } from "../../infra/install-owner.js";
import { tryProcessCwd } from "../../infra/safe-cwd.js";
import { normalizeUpdateChannel } from "../../infra/update-channels.js";
import { resolveUpdateInstallKind } from "../../infra/update-check.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import { resolveDoctorUpdateRun } from "../../infra/update-deferred-model-retirement.js";
import {
  DoctorMaintenanceRefusalError,
  normalizeUpdatePostInstallDoctorWarnings,
} from "../../infra/update-doctor-result.js";
import type { ManagedHandoffRepair } from "../../infra/update-managed-service-handoff-lease-types.js";
import { readUpdateResultPolicy } from "../../infra/update-result-telemetry.js";
import { formatUpdateRunOwnership } from "../../infra/update-run-activity.js";
import { findUpdateGatewayStop } from "../../infra/update-run-gateway-stop.js";
import {
  acknowledgeAbandonedUpdateRun,
  getUpdateRun,
  listUpdateRuns,
  reconcileAbandonedUpdateRunsAsync,
} from "../../infra/update-run-ledger.js";
import { formatUpdateOwedStep } from "../../infra/update-run-owed-step.js";
import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import { DEFAULT_UPDATE_STEP_TIMEOUT_MS } from "../../infra/update-run-timeouts.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { createNonExitingRuntime, defaultRuntime } from "../../runtime.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../../state/openclaw-state-ownership-preflight.js";
import { formatCliCommand } from "../command-format.js";
import { exitCliAfterOutput } from "../one-shot-exit.js";
import { retainCliProcessJobUntilExit } from "../runtime-cleanup-scope.js";
import { refuseHostOwnedUpdate, reportHostOwnedUpdate } from "./host-owned.js";
import {
  parseUpdateChannel,
  parseUpdateTimeoutMs,
  readPackageVersion,
  resolveNodeRunner,
  resolveUpdateRoot,
  tryWriteCompletionCache,
  type UpdateFinalizeOptions,
} from "./shared.js";
import { suppressDeprecations } from "./suppress-deprecations.js";
import { withUpdateAdmissionReporting } from "./update-command-admission-report.js";
import { createUpdateConfigSnapshot } from "./update-command-config-snapshot.js";
import {
  preparePostCorePluginConfig,
  persistValidatedDowngradeConfig,
} from "./update-command-config.js";
import { withUpdateDatabaseEngine } from "./update-command-database-engine.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { prepareUpdateFinalization } from "./update-command-finalize-config.js";
import {
  completePostCorePluginUpdate,
  runUpdateFinalizationDoctorInFreshProcess,
  withPrePluginUpdateDoctorEnv,
} from "./update-command-fresh-doctor.js";
import { refuseImmutableUpdateActivation } from "./update-command-immutable.js";
import { settleUpdateDoctorMaintenance } from "./update-command-maintenance.js";
import { settleOwedStepsAfterFinalization } from "./update-command-owed.js";
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
} from "./update-command-result.js";
import { completeSourceUpdateRuntime } from "./update-command-runtime.js";
import { resolveServiceRefreshEnv, withUpdateInProgressEnv } from "./update-command-service-env.js";
import { withUpdateFailureTriage, type UpdateTriageTarget } from "./update-command-triage.js";
import { UpdateFinalizationLifecycle } from "./update-finalization-lifecycle.js";
import {
  hasUnverifiedDataAtRisk,
  refuseUnverifiedDataAtRiskBeforeMaintenance,
  restoreRepairGateway,
  verifyUnverifiedDataAtRisk,
} from "./update-repair-service.js";
import {
  reportRetainedUpdateCustody,
  type RetainedUpdateCustodyReport,
} from "./update-retained-custody.js";

export type UpdateCoreCompletion = "completed" | "pending";

/** What the interrupted-update stage hands its caller instead of a command result. */
export type InterruptedUpdateFinalization = { runId?: string; status?: string };

export async function updateFinalizeCommand(
  opts: UpdateFinalizeOptions,
  recoveryRunIds?: readonly string[],
  handoff?: ManagedHandoffRepair,
  // Finalization can succeed while repair-retained custody still blocks the next update.
  retained?: RetainedUpdateCustodyReport,
): Promise<void> {
  await withUpdateDatabaseEngine(process.env, () =>
    finalizeUpdate(opts, recoveryRunIds, handoff, retained),
  );
}

/**
 * Finish a killed update's installed version as `openclaw update repair` does: history
 * reconciliation, then Doctor, plugin convergence and Gateway restoration on a repair run
 * of its own, because the calling update's run does not exist yet. It prints no result
 * and never exits; deferred maintenance and failure throw.
 */
export async function finishInterruptedUpdate(
  opts: UpdateFinalizeOptions,
  recoveryRunIds: readonly string[],
): Promise<InterruptedUpdateFinalization> {
  const stage: InterruptedUpdateFinalization = {};
  await withUpdateDatabaseEngine(process.env, async () => {
    const options = {
      env: resolveServiceRefreshEnv(process.env, tryProcessCwd()),
      busyTimeoutMs: parseUpdateTimeoutMs(opts.timeout) ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS,
    };
    // As in repair: driver death is history; its reconciliation failure is only a warning.
    await reconcileAbandonedUpdateRunsAsync({ runIds: recoveryRunIds }, options).catch(
      (error: unknown) => {
        if (hasCommandProcessCleanupError(error)) {
          throw error;
        }
        defaultRuntime.error(
          `Warning: Update history reconciliation could not complete: ${String(error)}`,
        );
      },
    );
    await finalizeUpdate(opts, recoveryRunIds, undefined, undefined, stage);
  });
  return stage;
}

async function finalizeUpdate(
  opts: UpdateFinalizeOptions,
  recoveryRunIds?: readonly string[],
  handoff?: ManagedHandoffRepair,
  retained?: RetainedUpdateCustodyReport,
  stage?: InterruptedUpdateFinalization,
): Promise<void> {
  // Refuse retained recovery before discovery; preflight rechecks before state writes.
  await assertUpdateRecoveryAdmission({ env: process.env });
  // A stage's calling update has already refused host-owned and immutable installations.
  if (!stage) {
    const discoveredRoot = await resolveUpdateRoot();
    await refuseHostOwnedUpdate(discoveredRoot, opts);
    await refuseImmutableUpdateActivation(discoveredRoot, opts);
  }
  const invocationCwd = tryProcessCwd();
  suppressDeprecations();
  const timeoutMs = parseUpdateTimeoutMs(opts.timeout);
  const requestedChannel = parseUpdateChannel(opts.channel);

  let exitCode: number | undefined;
  let unfinished: string | undefined;
  await withCommandProcessScope(async (stopChildren) => {
    const lifecycle = new UpdateFinalizationLifecycle(
      Boolean(opts.json),
      timeoutMs,
      stopChildren,
      !stage,
    );
    lifecycle.handoff = handoff;
    // A stage's failures reach its calling update, which owns the only report and exit.
    const reportAdmission: typeof withUpdateAdmissionReporting = stage
      ? (_opts, admit) => admit()
      : withUpdateAdmissionReporting;
    const reportFailure: typeof withUpdateFailureTriage = stage
      ? (_opts, _target, run) => run()
      : withUpdateFailureTriage;
    try {
      const { root, installKind, runId } = await reportAdmission(
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
                const reportResult = await readUpdateResultPolicy(process.env);
                phase.assertCurrent();
                // Public repair supplies a recovery selection, even when it is empty.
                const admittedRunId = lifecycle.attachLedger(
                  recoveryRunIds !== undefined,
                  reportResult,
                );
                const resolvedRoot = await resolveUpdateRoot();
                const resolvedInstallKind = await resolveUpdateInstallKind(resolvedRoot, {
                  timeoutMs: lifecycle.budget("preflight"),
                });
                if (resolvedInstallKind === "host") {
                  if (stage) {
                    throw new Error("This installation is now managed by its host.");
                  }
                  reportHostOwnedUpdate(await readInstallOwner(resolvedRoot), opts);
                }
                if (resolvedInstallKind === "immutable") {
                  throw new Error(
                    "Use openclaw update recover --root <installation-root> for immutable activation recovery.",
                  );
                }
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
      if (stage) {
        stage.runId = runId;
      }
      lifecycle.root = root;
      const nodeRunner = resolveNodeRunner();
      const target: UpdateTriageTarget = {
        root,
        nodeRunner,
        env: {
          ...resolveServiceRefreshEnv(process.env, invocationCwd),
          [UPDATE_RUN_ID_ENV]: runId,
        },
      };
      await reportFailure({ ...opts, invocationCwd, run: { runId, env: target.env } }, target, () =>
        withUpdateInProgressEnv(invocationCwd, async () => {
          try {
            const complete = await withCommandProcessScope(async () => {
              const prepared = await lifecycle.run("targetConfigValidation", (phase) =>
                prepareUpdateFinalization(opts, root, installKind, requestedChannel, phase),
              );
              return await updateFinalizeCommandInternal(
                opts,
                { ...prepared, nodeRunner },
                lifecycle,
                recoveryRunIds ?? [],
                runId,
                recoveryRunIds !== undefined || lifecycle.ownsUpdateRun,
                retained,
                stage,
              );
            });
            await complete();
            if (retained && recoveryRunIds !== undefined && lifecycle.ownsUpdateRun) {
              exitCode = 2;
            }
          } catch (error) {
            if (hasCommandProcessCleanupError(error)) {
              throw error;
            }
            if (
              error instanceof DoctorMaintenanceRefusalError &&
              error.refusal.kind === "deferred"
            ) {
              const nextAction = `Stop the Gateway through its service owner (\`${formatCliCommand("openclaw gateway stop --force")}\` for the managed service), stop other OpenClaw processes using this state, then rerun \`${formatCliCommand("openclaw update repair")}\`.`;
              const warnings = normalizeUpdatePostInstallDoctorWarnings([
                `Doctor and plugin maintenance remain pending. ${nextAction}`,
                error.message,
              ]);
              lifecycle.recordWarnings(warnings);
              defaultRuntime.error(warnings.join("\n"));
              // An unfinished claim still stands in for cancelled custody until a
              // later repair completes it; the rerun settles both.
              const custody =
                retained ??
                (handoff?.cancelledCustody
                  ? reportRetainedUpdateCustody({
                      ...handoff.cancelledCustody,
                      reason:
                        "Doctor maintenance remains pending; this repair keeps its claim on the cancelled custody until a later repair completes.",
                    })
                  : undefined);
              const reportedNextAction = custody
                ? `${nextAction} ${custody.nextAction}`
                : nextAction;
              if (stage) {
                unfinished = `Doctor maintenance remains pending. ${reportedNextAction}`;
              } else if (opts.json) {
                defaultRuntime.writeJson({
                  status: "warning",
                  coreUpdate: "pending" satisfies UpdateCoreCompletion,
                  nextAction: reportedNextAction,
                  mode: "finalize",
                  root,
                  restart: false,
                  phaseTimings: lifecycle.phaseTimings,
                  postUpdate: { doctor: { status: "warning", warnings } },
                  ...(custody ? { retainedUpdateCustody: custody.retainedUpdateCustody } : {}),
                });
              } else {
                defaultRuntime.log(
                  theme.warn(`Doctor maintenance remains pending. ${reportedNextAction}`),
                );
              }
              lifecycle.complete(0, nextAction);
              // Keep the pending receipt; an older driver still owns its update's exit status.
              if (recoveryRunIds !== undefined && lifecycle.ownsUpdateRun) {
                exitCode = 2;
              }
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
        unfinished = error.message;
        return;
      }
      if (!lifecycle.completed) {
        lifecycle.fail();
      }
      throw error;
    } finally {
      // The exit watch belongs to a command that ends after its output, not to a stage.
      if (!stage) {
        lifecycle.finishRecovery();
      }
    }
  });
  if (stage && (unfinished !== undefined || exitCode !== undefined)) {
    throw new Error(unfinished ?? `Update finalization ended with exit code ${exitCode}.`);
  }
  if (exitCode !== undefined) {
    exitCliAfterOutput(defaultRuntime, exitCode);
  }
}

async function updateFinalizeCommandInternal(
  opts: UpdateFinalizeOptions,
  prepared: Awaited<ReturnType<typeof prepareUpdateFinalization>> & { nodeRunner: string },
  lifecycle: UpdateFinalizationLifecycle,
  recoveryRunIds: readonly string[],
  invokingRunId: string,
  ownsMaintenance: boolean,
  retained?: RetainedUpdateCustodyReport,
  stage?: InterruptedUpdateFinalization,
): Promise<() => Promise<void>> {
  const { root, nodeRunner, preFinalizeConfig, requestedChannel, channel } = prepared;
  const interruptedGateway = recoveryRunIds.length
    ? findUpdateGatewayStop(listUpdateRuns({ limit: 100 }))
    : undefined;
  let doctorWarnings: string[] = [];
  const onDoctorWarnings = (warnings: string[]) => {
    doctorWarnings = normalizeUpdatePostInstallDoctorWarnings([...doctorWarnings, ...warnings]);
    lifecycle.recordWarnings(doctorWarnings);
  };

  const doctorParams = {
    opts: { fullIntegrityCheck: opts.fullIntegrityCheck },
    root,
    nodeRunner,
    runId: invokingRunId,
    yes: opts.yes === true,
    json: opts.json === true,
    onWarnings: onDoctorWarnings,
    onDoctorStep: (step: Parameters<typeof lifecycle.recordDoctorStep>[0]) =>
      lifecycle.recordDoctorStep(step),
  };

  let maintenance: Awaited<
    ReturnType<typeof import("../../commands/doctor-maintenance.js").beginDoctorMaintenance>
  >;
  const enterMaintenance = async (serviceInspectionDeadlineAtMs: number | undefined) => {
    if (!ownsMaintenance || maintenance) {
      return;
    }
    const { beginDoctorMaintenance } = await import("../../commands/doctor-maintenance.js");
    maintenance = await beginDoctorMaintenance({
      root,
      runId: invokingRunId,
      options: { repair: true, nonInteractive: true, json: opts.json },
      runtime: { ...defaultRuntime, log: defaultRuntime.error },
      serviceInspectionDeadlineAtMs,
      // An update-owned stop is restored below; Doctor only reports other stopped services.
      reportStoppedService: lifecycle.ownsUpdateRepairRun && !interruptedGateway,
    });
    lifecycle.serviceUpdateVerdict = maintenance?.serviceUpdateVerdict;
    // Fresh Doctor owns database fences; the parent retains service custody.
    await maintenance?.releaseState();
  };
  const restoreMaintenance = async (cfg: OpenClawConfig) => {
    const owned = maintenance;
    maintenance = undefined;
    await owned?.finish(cfg);
    if (owned?.warnings?.length) {
      onDoctorWarnings(owned.warnings);
    }
  };
  let outcome: { complete: () => Promise<void> } | { error: unknown };
  try {
    if (ownsMaintenance) {
      await refuseUnverifiedDataAtRiskBeforeMaintenance(lifecycle, invokingRunId, opts.json);
    }
    if (prepared.installKind === "git") {
      const runtimeTimeoutMs = lifecycle.budget("plugins");
      const runtimeDeadline = performance.now() + runtimeTimeoutMs;
      await completeSourceUpdateRuntime({
        root,
        timeoutMs: runtimeTimeoutMs,
        beforePublication: () =>
          enterMaintenance(Date.now() + Math.max(0, runtimeDeadline - performance.now())),
      });
    }
    const initialPluginUpdate = await withPrePluginUpdateDoctorEnv(async () => {
      await lifecycle.run("configSnapshot", () => createUpdateConfigSnapshot());
      await lifecycle.run(
        "doctor",
        (phase) =>
          runUpdateFinalizationDoctorInFreshProcess({
            phase: "pre-plugin",
            ...doctorParams,
            workspaceSuggestions: true,
            timeoutMs: lifecycle.budget("doctor"),
            serviceInspectionDeadlineAtMs: phase.deadlineAtMs,
          }),
        undefined,
        {
          enter: enterMaintenance,
        },
      );
      return await lifecycle.run(
        "plugins",
        (phase) =>
          withPluginLifecycleLease(phase, () =>
            withCommandProcessScope(async () => {
              const preparedConfig = await preparePostCorePluginConfig({
                requestedChannel,
                preUpdateConfig: preFinalizeConfig,
                assertCurrent: phase.assertCurrent,
              });
              const { configSnapshot } = preparedConfig;
              const postDoctorStoredChannel = configSnapshot.valid
                ? normalizeUpdateChannel(configSnapshot.config.update?.channel)
                : null;
              const postDoctorChannel = requestedChannel ?? postDoctorStoredChannel ?? channel;
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
            }),
          ),
        pluginOutcome,
      );
    });
    // Fresh Doctor acquires this same lease; convergence must run after release.
    const completedPluginUpdate = await lifecycle.run(
      "targetConfigConvergence",
      async (phase) => {
        const result = await completePostCorePluginUpdate({
          ...doctorParams,
          pluginUpdate: initialPluginUpdate,
          timeoutMs: lifecycle.budget("targetConfigConvergence"),
        });
        // Post-plugin convergence rereads the ledger and reports each still-pending
        // migration as a plugin warning; that final report supersedes Doctor's.
        const finallyReportedPluginIds = new Set(
          (result.pluginUpdate.warnings ?? []).flatMap((warning) =>
            warning.reason === "doctor-advisory" && warning.pluginId ? [warning.pluginId] : [],
          ),
        );
        doctorWarnings = await retainCurrentDeferredUpdateWarnings(doctorWarnings, {
          finallyReportedPluginIds,
          readUpdateRun: () => resolveDoctorUpdateRun(process.env, invokingRunId),
        });
        phase.assertCurrent();
        lifecycle.recordWarnings(doctorWarnings);
        await persistValidatedDowngradeConfig(result.configSnapshot, phase.assertCurrent);
        return result;
      },
      (result) => pluginOutcome(result.pluginUpdate),
      { restore: (result) => restoreMaintenance(result.configSnapshot.config) },
    );
    const pluginUpdate = completedPluginUpdate.pluginUpdate;
    lifecycle.recordWarnings(collectPostCorePluginAdvisories(pluginUpdate), "plugins");
    const { configSnapshot } = completedPluginUpdate;
    const completionBudget = lifecycle.budget("completionCache");
    // Leave shutdown time inside the phase deadline so optional cache failures can settle.
    const completionTimeout = completionBudget - Math.min(1_000, completionBudget / 2);
    let completionFailure: string | undefined;
    await lifecycle.run(
      "completionCache",
      async () =>
        opts.deferCompletionCache
          ? ("deferred" as const)
          : await tryWriteCompletionCache(
              root,
              Boolean(opts.json),
              completionTimeout,
              nodeRunner,
              (reason) => {
                completionFailure = reason;
              },
            ),
      (result) => result,
    );
    // A post-core child defers completion to its parent, which then owns owed steps too.
    // Owed steps are reported beside the status, which parents read as the maintenance outcome.
    const owedSteps = opts.deferCompletionCache
      ? []
      : await settleOwedStepsAfterFinalization(
          { runId: invokingRunId, env: process.env },
          { root, completionFailure, plugins: pluginUpdate, timeoutMs: completionBudget },
        );
    for (const step of owedSteps) {
      defaultRuntime.error(`Warning: ${formatUpdateOwedStep(step)}`);
    }

    const restoresGateway = interruptedGateway && pluginUpdate.status !== "error" && !retained;
    // Checked again after Doctor, whether or not the marked run stopped the Gateway.
    const checksMarks =
      ownsMaintenance && pluginUpdate.status !== "error" && !retained && hasUnverifiedDataAtRisk();
    const gateway =
      restoresGateway || checksMarks
        ? await lifecycle.run("gatewayRestoration", async (phase) => {
            const markRefusal =
              checksMarks &&
              (await verifyUnverifiedDataAtRisk({
                repairRunId: invokingRunId,
                config: configSnapshot.config,
                json: Boolean(opts.json),
                phase,
                timeoutMs: lifecycle.budget("gatewayRestoration"),
                // Doctor maintenance ran above only with exclusive state ownership.
                writersExcluded: true,
              }));
            // Inconsistent state keeps every Gateway as it is, whichever run stopped it.
            if (markRefusal) {
              return {
                restart: false,
                warning: markRefusal,
                verification: undefined,
                refused: true as const,
              };
            }
            if (!restoresGateway) {
              return undefined;
            }
            const restore = (assertCurrent: () => void) =>
              restoreRepairGateway({
                originalRunId: interruptedGateway.runId,
                repairRunId: invokingRunId,
                root,
                config: configSnapshot.config,
                env: resolveServiceRefreshEnv(process.env, tryProcessCwd()),
                json: Boolean(opts.json),
                phase: { ...phase, assertCurrent },
                timeoutMs: lifecycle.budget("gatewayRestoration"),
              });
            if (lifecycle.handoff) {
              return await restore(phase.assertCurrent);
            }
            return await withUpdateCommandExecutor(invokingRunId, async (executor) => {
              const fence = await executor.enter(root);
              return await restore(() => {
                phase.assertCurrent();
                fence.assertCurrent();
              });
            });
          })
        : undefined;
    if (gateway?.warning) {
      onDoctorWarnings([gateway.warning]);
    }

    const reconciledRuns: string[] = [];
    const result = {
      status:
        pluginUpdate.status === "error"
          ? "error"
          : pluginUpdate.status === "warning" || doctorWarnings.length > 0 || retained
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
      restart: gateway?.restart ?? false,
      ...(gateway?.verification ? { verification: gateway.verification } : {}),
      ...(recoveryRunIds.length ? { reconciledRuns } : {}),
      ...(owedSteps.length ? { owedSteps } : {}),
      ...retained,
      phaseTimings: lifecycle.phaseTimings,
      postUpdate: {
        doctor: {
          status: doctorWarnings.length > 0 ? "warning" : "ok",
          ...(doctorWarnings.length > 0 ? { warnings: doctorWarnings } : {}),
        },
        plugins: pluginUpdate,
      },
    };
    // A mark still refused after Doctor leaves recovery unfinished and retryable.
    const markRefusal = gateway && "refused" in gateway ? gateway.warning : undefined;
    outcome = {
      complete: async () => {
        if (result.status !== "error" && !markRefusal && recoveryRunIds.length) {
          // Publish successful recovery only after convergence and the ledger's
          // transactional inactivity/driver check both finish.
          await reconcileAbandonedUpdateRunsAsync({ explicit: true, runIds: recoveryRunIds });
          const unresolved = recoveryRunIds
            .map((runId) => getUpdateRun(runId))
            .find((run) => run?.status === "running");
          if (unresolved) {
            throw new Error(formatUpdateRunOwnership(unresolved));
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
        if (!failure && !markRefusal) {
          lifecycle.handoff?.complete(invokingRunId);
        }
        // Exit status and advisories do not distinguish completed core work from deferred maintenance.
        // A refused mark leaves recovery unfinished; a handoff helper must not restart on it.
        const coreUpdate: UpdateCoreCompletion =
          failure || retained || markRefusal ? "pending" : "completed";
        if (stage) {
          stage.status = result.status;
        } else if (opts.json) {
          defaultRuntime.writeJson({
            ...result,
            coreUpdate,
            ...(observed
              ? { recovery: observed.recovery, verification: observed.verification }
              : {}),
          });
        } else if (result.status === "ok" && !markRefusal) {
          defaultRuntime.log(theme.muted("Update finalization completed."));
        } else if (result.status === "warning" && !markRefusal) {
          defaultRuntime.log(theme.warn("Update finalization completed with warnings."));
          if (retained) {
            defaultRuntime.log(theme.warn(retained.nextAction));
          }
        } else {
          defaultRuntime.log(theme.error("Update finalization failed."));
        }
        if (!stage && !opts.json && gateway?.verification) {
          defaultRuntime.log(
            `Managed Gateway ${gateway.restart ? "started and " : ""}verified after update repair.`,
          );
        }
        lifecycle.complete(result.status === "error" || markRefusal ? 1 : 0);
        const thrown = failure ?? (markRefusal ? new Error(markRefusal) : undefined);
        if (thrown) {
          throw thrown;
        }
      },
    };
  } catch (error) {
    outcome = { error };
  }
  if (maintenance) {
    const owned = maintenance;
    outcome = await settleUpdateDoctorMaintenance(
      outcome,
      async () =>
        restoreMaintenance(
          (await readConfigFileSnapshot({ skipPluginValidation: true, observe: false })).config,
        ),
      () => owned.release(),
      "Update finalization and service restoration failed",
    );
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
