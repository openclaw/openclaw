// Managed gateway service lifecycle before and after an update.
import { confirm, isCancel } from "@clack/prompts";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { stylePromptMessage } from "../../../packages/terminal-core/src/prompt-style.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  checkShellCompletionStatus,
  ensureCompletionCacheExists,
} from "../../commands/doctor-completion.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readGatewayOwnerLease } from "../../infra/gateway-owner-lease.js";
import {
  getUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { updateRunStepsFromResultStep } from "../../infra/update-run-step.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { CLI_NAME } from "../cli-name.js";
import { formatCliCommand } from "../command-format.js";
import { installCompletion } from "../completion-runtime.js";
import {
  terminateStaleGatewayPids,
  waitForGatewayHealthyRestart,
  type GatewayRestartSnapshot,
} from "../daemon-cli/restart-health.js";
import { runRestartScript } from "./restart-helper.js";
import { tryWriteCompletionCache, type UpdateCommandOptions } from "./shared.js";
import { createUpdateConfigSnapshot } from "./update-command-config-snapshot.js";
import type { PluginUpdateWarning } from "./update-command-plugins-internals.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";
import { recordServiceReconciliationWarning } from "./update-command-result.js";
import {
  DEFINITION_DENIAL,
  GatewayRestartHealthError,
  isPackageManagerUpdateMode,
  runUpdatedInstallGatewayCommand,
} from "./update-command-service-command.js";
import type {
  ManagedGatewayUpdateVerdict,
  UpdateServiceDefinitionRecovery,
  UpdateRestartParams,
} from "./update-command-service-context-types.js";
import { resolveServiceRefreshEnv } from "./update-command-service-env.js";
import {
  UpdateServiceLoadBoundaryError,
  type UpdateServiceLoadBoundary,
} from "./update-command-service-load.js";
import { revalidateManagedGatewayServiceAfterUpdate } from "./update-command-service-maintenance.js";
import {
  assertGatewayServiceManagementAllowedForUpdate,
  gatewayServiceCommandUsesRoot,
  resolveGatewayServiceManagementBlockMessageForUpdate,
  resolveUpdatedGatewayRestartPort,
} from "./update-command-service-plan.js";
import {
  hasLoadedLaunchdKeepAliveSupervisor,
  recoverLaunchAgentAndRecheckGatewayHealth,
} from "./update-command-service-recovery.js";
import { recordUpdateGatewayHealth, verifyUpdatedGateway } from "./update-command-verification.js";

export {
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate,
  maybeStopManagedServiceBeforeMutableUpdate,
  revalidateManagedGatewayServiceAfterUpdate,
  shouldBlockMutableUpdateFromGatewayServiceEnv,
  UpdateCommandAbort,
  type PreManagedServiceStop,
  type UpdateCommandRecoveryState,
} from "./update-command-service-maintenance.js";
export { resolveUpdatedGatewayRestartPort } from "./update-command-service-plan.js";
export { maybeRestartServiceAfterFailedMutableUpdate } from "./update-command-service-recovery.js";

export function shouldPrepareUpdatedInstallRestart(params: {
  updateMode: UpdateRunResult["mode"];
  serviceInstalled: boolean;
  serviceLoaded: boolean;
  serviceStoppedForUpdate?: boolean;
  serviceMatchesUpdateRoot?: boolean;
  requiresInstallRootRefresh?: boolean;
}): boolean {
  const useInstalledState =
    params.requiresInstallRootRefresh === true ||
    isPackageManagerUpdateMode(params.updateMode) ||
    (params.updateMode === "git" && params.serviceStoppedForUpdate);
  return useInstalledState
    ? params.serviceInstalled
    : params.serviceLoaded &&
        (params.updateMode !== "git" || params.serviceMatchesUpdateRoot === true);
}

export function resolvePostUpdateServiceStateReadEnv(params: {
  updateMode: UpdateRunResult["mode"];
  processEnv?: NodeJS.ProcessEnv;
  preManagedServiceEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const fallbackEnv = params.processEnv ?? process.env;
  const usesServiceEnv =
    params.updateMode === "git" || isPackageManagerUpdateMode(params.updateMode);
  return usesServiceEnv ? (params.preManagedServiceEnv ?? fallbackEnv) : fallbackEnv;
}

export async function tryInstallShellCompletion(opts: {
  root: string;
  jsonMode: boolean;
  skipPrompt: boolean;
}): Promise<void> {
  try {
    await tryWriteCompletionCache(opts.root, opts.jsonMode);
  } catch (err) {
    if (!opts.jsonMode) {
      const completionCacheRefreshCommand = formatCliCommand("openclaw completion --write-state");
      defaultRuntime.log(
        theme.warn(
          `Completion cache update failed: ${formatErrorMessage(err)}. Update will continue; retry with: ${completionCacheRefreshCommand}`,
        ),
      );
    }
  }
  if (opts.jsonMode || !process.stdin.isTTY) {
    return;
  }

  try {
    const status = await checkShellCompletionStatus(CLI_NAME);
    const generationOptions = { generationMode: "core-only" } as const;

    if (status.usesSlowPattern) {
      defaultRuntime.log(theme.muted("Upgrading shell completion to cached version..."));
      if (!(await ensureCompletionCacheExists(CLI_NAME, generationOptions))) {
        throw new Error("completion cache generation failed");
      }
      await installCompletion(status.shell, true, CLI_NAME);
      return;
    }

    if (status.profileInstalled && !status.cacheExists) {
      defaultRuntime.log(theme.muted("Regenerating shell completion cache..."));
      if (!(await ensureCompletionCacheExists(CLI_NAME, generationOptions))) {
        throw new Error("completion cache generation failed");
      }
      return;
    }

    if (!status.profileInstalled && !opts.skipPrompt) {
      defaultRuntime.log("");
      defaultRuntime.log(theme.heading("Shell completion"));

      const shouldInstall = await confirm({
        message: stylePromptMessage(`Enable ${status.shell} shell completion for ${CLI_NAME}?`),
        initialValue: true,
      });

      if (isCancel(shouldInstall) || !shouldInstall) {
        defaultRuntime.log(
          theme.muted(
            `Skipped. Run \`${formatCliCommand("openclaw completion --install")}\` later to enable.`,
          ),
        );
        return;
      }

      if (!(await ensureCompletionCacheExists(CLI_NAME, generationOptions))) {
        throw new Error("completion cache generation failed");
      }
      await installCompletion(status.shell, false, CLI_NAME);
    }
  } catch (err) {
    const message = formatErrorMessage(err);
    defaultRuntime.log(
      theme.warn(
        `Shell completion refresh failed: ${message}. Update will continue. Resolve the reported error before retrying: ${formatCliCommand("openclaw completion --write-state --install")}`,
      ),
    );
  }
}

/** A restart command can throw before health probes; replace pre-activation facts at that boundary. */
export async function recordFailedUpdateGatewayState(
  run: UpdateCommandOptions["run"],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (!run) {
    return;
  }
  const executor = run.executorFence;
  executor?.assertCurrent();
  const runtime = await resolveGatewayService()
    .readRuntime(env)
    .catch(() => undefined);
  executor?.assertCurrent();
  const verified = getUpdateRun(run.runId, { env: run.env })?.verification;
  // A failed readiness check does not invalidate health/version facts for the same process.
  if (
    runtime?.status === "running" &&
    typeof runtime.pid === "number" &&
    verified?.serviceRunning === true &&
    verified.pid === runtime.pid
  ) {
    return;
  }
  recordUpdateRunVerification(
    run.runId,
    {
      serviceRunning:
        runtime?.status === "running" ? true : runtime?.status === "stopped" ? false : undefined,
      pid: typeof runtime?.pid === "number" ? runtime.pid : undefined,
      runningVersion: undefined,
      runningBuildId: undefined,
      versionMatch: undefined,
      readyz: false,
      settled: false,
      channelsReady: false,
    },
    { env: run.env },
  );
}

export async function maybeRestartService(params: {
  serviceLoadBoundary?: UpdateServiceLoadBoundary;
  shouldRestart: boolean;
  result: UpdateRunResult;
  opts: UpdateCommandOptions;
  refreshServiceEnv: boolean;
  serviceRuntimeRefreshRequired?: boolean;
  serviceEnv?: NodeJS.ProcessEnv;
  serviceInstallEnv?: NodeJS.ProcessEnv | null;
  serviceUpdateVerdict?: ManagedGatewayUpdateVerdict;
  serviceManagerUid?: number;
  gatewayPort: number;
  restartScriptPath?: string | null;
  invocationCwd?: string;
  nodeRunner?: string;
  skipLegacyServiceRestart?: boolean;
  requireRunningServiceAfterRestart?: boolean;
  serviceMutationSkipMessage?: string;
  timeoutMs: number;
  onVerificationFailure?: (reason: string) => void;
  onPluginWarnings?: (warnings: readonly PluginUpdateWarning[]) => void;
  onVerified?: (verifiedAtMs: number) => void;
  definitionRecovery?: UpdateServiceDefinitionRecovery;
}): Promise<
  "ok" | "readiness-pending" | "reconciliation-pending" | "failed" | "restart-health-failed"
> {
  const run = params.opts.run;
  const executor = run?.executorFence;
  const assertCurrent = () => {
    if (params.opts.run !== run || run?.executorFence !== executor) {
      throw new Error("Native restart lost its original update executor.");
    }
    executor?.assertCurrent();
  };
  assertCurrent();
  const invocationEnv = resolveServiceRefreshEnv(process.env, params.invocationCwd);
  const serviceEnv = resolveServiceRefreshEnv(
    params.serviceEnv ?? invocationEnv,
    params.invocationCwd,
  );
  const recordPhase = (phase: "restarting" | "verifying") => {
    assertCurrent();
    if (params.opts.run) {
      recordUpdateRunPhase(params.opts.run.runId, phase, undefined, { env: params.opts.run.env });
    }
  };
  const failed = async (outcome: "failed" | "restart-health-failed" = "failed") => {
    // A restart can fail before health verification starts; recovery owns that phase.
    recordPhase("verifying");
    await recordFailedUpdateGatewayState(params.opts.run, serviceEnv);
    assertCurrent();
    return outcome;
  };
  if (params.shouldRestart) {
    const message =
      resolveGatewayServiceManagementBlockMessageForUpdate(invocationEnv) ??
      resolveGatewayServiceManagementBlockMessageForUpdate(serviceEnv);
    if (message) {
      defaultRuntime.error(message);
      return await failed();
    }
  }
  let activation = {
    ...params,
    invocationEnv,
    serviceEnv,
    assertCurrent,
    onWarnings: (warnings: string[]) => {
      assertCurrent();
      const step = {
        name: "managed-service-reconciliation",
        command: "openclaw gateway install --force",
        cwd: params.result.root ?? "",
        durationMs: 0,
        exitCode: 0,
        warnings,
      };
      params.result.steps.push(step);
      if (run) {
        try {
          for (const row of updateRunStepsFromResultStep(step)) {
            recordUpdateRunStep(run.runId, { ...row, endedAtMs: Date.now() }, { env: run.env });
          }
        } catch {
          assertCurrent();
          warnings.push("Could not record the service definition warning in update history.");
        }
      }
    },
  };
  const verdict = activation.serviceUpdateVerdict;
  let preserveDefinition =
    verdict?.kind === "unresolved" || (verdict?.kind === "owned" && !verdict.refreshDefinition);
  if (params.definitionRecovery?.backup || params.definitionRecovery?.preserved) {
    activation.refreshServiceEnv = false;
    activation.serviceRuntimeRefreshRequired = false;
    preserveDefinition = true;
  }
  const requiresInstallRootRefresh =
    verdict?.kind === "owned" && verdict.requiresInstallRootRefresh;
  const isPackageUpdate = isPackageManagerUpdateMode(activation.result.mode);
  const canRestartUpdatedInstall = () =>
    preserveDefinition ||
    (isPackageUpdate &&
      (activation.refreshServiceEnv ||
        activation.serviceInstallEnv === null ||
        activation.requireRunningServiceAfterRestart));
  if (preserveDefinition && !params.definitionRecovery?.backup) {
    defaultRuntime.error(
      "Gateway service definition left unchanged; ask its deployment owner to repair stale metadata if needed.",
    );
  }
  if (activation.serviceMutationSkipMessage) {
    recordServiceReconciliationWarning(
      activation.result,
      activation.serviceEnv,
      activation.serviceMutationSkipMessage,
    );
    return "ok";
  }
  const reconciliationPending = async () => {
    if (activation.requireRunningServiceAfterRestart) {
      recordServiceReconciliationWarning(
        activation.result,
        activation.serviceEnv,
        `The previous service installation was not restarted automatically because update state may have changed. Inspect \`${formatCliCommand("openclaw gateway status --deep", activation.serviceEnv)}\` before choosing a recovery installation.`,
      );
    }
    await recordFailedUpdateGatewayState(params.opts.run, activation.serviceEnv);
    assertCurrent();
    return "reconciliation-pending" as const;
  };
  let activationAccepted = false;
  let childReadinessPending = false;
  let updatedInstallRestartNeedsServiceRootProof = false;
  const verifyRestartedGateway = async (
    expectedGatewayVersion: string | undefined,
    expectedGatewayBuildId: string | undefined,
    opts: {
      requireRunningService?: boolean;
      health?: GatewayRestartSnapshot;
      recoverHealth?: boolean;
    } = {},
  ) => {
    recordPhase("verifying");
    const verification = await verifyUpdatedGateway({
      result: activation.result,
      opts: activation.opts,
      serviceEnv: activation.serviceEnv,
      gatewayPort: activation.gatewayPort,
      timeoutMs: activation.timeoutMs,
      nodeRunner: activation.nodeRunner,
      expectedVersion: expectedGatewayVersion,
      expectedBuildId: expectedGatewayBuildId,
      requireRunningService: opts.requireRunningService,
      health: opts.health,
      onVerified: params.onVerified,
      assertCurrent,
      recoverHealth: async (initialHealth, reinspect) => {
        assertCurrent();
        if (childReadinessPending || opts.recoverHealth === false) {
          return { health: initialHealth, launchAgentRecovery: null };
        }
        let health = initialHealth;
        if (!health.healthy && health.staleGatewayPids.length > 0) {
          if (!activation.opts.json) {
            defaultRuntime.log(
              theme.warn(
                `Found stale gateway process(es) after restart: ${health.staleGatewayPids.join(", ")}. Cleaning up...`,
              ),
            );
          }
          const terminated = await terminateStaleGatewayPids(health.staleGatewayPids, {
            env: activation.serviceEnv,
            assertCurrent,
          });
          assertCurrent();
          const currentOwner = readGatewayOwnerLease({ env: activation.serviceEnv });
          if (
            terminated.length > 0 &&
            (!currentOwner || currentOwner.state === "dead") &&
            (canRestartUpdatedInstall() || !isPackageUpdate)
          ) {
            activationAccepted =
              (await runUpdatedInstallGatewayCommand(activation, "restart")) === "accepted";
          }
          health = await reinspect();
        }
        const recovery = await recoverLaunchAgentAndRecheckGatewayHealth({
          updateRun: params.opts.run,
          assertCurrent,
          preserveDefinition,
          health,
          service: resolveGatewayService(),
          port: activation.gatewayPort,
          timeoutMs: activation.timeoutMs,
          expectedVersion: expectedGatewayVersion,
          ...(expectedGatewayBuildId ? { expectedBuildId: expectedGatewayBuildId } : {}),
          requirePluginHealth: false,
          env: activation.serviceEnv,
        });
        assertCurrent();
        if (recovery.launchAgentRecovery?.attempted) {
          activationAccepted = recovery.launchAgentRecovery.recovered;
        }
        return recovery;
      },
    });
    assertCurrent();
    if (verification.stopReason === "still-starting" && activation.result.status !== "error") {
      activation.result.reason = "still-starting";
    }
    if (
      verification.stopReason === "gateway-readiness-pending" ||
      verification.stopReason === "still-starting"
    ) {
      return "readiness-pending" as const;
    }
    if (!verification.ok) {
      params.onVerificationFailure?.(verification.summary);
    } else if (verification.pluginWarnings?.length) {
      params.onPluginWarnings?.(verification.pluginWarnings);
    }
    return verification.ok ? ("ok" as const) : undefined;
  };

  if (activation.shouldRestart) {
    if (
      activation.serviceLoadBoundary &&
      (!activation.refreshServiceEnv || activation.serviceInstallEnv === null || preserveDefinition)
    ) {
      throw new UpdateServiceLoadBoundaryError(
        "Deferred load requires an admitted writable service refresh.",
      );
    }
    if (
      (requiresInstallRootRefresh || activation.serviceRuntimeRefreshRequired) &&
      (!activation.refreshServiceEnv || activation.serviceInstallEnv === null)
    ) {
      defaultRuntime.error(
        "The updated installation requires a writable gateway service definition.",
      );
      return await failed();
    }
    if (!activation.opts.json) {
      defaultRuntime.log("");
      defaultRuntime.log(theme.heading("Restarting service..."));
    }

    try {
      let expectedGatewayVersion = normalizeOptionalString(activation.result.after?.version);
      const expectedGatewayBuildId = normalizeOptionalString(activation.result.after?.buildId);
      const canVerifyUpdatedGatewayByVersion =
        expectedGatewayVersion !== undefined &&
        expectedGatewayVersion !== normalizeOptionalString(activation.result.before?.version);
      let restarted = false;
      let restartInitiated = false;
      let refreshedGatewayHealth: GatewayRestartSnapshot | undefined;
      let restartScriptPath = preserveDefinition ? null : activation.restartScriptPath;
      if (activation.refreshServiceEnv && activation.serviceInstallEnv !== null) {
        try {
          recordPhase("restarting");
          await runUpdatedInstallGatewayCommand(activation, "install");
          // Windows /Run can retain A even after the task script points at B.
          // Reconcile its process with an explicit restart before accepting health.
          if (
            expectedGatewayVersion &&
            (isPackageUpdate || expectedGatewayBuildId) &&
            !(process.platform === "win32" && requiresInstallRootRefresh)
          ) {
            recordPhase("verifying");
            const service = resolveGatewayService();
            const supervisorKeepsAlive = await hasLoadedLaunchdKeepAliveSupervisor({
              service,
              env: activation.serviceEnv,
            });
            assertCurrent();
            const health = await waitForGatewayHealthyRestart({
              service,
              port: activation.gatewayPort,
              timeoutMs: activation.timeoutMs,
              expectedVersion: expectedGatewayVersion,
              ...(expectedGatewayBuildId ? { expectedBuildId: expectedGatewayBuildId } : {}),
              requirePluginHealth: false,
              env: activation.serviceEnv,
              requireRunningService: true,
              settle: { probes: 12 },
              supervisorKeepsAlive,
            });
            assertCurrent();
            refreshedGatewayHealth =
              health.healthy ||
              health.waitOutcome === "timeout" ||
              health.waitOutcome === "still-starting"
                ? health
                : undefined;
            recordUpdateGatewayHealth(params.opts.run, health, activation.gatewayPort);
          }
        } catch (err) {
          assertCurrent();
          if (err instanceof UpdateCommandRecoveryPendingError) {
            throw err;
          }
          const warning =
            `Failed to reconcile gateway service with ${activation.result.root ?? "the updated install"}: ${String(err)}. ` +
            `Run \`${formatCliCommand("openclaw gateway install --force", activation.serviceEnv)}\`, then \`${formatCliCommand("openclaw gateway restart", activation.serviceEnv)}\`.`;
          recordServiceReconciliationWarning(activation.result, activation.serviceEnv, warning);
          if (activation.serviceLoadBoundary) {
            throw new UpdateServiceLoadBoundaryError("Service staging or sealing failed.", {
              cause: err,
            });
          }
          if (activation.serviceRuntimeRefreshRequired) {
            params.onVerificationFailure?.("service-runtime-refresh-failed");
            throw err;
          }
          if (requiresInstallRootRefresh) {
            return await reconciliationPending();
          }
          if (DEFINITION_DENIAL.test(String(err))) {
            // A writer denial is not a lifecycle grant: revalidate the retained
            // command and manager before using native activation without repair.
            preserveDefinition = true;
            if (verdict?.kind !== "owned") {
              throw err;
            }
            const state = await readGatewayServiceState(resolveGatewayService(), {
              env: activation.serviceEnv,
              requireEffective: true,
              requireLoadedCommand: true,
              validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
              timeoutMs: activation.timeoutMs,
            });
            assertCurrent();
            await revalidateManagedGatewayServiceAfterUpdate({
              state,
              root: activation.result.root ?? verdict.root,
              preManagedServiceStop: {
                serviceManagerUid: activation.serviceManagerUid,
                serviceEnv: activation.serviceEnv,
                serviceUpdateVerdict: { ...verdict, refreshDefinition: false },
              },
            });
            assertCurrent();
            activation = {
              ...activation,
              serviceEnv: state.env,
              gatewayPort: await resolveUpdatedGatewayRestartPort({
                serviceEnv: state.env,
                serviceCommand: state.command,
              }),
            };
            assertCurrent();
            expectedGatewayVersion = normalizeOptionalString(activation.result.after?.version);
            restartScriptPath = null;
          }
          if (isPackageUpdate) {
            restartScriptPath = null;
            updatedInstallRestartNeedsServiceRootProof = !canVerifyUpdatedGatewayByVersion;
          }
        }
        if (
          requiresInstallRootRefresh &&
          (await gatewayServiceCommandUsesRoot({
            root: activation.result.root,
            env: activation.serviceEnv,
          })) !== true
        ) {
          recordServiceReconciliationWarning(
            activation.result,
            activation.serviceEnv,
            `Gateway service still points outside the updated install ${activation.result.root}. ` +
              `Run \`${formatCliCommand("openclaw gateway install --force", activation.serviceEnv)}\`, then \`${formatCliCommand("openclaw gateway restart", activation.serviceEnv)}\`.`,
          );
          return await reconciliationPending();
        }
      }
      // Keep the install's observation, including a pending startup, without restarting it again.
      if (refreshedGatewayHealth) {
        const healthy = await verifyRestartedGateway(
          expectedGatewayVersion,
          expectedGatewayBuildId,
          {
            requireRunningService: true,
            health: refreshedGatewayHealth,
          },
        );
        return healthy ?? (await failed("restart-health-failed"));
      }
      if (restartScriptPath) {
        if (!preserveDefinition) {
          await createUpdateConfigSnapshot();
        }
        recordPhase("restarting");
        activationAccepted = await runRestartScript(restartScriptPath, activation.timeoutMs);
        assertCurrent();
        restartInitiated = true;
      } else if (
        canRestartUpdatedInstall() ||
        (!isPackageUpdate && !activation.skipLegacyServiceRestart)
      ) {
        if (!preserveDefinition) {
          await createUpdateConfigSnapshot();
        }
        recordPhase("restarting");
        const restart = await runUpdatedInstallGatewayCommand(activation, "restart").catch(
          (error: unknown) => {
            if (!(error instanceof GatewayRestartHealthError)) {
              throw error;
            }
            // Activation succeeded; the update verifier owns the longer readiness budget.
            childReadinessPending = true;
            defaultRuntime.error(
              "Gateway is not ready yet; continuing update readiness verification.",
            );
            return "accepted" as const;
          },
        );
        restarted = true;
        activationAccepted = restart === "accepted";
        if (
          updatedInstallRestartNeedsServiceRootProof &&
          (await gatewayServiceCommandUsesRoot({
            root: activation.result.root,
            env: activation.serviceEnv,
          })) !== true
        ) {
          if (!activation.opts.json) {
            defaultRuntime.log(
              theme.warn("Gateway service did not point at the updated install after restart."),
            );
          }
          return await failed();
        }
      } else if (!activation.opts.json) {
        defaultRuntime.log(theme.muted("Gateway: restart skipped (no installed service found)."));
      }

      const shouldVerifyRestart =
        restartInitiated ||
        (restarted &&
          (preserveDefinition ||
            expectedGatewayVersion !== undefined ||
            activation.result.mode === "git")) ||
        activation.requireRunningServiceAfterRestart;
      if (shouldVerifyRestart) {
        const requireRunningService =
          updatedInstallRestartNeedsServiceRootProof ||
          activation.requireRunningServiceAfterRestart;
        const restartHealthy = await verifyRestartedGateway(
          expectedGatewayVersion,
          expectedGatewayBuildId,
          { requireRunningService },
        );
        if (!restartHealthy) {
          if (!activation.opts.json) {
            defaultRuntime.log("");
          }
          return await failed(activationAccepted ? "restart-health-failed" : "failed");
        }
        if (restartHealthy === "readiness-pending") {
          return restartHealthy;
        }
        if (!activation.opts.json && restartInitiated) {
          defaultRuntime.log(theme.success("Daemon restart completed."));
          defaultRuntime.log("");
        }
      }

      if (!activation.opts.json && restarted && !preserveDefinition) {
        defaultRuntime.log(theme.success("Daemon restarted successfully."));
        defaultRuntime.log("");
      }
    } catch (err) {
      assertCurrent();
      if (err instanceof UpdateServiceLoadBoundaryError) {
        throw err;
      }
      if (err instanceof GatewayRestartHealthError && !updatedInstallRestartNeedsServiceRootProof) {
        // The installed CLI owns restart retries; observe its final health result
        // without another native mutation.
        const healthy = await verifyRestartedGateway(
          normalizeOptionalString(activation.result.after?.version),
          normalizeOptionalString(activation.result.after?.buildId),
          { requireRunningService: true, recoverHealth: false },
        );
        return healthy ?? (await failed("restart-health-failed"));
      }
      defaultRuntime.error(
        `Gateway: restart failed: ${String(err)}. Code update remains installed; a service stopped for update may still be stopped. ` +
          `Run \`${formatCliCommand("openclaw gateway status --deep", activation.serviceEnv)}\` and ask its service owner to restart it manually.`,
      );
      return await failed();
    }
  } else if (!activation.opts.json) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.muted("Gateway: restart skipped (--no-restart)."));
    if (activation.result.mode === "npm" || activation.result.mode === "pnpm") {
      defaultRuntime.log(
        theme.muted(
          `Tip: Run \`${formatCliCommand("openclaw doctor", activation.serviceEnv)}\`, then \`${formatCliCommand("openclaw gateway restart", activation.serviceEnv)}\` to apply updates to a running gateway.`,
        ),
      );
    } else {
      defaultRuntime.log(
        theme.muted(
          `Tip: Run \`${formatCliCommand("openclaw gateway restart", activation.serviceEnv)}\` to apply updates to a running gateway.`,
        ),
      );
    }
  }
  return "ok";
}
