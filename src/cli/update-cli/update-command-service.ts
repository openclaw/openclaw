// Managed gateway service lifecycle before and after an update.
import { confirm, isCancel } from "@clack/prompts";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { stylePromptMessage } from "../../../packages/terminal-core/src/prompt-style.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  checkShellCompletionStatus,
  ensureCompletionCacheExists,
} from "../../commands/doctor-completion.js";
import { resolveGatewayStartupTiming } from "../../commands/gateway-startup-timing.js";
import {
  ServiceStartRefusalError,
  type SystemdServiceStartRefusal,
} from "../../daemon/service-inspection-error.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readGatewayOwnerLease } from "../../infra/gateway-owner-lease.js";
import { recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import { defaultRuntime } from "../../runtime.js";
import { CLI_NAME } from "../cli-name.js";
import { formatCliCommand } from "../command-format.js";
import { installCompletion } from "../completion-runtime.js";
import { createGatewayRestartDeadline } from "../daemon-cli/restart-health-deadline.js";
import {
  terminateStaleGatewayPids,
  type GatewayRestartSnapshot,
} from "../daemon-cli/restart-health.js";
import { tryWriteCompletionCache, type UpdateCommandOptions } from "./shared.js";
import { createUpdateConfigSnapshot } from "./update-command-config-snapshot.js";
import { recordMutableUpdateSignalPhase } from "./update-command-mutable-signals.js";
import type { PluginUpdateWarning } from "./update-command-plugins-internals.js";
import { observeUpdateGatewayReadiness } from "./update-command-readiness.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import {
  recordServiceReconciliationWarning,
  recordServiceReconciliationWarnings,
} from "./update-command-result.js";
import {
  DEFINITION_DENIAL,
  GatewayRestartHealthError,
  isPackageManagerUpdateMode,
  runUpdatedInstallGatewayCommand,
} from "./update-command-service-command.js";
import type {
  ManagedGatewayUpdateVerdict,
  UpdateServiceDefinitionRecovery,
  OriginalManagedServiceRuntime,
} from "./update-command-service-context-types.js";
import { resolveServiceRefreshEnv } from "./update-command-service-env.js";
import { revalidateManagedGatewayServiceAfterUpdate } from "./update-command-service-maintenance.js";
import {
  gatewayServiceCommandUsesRoot,
  readGatewayServiceStateForUpdate,
  resolveGatewayServiceManagementBlockMessageForUpdate,
  resolveUpdatedGatewayRestartPort,
} from "./update-command-service-plan.js";
import { recoverLaunchAgentAndRecheckGatewayHealth } from "./update-command-service-recovery.js";
import {
  recordFailedUpdateGatewayState,
  verifyUpdatedGateway,
} from "./update-command-verification.js";

