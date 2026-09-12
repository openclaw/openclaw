/** Optional pre-doctor update prompt for source checkouts and package installs. */
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import { exitCliAfterOutput } from "../cli/one-shot-exit.js";
import { isTerminalInteractive } from "../cli/terminal-interactivity.js";
import { createUpdateProgress } from "../cli/update-cli/progress.js";
import { tryResolveInvocationCwd, UpdatePreMutationError } from "../cli/update-cli/shared.js";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import {
  continueMigratedUpdateInFreshProcess,
  inspectActivatedUpdateState,
} from "../cli/update-cli/update-command-migrated.js";
import { UpdateCommandRecoveryPendingError } from "../cli/update-cli/update-command-recovery.js";
import {
  UpdateCommandFailure,
  UpdateCommandPendingRecoveryFailure,
} from "../cli/update-cli/update-command-result.js";
import {
  admitUpdateCommandRun,
  completeUpdateCommandRun,
  createUpdateRunProgress,
  failUpdateCommandRun,
} from "../cli/update-cli/update-command-run.js";
import { isUpdatedInstallGatewayExecutorSupported } from "../cli/update-cli/update-command-service-command.js";
import {
  withOwnedManagedUpdateEnv,
  resolveServiceRefreshEnv,
  resolveUpdatedInstallCommandEnv,
} from "../cli/update-cli/update-command-service-env.js";
import { resolveUnsafeUpdateRecoveryGuidance } from "../cli/update-cli/update-recovery-guidance.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { isDefaultInstallIdentity, resolveStateDir } from "../config/paths.js";
import { ScheduledTaskAutoStartRecoveryError } from "../daemon/schtasks-update-recovery.js";
import { readGatewayServiceState, resolveGatewayService } from "../daemon/service.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { formatErrorMessage } from "../infra/errors.js";
import { readUpdateStateSchemaVersions } from "../infra/update-candidate-state.js";
import type { UpdateRecovery } from "../infra/update-recovery.js";
import { UPDATE_RUNNER_TIMEOUT_MS } from "../infra/update-runner-command.js";
import { readCurrentGitUpdateRecovery } from "../infra/update-runner-git-recovery.js";
import { runGatewayUpdate } from "../infra/update-runner.js";
import type { UpdateRunResult } from "../infra/update-runner.js";
import { loadInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { classifyUpdateOutcome } from "../shared/update-outcome.js";
import type { OpenClawSchemaVersions } from "../state/openclaw-schema-versions.js";
import type { DoctorOptions } from "./doctor-prompter.js";
import {
  EXTERNAL_SERVICE_REPAIR_NOTE,
  isServiceRepairExternallyManaged,
} from "./doctor-service-repair-policy.js";

async function resolveComparablePath(target: string): Promise<string> {
  return await fs.realpath(target).catch(() => path.resolve(target));
}

async function detectOpenClawGitCheckout(root: string): Promise<"git" | "not-git" | "unknown"> {
  const res = await runCommandWithTimeout(["git", "-C", root, "rev-parse", "--show-toplevel"], {
    timeoutMs: 5000,
  }).catch(() => null);
  if (!res) {
    return "unknown";
  }
  if (res.code !== 0) {
    // Avoid noisy "Update via package manager" notes when git is missing/broken,
    // but do show it when this is clearly not a git checkout.
    if (normalizeLowercaseStringOrEmpty(res.stderr).includes("not a git repository")) {
      return "not-git";
    }
    return "unknown";
  }
  const gitRoot = res.stdout.trim();
  return (await resolveComparablePath(gitRoot)) === (await resolveComparablePath(root))
    ? "git"
    : "not-git";
}

/** Offers to update OpenClaw before doctor when running interactively from an updatable install. */
export async function maybeOfferUpdateBeforeDoctor(params: {
  runtime: RuntimeEnv;
  options: DoctorOptions;
  root: string | null;
  confirm: (p: { message: string; initialValue: boolean }) => Promise<boolean>;
  outro: (message: string) => void;
}): Promise<{ updated: boolean; handled?: boolean }> {
  const updateInProgress = isTruthyEnvValue(process.env.OPENCLAW_UPDATE_IN_PROGRESS);
  const canOfferUpdate =
    !updateInProgress &&
    params.options.nonInteractive !== true &&
    params.options.yes !== true &&
    params.options.repair !== true &&
    process.stdin.isTTY;
  if (!canOfferUpdate || !params.root) {
    return { updated: false };
  }

  const git = await detectOpenClawGitCheckout(params.root);
  if (git === "git") {
    const shouldUpdate = await params.confirm({
      message: "Update OpenClaw from git before running doctor?",
      initialValue: true,
    });
    if (!shouldUpdate) {
      return { updated: false };
    }
    const updateRoot = params.root;
    const invocationCwd = tryResolveInvocationCwd();
    const operatorEnv = resolveServiceRefreshEnv(process.env, invocationCwd);
    const { prepareUpdateFailureTriage } = await import("../infra/update-triage.js");
    const runTriage = await prepareUpdateFailureTriage({
      runtime: params.runtime,
      mode: isTerminalInteractive() ? "interactive" : "non-interactive",
      invocationCwd,
    });
    const externallyManaged = isServiceRepairExternallyManaged();
    const serviceLifecycle =
      isDefaultInstallIdentity(process.env) && !externallyManaged
        ? await import("../cli/update-cli/managed-gateway-update.runtime.js")
        : undefined;
    let inspection = await serviceLifecycle?.maybeStopManagedServiceBeforeMutableUpdate({
      updateInstallKind: "git",
      root: updateRoot,
      shouldRestart: true,
      jsonMode: false,
      phase: "inspect",
    });
    if (inspection?.blockMessage) {
      note(inspection.blockMessage, "Update");
      return { updated: false };
    }
    if (inspection?.serviceMutationSkipMessage) {
      note(inspection.serviceMutationSkipMessage, "Update");
    }
    const run = await admitUpdateCommandRun({ opts: {}, root: updateRoot, invocationCwd });
    let gitMutationAuthorized = false;
    let restartSafe = false;
    let recoveryEnv: NodeJS.ProcessEnv | undefined;
    note("Running update…", "Update");
    const { progress: displayProgress, stop } = createUpdateProgress(process.stdout.isTTY);
    const progress = createUpdateRunProgress(run, displayProgress);
    let ledgerHandoffOwned = false;
    let stateInspected = false;
    let schemaVersions: Awaited<ReturnType<typeof readUpdateStateSchemaVersions>> | undefined;
    let candidateSchemaVersions: OpenClawSchemaVersions | undefined;
    let configSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>> | undefined;
    let preUpdatePluginInstallRecords: Awaited<
      ReturnType<typeof loadInstalledPluginIndexInstallRecords>
    > = {};
    const startedAt = Date.now();
    let result: UpdateRunResult | undefined;
    let executorFence: NonNullable<typeof run.executorFence> | undefined;
    let originalRecovery: UpdateRecovery | undefined;
    let completionMessage: string | undefined;
    const errors: string[] = [];
    const assertCurrent = () => {
      if (!executorFence || run.executorFence !== executorFence) {
        throw new UpdateCommandRecoveryPendingError("Doctor update lost its original executor.");
      }
      executorFence.assertCurrent();
      return executorFence;
    };
    const failedUpdate = (error: unknown, reason: string): UpdateRunResult => {
      const message = formatErrorMessage(error);
      const durationMs = Date.now() - startedAt;
      errors.push(message);
      return {
        ...result,
        status: "error",
        mode: "git",
        root: updateRoot,
        reason,
        recovery:
          result?.recovery?.serviceRestartSafe === false
            ? result.recovery
            : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        steps: [
          ...(result?.steps ?? []),
          {
            name: reason,
            command: "openclaw update",
            cwd: updateRoot,
            durationMs,
            exitCode: 1,
            stderrTail: message,
          },
        ],
        durationMs,
      };
    };
    const continueMigratedUpdate = async (input: UpdateRunResult): Promise<boolean> => {
      if (stateInspected || !schemaVersions || !configSnapshot) {
        return false;
      }
      assertCurrent();
      stateInspected = true;
      const rollbackBlockedReason = await inspectActivatedUpdateState({
        result: input,
        root: updateRoot,
        schemaVersions,
        candidateSchemaVersions,
        config: configSnapshot.config,
        env: run.env,
      });
      assertCurrent();
      if (!rollbackBlockedReason) {
        return false;
      }
      // The installed runtime owns all state writes after migration, including
      // a lost response or failure: the previous Doctor must not settle the run.
      ledgerHandoffOwned = true;
      const continued = await continueMigratedUpdateInFreshProcess(
        {
          result: input,
          mutationStarted: gitMutationAuthorized,
          root: updateRoot,
          installKindChanged: false,
          configSnapshot,
          requestedChannel: null,
          storedChannel: null,
          channel: "dev",
          downgradeRisk: false,
          shouldRestart: true,
          opts: { run },
          preManagedServiceStop: inspection,
          ownedManagedUpdateEnv: run.env,
          controlPlaneUpdateSentinelMeta: null,
          preUpdatePluginInstallRecords,
          startedAt,
          updateStepTimeoutMs: UPDATE_RUNNER_TIMEOUT_MS,
          invocationCwd,
          schemaVersions,
          rollbackBlockedReason,
        },
        progress.pendingSteps,
      );
      if (continued.exitCode !== 0) {
        throw new UpdateCommandFailure(continued.result, continued.exitCode);
      }
      return true;
    };
    const completeNativeRecovery = async (input: UpdateRunResult) => {
      assertCurrent();
      try {
        // Autostart compensation still needs the live original executor.
        await inspection?.windowsTaskAutoStartRecovery?.complete(restartSafe);
        assertCurrent();
        result = input;
      } catch (error) {
        if (
          error instanceof UpdateCommandRecoveryPendingError ||
          error instanceof UpdateCommandPendingRecoveryFailure
        ) {
          throw error;
        }
        assertCurrent();
        result = failedUpdate(error, input.reason ?? "windows-task-autostart-restore-failed");
      }
    };
    const executeUpdate = async () => {
      try {
        result = await withOwnedManagedUpdateEnv(run.env, async () =>
          runGatewayUpdate({
            runId: run.runId,
            cwd: updateRoot,
            argv1: process.argv[1],
            progress,
            allowGatewayServiceRepair:
              inspection?.serviceUpdateVerdict?.kind === "owned" &&
              inspection.serviceUpdateVerdict.refreshDefinition,
            allowGatewayActivation: Boolean(
              inspection?.running && inspection.serviceUpdateVerdict?.kind === "owned",
            ),
            // Additive inspection leaves the runner's default config validation intact.
            inspectGitCandidate:
              inspection?.serviceUpdateVerdict?.kind === "owned"
                ? async (candidateRoot: string) => {
                    const executor = assertCurrent();
                    const supported = await isUpdatedInstallGatewayExecutorSupported({
                      root: candidateRoot,
                      env: resolveUpdatedInstallCommandEnv({ processEnv: run.env, invocationCwd }),
                      executor,
                    });
                    assertCurrent();
                    if (!supported) {
                      throw new UpdatePreMutationError(
                        "target-native-unsupported",
                        "Target runtime cannot fence update-owned native commands; refusing before Gateway stop or activation.",
                      );
                    }
                  }
                : undefined,
            beforeGitMutation: async (target) => {
              assertCurrent();
              configSnapshot = await readConfigFileSnapshot({
                skipPluginValidation: true,
                observe: false,
              });
              assertCurrent();
              preUpdatePluginInstallRecords = await loadInstalledPluginIndexInstallRecords({
                env: run.env,
              });
              assertCurrent();
              schemaVersions = await readUpdateStateSchemaVersions({
                stateDir: resolveStateDir(run.env),
                config: configSnapshot.config,
                env: run.env,
              });
              assertCurrent();
              candidateSchemaVersions = target.schemaVersions;
              if (serviceLifecycle) {
                // A native stop can mutate before preparation returns or Git starts.
                originalRecovery = await readCurrentGitUpdateRecovery(updateRoot);
                assertCurrent();
                const previousSkip = inspection?.serviceMutationSkipMessage;
                inspection = await serviceLifecycle.maybeStopManagedServiceBeforeMutableUpdate({
                  updateInstallKind: "git",
                  root: updateRoot,
                  shouldRestart: true,
                  jsonMode: false,
                  phase: "prepare",
                  updateRun: run,
                  onStopped: (state) => {
                    inspection = state;
                  },
                  expectedService:
                    inspection?.serviceUpdateVerdict?.kind === "owned" ? inspection : undefined,
                });
                assertCurrent();
                if (inspection.blockMessage) {
                  throw new Error(inspection.blockMessage);
                }
                if (
                  inspection.serviceMutationSkipMessage !== previousSkip &&
                  inspection.serviceMutationSkipMessage
                ) {
                  note(inspection.serviceMutationSkipMessage, "Update");
                }
                inspection.windowsTaskAutoStartRecovery?.beginMutation();
              }
              assertCurrent();
              progress.deferLedgerWrites();
              gitMutationAuthorized = true;
              return serviceLifecycle && inspection
                ? serviceLifecycle.resolvePreparedGatewayUpdatePolicy(inspection, true)
                : undefined;
            },
          }),
        );
        assertCurrent();
        if (await continueMigratedUpdate(result)) {
          return { updated: true, handled: true };
        }
        restartSafe = result.recovery?.serviceRestartSafe ?? result.status === "ok";
        if (restartSafe) {
          assertCurrent();
          await inspection?.windowsTaskAutoStartRecovery?.restore(true);
          assertCurrent();
        }
      } catch (err) {
        if (
          ledgerHandoffOwned ||
          err instanceof UpdateCommandRecoveryPendingError ||
          err instanceof UpdateCommandPendingRecoveryFailure
        ) {
          throw err;
        }
        assertCurrent();
        if (err instanceof ScheduledTaskAutoStartRecoveryError) {
          // Native preparation may fail after disabling autostart, before it can
          // return an inspection. Carry its recorded failure and target to triage.
          recoveryEnv = err.serviceEnv;
        } else if (!gitMutationAuthorized) {
          // Preserve an observed partial stop even if preparation never returned.
          if (inspection?.stopped) {
            const recovered = await serviceLifecycle?.maybeRestartServiceAfterFailedMutableUpdate({
              recovery: originalRecovery,
              updateRun: run,
              preManagedServiceStop: inspection,
              jsonMode: false,
              timeoutMs: UPDATE_RUNNER_TIMEOUT_MS,
              invocationCwd,
            });
            assertCurrent();
            restartSafe = recovered === "healthy";
          } else {
            restartSafe = true;
          }
          await inspection?.windowsTaskAutoStartRecovery?.complete(restartSafe);
          assertCurrent();
          throw err;
        }
        const reason =
          err instanceof ScheduledTaskAutoStartRecoveryError
            ? "gateway-service-recovery-failed"
            : result
              ? "windows-task-autostart-restore-failed"
              : "update-failed";
        result = failedUpdate(err, reason);
        restartSafe = false;
        if (reason === "update-failed") {
          note("The source checkout may be partially mutated.", "Update");
        }
      }
      assertCurrent();
      if (await continueMigratedUpdate(result)) {
        return { updated: true, handled: true };
      }
      if (result.status !== "ok" || !restartSafe) {
        if (
          result.recovery?.serviceRestartSafe === false ||
          (result.status === "error" && result.recovery?.serviceRestartSafe !== true)
        ) {
          const recovery: UpdateRecovery =
            result.recovery?.serviceRestartSafe === false
              ? result.recovery
              : { serviceRestartSafe: false, reason: "runtime-verification-failed" };
          result = { ...result, status: "error", recovery };
          const managedGatewayStopped = inspection?.stopped === true;
          const summary = managedGatewayStopped
            ? `Managed gateway remains stopped because update recovery could not prove a runnable installation (${recovery.reason}).`
            : `Update recovery could not prove a runnable installation (${recovery.reason}).`;
          const keepStopped = managedGatewayStopped
            ? "\nKeep the gateway stopped until the update succeeds."
            : "";
          note(
            `${summary}\n${resolveUnsafeUpdateRecoveryGuidance(recovery.reason)}${keepStopped}`,
            "Update",
          );
        } else if (result.recovery?.serviceRestartSafe === true) {
          const recovered = await serviceLifecycle?.maybeRestartServiceAfterFailedMutableUpdate({
            recovery: result.recovery,
            updateRun: run,
            preManagedServiceStop: inspection,
            jsonMode: false,
            timeoutMs: UPDATE_RUNNER_TIMEOUT_MS,
            invocationCwd,
          });
          assertCurrent();
          if (recovered) {
            restartSafe = recovered === "healthy";
            result = {
              ...result,
              status: recovered === "failed" ? "error" : result.status,
              recovery: { ...result.recovery, service: recovered },
            };
          }
        }
        await completeNativeRecovery(result);
        return { updated: true, handled: false };
      }
      if (externallyManaged) {
        note(EXTERNAL_SERVICE_REPAIR_NOTE, "Update");
      } else if (inspection?.stopped && inspection.serviceEnv && serviceLifecycle) {
        try {
          const service = resolveGatewayService();
          const serviceState = await readGatewayServiceState(service, {
            env: inspection.serviceEnv,
            requireEffective: true,
          });
          assertCurrent();
          const verdict = await serviceLifecycle.revalidateManagedGatewayServiceAfterUpdate({
            state: serviceState,
            root: updateRoot,
            preManagedServiceStop: inspection,
          });
          assertCurrent();
          const gatewayPort = await serviceLifecycle.resolveUpdatedGatewayRestartPort({
            serviceEnv: serviceState.env,
            serviceCommand: serviceState.command,
          });
          assertCurrent();
          // Doctor already ran during the update; reuse activation/health without another repair.
          const activated = await serviceLifecycle.maybeRestartService({
            shouldRestart: true,
            result,
            opts: { run },
            refreshServiceEnv: false,
            serviceUpdateVerdict:
              verdict.kind === "owned" ? { ...verdict, refreshDefinition: false } : verdict,
            serviceEnv: serviceState.env,
            gatewayPort,
            requireRunningServiceAfterRestart: true,
            timeoutMs: UPDATE_RUNNER_TIMEOUT_MS,
          });
          assertCurrent();
          if (activated !== "ok") {
            throw new Error(
              "Gateway restart was not verified; run `openclaw gateway status --deep` before restarting manually.",
            );
          }
          note("Restarted the running gateway service after updating OpenClaw.", "Update");
        } catch (err) {
          if (
            err instanceof UpdateCommandRecoveryPendingError ||
            err instanceof UpdateCommandPendingRecoveryFailure
          ) {
            throw err;
          }
          restartSafe = false;
          const message = "Update completed, but gateway service restart failed";
          result = failedUpdate(
            new Error(`${message}: ${formatErrorMessage(err)}`),
            "gateway-restart-failed",
          );
          completionMessage = `${message}.`;
          await completeNativeRecovery(result);
          return { updated: true, handled: true };
        }
      }
      await completeNativeRecovery(result);
      completionMessage = "Update completed (doctor already ran as part of the update).";
      return { updated: true, handled: true };
    };
    let outcome: Awaited<ReturnType<typeof executeUpdate>>;
    let operationError: Error | undefined;
    try {
      outcome = await withUpdateCommandExecutor(run.runId, async (executor) => {
        executorFence = await executor.enter(updateRoot);
        run.executorFence = executorFence;
        assertCurrent();
        try {
          return await executeUpdate();
        } catch (error) {
          // Keep the same normalized failure across the executor's error boundary.
          operationError =
            error instanceof Error ? error : new Error("Update execution failed", { cause: error });
          throw operationError;
        }
      });
    } catch (error) {
      // The candidate retains its ledger even when its response is lost.
      // Pending custody must not open history or start another update via triage.
      if (
        error === operationError &&
        !ledgerHandoffOwned &&
        !(error instanceof UpdateCommandRecoveryPendingError) &&
        !(error instanceof UpdateCommandPendingRecoveryFailure)
      ) {
        failUpdateCommandRun(error, run);
      }
      throw error;
    } finally {
      stop();
    }
    if (ledgerHandoffOwned) {
      return outcome;
    }
    if (!result) {
      throw new Error("Doctor update completed without a result.");
    }
    // Only the complete executor promise includes descendant settlement/release.
    // Fulfillment does not turn a failed domain result into update success.
    progress.flushLedgerWrites();
    result = completeUpdateCommandRun(result, run);
    const resultDetails = [
      `Status: ${result.status}`,
      `Mode: ${result.mode}`,
      result.root && `Root: ${result.root}`,
      result.reason && `Reason: ${result.reason}`,
    ].filter(Boolean);
    note(resultDetails.join("\n"), "Update result");
    for (const message of errors) {
      params.runtime.error(message);
    }
    if (classifyUpdateOutcome(result) === "failed") {
      const serviceEnv =
        recoveryEnv ??
        (inspection?.serviceUpdateVerdict?.kind === "owned" ? inspection.serviceEnv : undefined);
      await runTriage({
        failure: { result },
        target: { root: updateRoot, env: serviceEnv ?? operatorEnv },
      });
      exitCliAfterOutput(params.runtime, 1);
    }
    if (completionMessage) {
      params.outro(completionMessage);
    }
    return outcome;
  }

  if (git === "not-git") {
    note(
      [
        "This install is not a git checkout.",
        `Run \`${formatCliCommand("openclaw update")}\` to update via your package manager (npm/pnpm), then rerun doctor.`,
      ].join("\n"),
      "Update",
    );
  }

  return { updated: false };
}