export {
  maybeStopManagedServiceBeforeMutableUpdate,
  mutableUpdateGatewayServiceBlock,
  UpdateCommandAbort,
  type PreManagedServiceStop,
  type UpdateCommandRecoveryState,
} from "./update-command-service-maintenance.js";
export { resolveUpdatedGatewayRestartPort } from "./update-command-service-plan.js";
export { maybeRestartServiceAfterFailedMutableUpdate } from "./update-command-service-recovery.js";

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
    if (status.usesSlowPattern) {
      defaultRuntime.log(theme.muted("Upgrading shell completion to cached version..."));
    } else if (status.profileInstalled) {
      if (status.cacheExists) {
        return;
      }
      defaultRuntime.log(theme.muted("Regenerating shell completion cache..."));
    } else {
      if (opts.skipPrompt) {
        return;
      }
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
    }
    if (!(await ensureCompletionCacheExists(CLI_NAME, { generationMode: "core-only" }))) {
      throw new Error("completion cache generation failed");
    }
    if (status.usesSlowPattern || !status.profileInstalled) {
      await installCompletion(status.shell, status.usesSlowPattern, CLI_NAME);
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

export async function maybeRestartService(params: {
  originalManagedServiceRuntime?: OriginalManagedServiceRuntime;
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
  invocationCwd?: string;
  nodeRunner?: string;
  skipLegacyServiceRestart?: boolean;
  requireRunningServiceAfterRestart?: boolean;
  serviceMutationSkipMessage?: string;
  timeoutMs: number;
  onVerificationFailure?: (reason: string) => void;
  onPluginWarnings?: (warnings: readonly PluginUpdateWarning[]) => void;
  onVerified?: (verifiedAtMs: number) => void;
  onGatewayStartAttempted?: () => void;
  definitionRecovery?: UpdateServiceDefinitionRecovery;
  expectedGatewayIdentity?: { version: string; buildId?: string };
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
      recordMutableUpdateSignalPhase(params.opts.run, phase);
    }
  };
  let verificationObserved = false;
  const failed = async (outcome: "failed" | "restart-health-failed" = "failed") => {
    // A restart can fail before health verification starts; recovery owns that phase.
    recordPhase("verifying");
    if (!verificationObserved) {
      await recordFailedUpdateGatewayState(
        params.opts.run,
        serviceEnv,
        assertCurrent,
        params.timeoutMs,
      );
    }
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
    // A default update step must not truncate a Windows service's cold-start budget.
    timeoutMs:
      process.platform === "win32" && params.opts.timeout === undefined
        ? Math.max(params.timeoutMs, resolveGatewayStartupTiming().deadlineMs)
        : params.timeoutMs,
    invocationEnv,
    serviceEnv,
    assertCurrent,
    onWarnings: (warnings: string[]) =>
      recordServiceReconciliationWarnings(params.result, warnings, run, assertCurrent),
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
    await recordFailedUpdateGatewayState(params.opts.run, activation.serviceEnv, assertCurrent);
    assertCurrent();
    return "reconciliation-pending" as const;
  };
  const serviceDefinitionRefused = async (refusal: SystemdServiceStartRefusal) => {
    recordPhase("verifying");
    recordServiceReconciliationWarning(
      activation.result,
      activation.serviceEnv,
      `SERVICE-DEFINITION: ${refusal.message} The updated installation is kept; after resolving the service hold, run \`${formatCliCommand("openclaw gateway start", activation.serviceEnv)}\`. Gateway readiness remains unverified.`,
    );
    if (!verificationObserved) {
      await recordFailedUpdateGatewayState(params.opts.run, activation.serviceEnv, assertCurrent);
      assertCurrent();
    }
    return "reconciliation-pending" as const;
  };
  const assertRestartFailureCurrent = (failure: unknown) => {
    if (hasCommandProcessCleanupError(failure)) {
      throw failure;
    }
    assertCurrent();
    if (failure instanceof UpdateCommandRecoveryPendingError) {
      throw failure;
    }
  };
  const readServiceStartRefusal = async (failure: unknown) => {
    if (failure instanceof ServiceStartRefusalError) {
      return failure.refusal;
    }
    const deadline = createGatewayRestartDeadline({ timeoutMs: activation.timeoutMs });
    try {
      const runtime = await deadline.run(() =>
        deadline.read("service startup refusal", () =>
          resolveGatewayService().readRuntime(activation.serviceEnv, {
            timeoutMs: deadline.remainingMs(),
          }),
        ),
      );
      assertCurrent();
      return runtime?.systemd?.startRefusal;
    } catch (error) {
      if (hasCommandProcessCleanupError(error)) {
        throw error;
      }
      if ((await deadline.cleanup) === "unknown") {
        throw new CommandProcessCleanupError({ cause: error });
      }
      assertCurrent();
      return error instanceof ServiceStartRefusalError ? error.refusal : undefined;
    } finally {
      deadline.dispose();
    }
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
      expectedVersion: expectedGatewayVersion,
      expectedBuildId: expectedGatewayBuildId,
      requireRunningService: opts.requireRunningService,
      health: opts.health,
      onVerified: params.onVerified,
      assertCurrent,
      recoverHealth: async (initialHealth, reinspect, assertReadinessCurrent) => {
        assertReadinessCurrent();
        if (
          childReadinessPending ||
          opts.recoverHealth === false ||
          initialHealth.runtime?.systemd?.startRefusal
        ) {
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
            assertCurrent: assertReadinessCurrent,
          });
          assertReadinessCurrent();
          const currentOwner = readGatewayOwnerLease({ env: activation.serviceEnv });
          if (
            terminated.length > 0 &&
            (!currentOwner || currentOwner.state === "dead") &&
            (canRestartUpdatedInstall() || !isPackageUpdate)
          ) {
            activationAccepted =
              (await runUpdatedInstallGatewayCommand(
                { ...activation, assertCurrent: assertReadinessCurrent },
                "restart",
              )) === "accepted";
          }
          health = await reinspect();
        }
        const recovery = await recoverLaunchAgentAndRecheckGatewayHealth({
          onGatewayStartAttempted: params.onGatewayStartAttempted,
          updateRun: params.opts.run,
          assertCurrent: assertReadinessCurrent,
          preserveDefinition,
          health,
          service: resolveGatewayService(),
          port: activation.gatewayPort,
          timeoutMs: activation.timeoutMs,
          expectedVersion: expectedGatewayVersion,
          ...(expectedGatewayBuildId ? { expectedBuildId: expectedGatewayBuildId } : {}),
          env: activation.serviceEnv,
        });
        assertReadinessCurrent();
        if (recovery.launchAgentRecovery?.attempted) {
          activationAccepted = recovery.launchAgentRecovery.recovered;
        }
        return recovery;
      },
    });
    verificationObserved = true;
    assertCurrent();
    if (verification.serviceDefinitionRefusal) {
      return await serviceDefinitionRefused(verification.serviceDefinitionRefusal);
    }
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
      const expectedIdentity = activation.expectedGatewayIdentity ?? activation.result.after;
      let expectedGatewayVersion = normalizeOptionalString(expectedIdentity?.version);
      const expectedGatewayBuildId = normalizeOptionalString(expectedIdentity?.buildId);
      const canVerifyUpdatedGatewayByVersion =
        expectedGatewayVersion !== undefined &&
        expectedGatewayVersion !== normalizeOptionalString(activation.result.before?.version);
      let restarted = false;
      let refreshedGatewayHealth: GatewayRestartSnapshot | undefined;
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
            const { health } = await observeUpdateGatewayReadiness({
              healthOnly: true,
              gatewayPort: activation.gatewayPort,
              timeoutMs: activation.timeoutMs,
              expectedVersion: expectedGatewayVersion,
              ...(expectedGatewayBuildId ? { expectedBuildId: expectedGatewayBuildId } : {}),
              requirePluginHealth: false,
              serviceEnv: activation.serviceEnv,
              requireRunningService: true,
              settle: { probes: 12 },
              assertCurrent,
            });
            assertCurrent();
            refreshedGatewayHealth =
              health.healthy ||
              health.waitOutcome === "timeout" ||
              health.waitOutcome === "still-starting" ||
              health.runtime.systemd?.startRefusal
                ? health
                : undefined;
          }
        } catch (err) {
          assertRestartFailureCurrent(err);
          if (!activation.definitionRecovery?.unverified) {
            const refusal = await readServiceStartRefusal(err);
            if (refusal) {
              return await serviceDefinitionRefused(refusal);
            }
          }
          const warning =
            `Failed to reconcile gateway service with ${activation.result.root ?? "the updated install"}: ${String(err)}. ` +
            `Run \`${formatCliCommand("openclaw gateway install --force", activation.serviceEnv)}\`, then \`${formatCliCommand("openclaw gateway restart", activation.serviceEnv)}\`.`;
          recordServiceReconciliationWarning(activation.result, activation.serviceEnv, warning);
          if (activation.serviceRuntimeRefreshRequired) {
            params.onVerificationFailure?.("service-runtime-refresh-failed");
            throw err;
          }
          if (activation.definitionRecovery?.unverified) {
            params.onVerificationFailure?.("service-definition-rollback-unverified");
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
            const state = await readGatewayServiceStateForUpdate(
              resolveGatewayService(),
              activation.serviceEnv,
              activation.timeoutMs,
              { managerUid: activation.serviceManagerUid, assertCurrent },
            );
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
            const deadline = createGatewayRestartDeadline({ timeoutMs: activation.timeoutMs });
            try {
              activation = {
                ...activation,
                serviceEnv: state.env,
                gatewayPort: await deadline.run(() =>
                  deadline.read("retained service port", () =>
                    resolveUpdatedGatewayRestartPort({
                      serviceEnv: state.env,
                      serviceCommand: state.command,
                    }),
                  ),
                ),
              };
            } catch (error) {
              if ((await deadline.cleanup) === "unknown") {
                throw new CommandProcessCleanupError({ cause: error });
              }
              throw error;
            } finally {
              deadline.dispose();
            }
            assertCurrent();
            expectedGatewayVersion = normalizeOptionalString(activation.result.after?.version);
          }
          if (isPackageUpdate) {
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
      if (
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

      const shouldVerifyRestart = restarted || activation.requireRunningServiceAfterRestart;
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
        if (restartHealthy === "readiness-pending" || restartHealthy === "reconciliation-pending") {
          return restartHealthy;
        }
      }

      if (!activation.opts.json && restarted && !preserveDefinition) {
        defaultRuntime.log(theme.success("Daemon restarted successfully."));
        defaultRuntime.log("");
      }
    } catch (err) {
      assertRestartFailureCurrent(err);
      if (!activation.definitionRecovery?.unverified) {
        const refusal = await readServiceStartRefusal(err);
        if (refusal) {
          return await serviceDefinitionRefused(refusal);
        }
      }
      if (err instanceof GatewayRestartHealthError && !updatedInstallRestartNeedsServiceRootProof) {
        // The installed CLI owns restart retries; observe its final health result
        // without another native mutation.
        const healthy = await verifyRestartedGateway(
          normalizeOptionalString(
            (activation.expectedGatewayIdentity ?? activation.result.after)?.version,
          ),
          normalizeOptionalString(
            (activation.expectedGatewayIdentity ?? activation.result.after)?.buildId,
          ),
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
    const doctor =
      activation.result.mode === "npm" || activation.result.mode === "pnpm"
        ? `\`${formatCliCommand("openclaw doctor", activation.serviceEnv)}\`, then `
        : "";
    defaultRuntime.log(
      theme.muted(
        `Tip: Run ${doctor}\`${formatCliCommand("openclaw gateway restart", activation.serviceEnv)}\` to apply updates to a running gateway.`,
      ),
    );
  }
  return "ok";
}
