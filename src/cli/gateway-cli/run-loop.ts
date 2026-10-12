import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import * as restartTrace from "../../gateway/restart-trace.js";
import { GatewayStartupCleanupError } from "../../gateway/server-shutdown.js";
import type { startGatewayServer } from "../../gateway/server.js";
import type { GatewayInstallationReplacement } from "../../gateway/stale-install.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { GatewayBootLifecycleCompletion } from "../../infra/gateway-boot-lifecycle.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import { consumeGatewaySuspendHandoff } from "../../infra/gateway-suspend-coordinator.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import { findStartupMaintenanceRequiredError } from "../../infra/startup-maintenance-required.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runWithProcessCleanupBudget } from "../../process/supervisor/cleanup-budget.js";
import { formatCliCommand } from "../command-format.js";
import { registerSignalExitOwner } from "../signal-exit-barrier.js";
import { measureGatewayBootstrapStep } from "../startup-trace.js";
import { createGatewayHostLifecycle } from "./host-lifecycle.js";
import { installGatewayHostLifeline } from "./host-lifeline.js";
import { createGatewayRunCleanup } from "./run-loop-cleanup.js";
import { drainGatewayActiveWork } from "./run-loop-drain.js";
import * as loopExit from "./run-loop-exit.js";
import {
  isUpdateProcessRestartReason,
  registerGatewayRunInstallationReplacement,
  resolveGatewayRunSignalRequestUpgrade,
  sameManagedUpdateOwner,
  type GatewayRunSignalAction,
  type GatewayRunSignalContext,
  type GatewayRunSignalRequest,
} from "./run-loop-request.js";
import { createGatewayRestartRuntimePreparation } from "./run-loop-runtime-preparation.js";
import {
  resolveGatewayShutdownDrainBudget,
  resolveGatewayShutdownBudget,
} from "./run-loop-shutdown-budget.js";
import * as loopCompletion from "./run-loop-shutdown-format.js";
import { createGatewayRunSignals } from "./run-loop-signals.js";
import { createGatewayStartupWatchdog } from "./run-loop-startup-watchdog.js";
import {
  createGatewayRestartRecovery,
  createGatewayStartupOperations,
  prepareGatewayRestartIteration,
  prepareGatewayRunLoop,
  type GatewayRunLoopStartOptions,
  type GatewayRestartStartupFailureHandler,
} from "./run-loop-startup.js";
import {
  createGatewayRunTerminal,
  type GatewayShutdownFailure as ShutdownFailure,
} from "./run-loop-terminal.js";
import {
  armShutdownHardExitWatchdog,
  type ShutdownHardExitWatchdog,
} from "./shutdown-hard-exit.js";
import { GatewayUpdateSuccessor } from "./update-successor.js";
const gatewayLog = createSubsystemLogger("gateway");
const HARD_EXIT_WATCHDOG_GRACE_MS = 2_000;

export async function runGatewayLoop(params: {
  start: (
    params?: GatewayRunLoopStartOptions,
  ) => Promise<Awaited<ReturnType<typeof startGatewayServer>>>;
  /** Grants this run loop authority over the process it exclusively owns. */
  ownsProcessLifecycle?: boolean;
  lockPort?: number;
  lifecycleLockDeadlineMs?: number;
  healthHost?: string;
  beginBoot?: (startedAtMs: number) => void | Promise<void>;
  completeBoot?: (completion: GatewayBootLifecycleCompletion) => void;
  /** Reports terminal cleanup disposition, never mere invocation or exit intent. */
  onProcessResourcesSettled?: (outcome: "drained" | "retained") => void;
  onRestartStartupFailure?: GatewayRestartStartupFailureHandler;
}): Promise<number> {
  // macOS/BSD process inspection reports process.title instead of the original
  // argv. Give the long-running Gateway a verifiable identity for lock readers.
  if (process.title === "openclaw") {
    process.title = "openclaw-gateway";
  }
  let startupStartedAt: number;
  const initial = await prepareGatewayRunLoop(params, gatewayLog);
  const {
    lifecycleRuntime: eagerLifecycleRuntime,
    supervisor,
    supervisorMode,
    restartDecision,
    startupBudget,
  } = initial;
  let lock = initial.lock;
  const cleanup = createGatewayRunCleanup(
    params.ownsProcessLifecycle,
    eagerLifecycleRuntime,
    gatewayLog,
    () => foregroundUpdateClosed,
  );
  let server: Awaited<ReturnType<typeof startGatewayServer>> | null = null;
  let startupWork: Promise<unknown> | undefined;
  let terminalExitCode: number | undefined;
  let hostLifecycle: ReturnType<typeof createGatewayHostLifecycle> | undefined;
  let startupOperations = createGatewayStartupOperations();
  let runtimeResetPending = false;
  let terminalHostedStop: ReturnType<typeof createGatewayHostLifecycle> | undefined;
  let shuttingDown = false;
  let hostExitRequested = false;
  let hostExitCode = 0;
  let releaseHostLifeline: (() => void) | undefined;
  let releaseOutputOwner: (() => void) | undefined;
  const requestWatchdogs = new Set<() => void>();
  let forcedExitStarted = false;
  let restartResolver: (() => void) | null = null;
  // The HTTP server can report ready before params.start returns its close handle.
  // Defer lifecycle signals from that window until the loop can close and advance.
  let pendingStartupRequest: GatewayRunSignalRequest | null = null;
  let activeRestartRequest: GatewayRunSignalRequest | null = null;
  const updateSuccessor = new GatewayUpdateSuccessor(gatewayLog, eagerLifecycleRuntime);
  let foregroundUpdateClosed = false;
  let forceActiveRestartExit: (() => void) | null = null;
  let installationReplacement: GatewayInstallationReplacement | undefined;
  let pendingRestartCompletion: GatewayBootLifecycleCompletion | undefined;
  let restartDrainWarning: string | undefined;
  const completeBoot = (completion: GatewayBootLifecycleCompletion) => {
    pendingRestartCompletion = undefined;
    params.completeBoot?.(
      loopCompletion.formatBootCompletionContext(
        completion,
        installationReplacement?.reason,
        restartDrainWarning,
      ),
    );
    restartDrainWarning = undefined;
  };
  let startupFailedWithoutServerHandle = false;
  const restartRecovery = createGatewayRestartRecovery(params, gatewayLog, supervisor);
  const processInstanceId = randomUUID();
  const getManagedUpdateOwner = () =>
    (pendingStartupRequest ?? activeRestartRequest)?.restartIntent?.successorOwner;
  const restartRuntime = createGatewayRestartRuntimePreparation(eagerLifecycleRuntime, gatewayLog);

  const cleanupSignals = () => {
    signals.retire();
    releaseHostLifeline?.();
    releaseHostLifeline = undefined;
    releaseOutputOwner?.();
    releaseOutputOwner = undefined;
    releaseInstallationObserver();
    signals.close();
    cleanup.releaseProcessLifetime();
  };
  // Commit synchronously after the final updater authority check. The loop joins
  // the requesting job before returning; a signal job must never throw an exit.
  const finishLoop = (code: number) => {
    if (pendingRestartCompletion) {
      completeBoot(pendingRestartCompletion);
    }
    terminalExitCode ??= hostExitRequested && code === 0 ? hostExitCode : code;
    restartResolver?.();
  };
  const { finishLoopAfterCleanup, handleHostedStopAfterServerClose } = createGatewayRunTerminal({
    runtime: eagerLifecycleRuntime,
    logger: gatewayLog,
    updateSuccessor,
    restartRuntime,
    getSignals: () => signals,
    getHost: () => hostLifecycle,
    getRequest: () => pendingStartupRequest ?? activeRestartRequest,
    isForcedExitStarted: () => forcedExitStarted,
    isForegroundUpdateClosed: () => foregroundUpdateClosed,
    getTerminalHostedStop: () => terminalHostedStop,
    setTerminalHostedStop: (owner) => {
      terminalHostedStop = owner;
    },
    setPendingRestartCompletion: (completion) => {
      pendingRestartCompletion = completion;
    },
    drainProcessResources: cleanup.drainProcessResources,
    finishLoop,
    completeBoot,
    releaseLockIfHeld: () => releaseLockIfHeld(),
    markRestartHandoffUnavailable: () => markRestartHandoffUnavailable(),
    reacquireAndResumeInProcessRestart: (owner) => reacquireAndResumeInProcessRestart(owner),
    forceExitAfterStabilityBundle: (...args) => forceExitAfterStabilityBundle(...args),
  });
  const writeStabilityBundle = loopExit.createGatewayStabilityReporter(
    eagerLifecycleRuntime,
    gatewayLog,
  );
  const releaseLockIfHeld = async (): Promise<void> => {
    await lock?.release();
    lock = null;
  };
  const exitReplacedInstallation = async (replacement: GatewayInstallationReplacement) => {
    shuttingDown = true;
    gatewayLog.error(
      `${replacement.message} Cannot continue in this process. Run: ${formatCliCommand(supervisorMode ? "openclaw gateway restart" : "openclaw gateway run")}`,
    );
    pendingRestartCompletion ??= {
      outcome: "planned_restart",
      reason: "gateway.installation_replaced",
    };
    await releaseLockIfHeld();
    await finishLoopAfterCleanup(1);
  };
  const forceExitAfterStabilityBundle = async (
    reason: string,
    exitCode = 1,
    failure?: ShutdownFailure,
  ) => {
    if (
      foregroundUpdateClosed ||
      (updateSuccessor.waitingForStop && !getManagedUpdateOwner()) ||
      forcedExitStarted
    ) {
      return;
    }
    forcedExitStarted = true;
    const retirement = hostLifecycle?.retire();
    if (retirement) {
      cleanup.retain(retirement);
    }
    let stabilityFailure: { error: unknown } | undefined;
    try {
      writeStabilityBundle(reason, failure?.error, failure?.step);
    } catch (error) {
      stabilityFailure = { error };
    }
    // Exit rescue cannot replay an issued file append; join it before final authority checks.
    // Reserve half the hard-exit grace for final shutdown bookkeeping.
    await loopExit.flushGatewayLogsBeforeExit(gatewayLog, HARD_EXIT_WATCHDOG_GRACE_MS / 2);
    if (foregroundUpdateClosed) {
      return;
    }
    const owner = getManagedUpdateOwner();
    if (owner) {
      forceActiveRestartExit?.();
    }
    const restoration = await updateSuccessor.cancelHandoff(getManagedUpdateOwner, owner);
    if (restoration) {
      completeBoot({ outcome: "forced_stop", reason });
      if (restoration === "restart-after-exit") {
        await finishLoopAfterCleanup(exitCode, owner, "restore");
      } else {
        finishLoop(exitCode);
      }
    } else if (updateSuccessor.capturedStop) {
      await updateSuccessor.exit(exitCode, (code) => {
        completeBoot({ outcome: "forced_stop", reason });
        finishLoop(code);
      });
    }
    if (stabilityFailure) {
      throw stabilityFailure.error;
    }
  };
  const reacquireAndResumeInProcessRestart = async (
    alreadyCancelledOwner?: GatewayRestartIntent["successorOwner"],
  ): Promise<void> => {
    await signals.drain();
    if (restartRuntime.pending) {
      await restartRuntime.release();
    }
    if (foregroundUpdateClosed) {
      return finishLoopAfterCleanup(1);
    }
    for (;;) {
      if (forcedExitStarted) {
        return;
      }
      const restartRequest = activeRestartRequest;
      const restartOwner = restartRequest?.restartIntent?.successorOwner;
      const restoration = sameManagedUpdateOwner(restartOwner, alreadyCancelledOwner)
        ? "restored-in-process"
        : await updateSuccessor.cancelHandoff(getManagedUpdateOwner, restartOwner);
      if (!restoration || forcedExitStarted) {
        return;
      }
      if (restoration === "restart-after-exit") {
        await releaseLockIfHeld();
        return finishLoopAfterCleanup(0, restartOwner, "restore");
      }
      if (activeRestartRequest !== restartRequest) {
        continue;
      }
      if (installationReplacement) {
        // The old module graph cannot recover after its package has been replaced.
        return exitReplacedInstallation(installationReplacement);
      }
      if (!updateSuccessor.stopRequested && !hostExitRequested) {
        try {
          lock = await acquireGatewayLock({
            port: params.lockPort,
            listenerMode: supervisorMode ? "supervised" : "foreground",
            supervisor,
          });
        } catch (err) {
          if (forcedExitStarted) {
            return;
          }
          if (activeRestartRequest !== restartRequest) {
            continue;
          }
          gatewayLog.error(
            `failed to reacquire gateway lock for in-process restart: ${formatErrorMessage(err)}`,
          );
          finishLoop(1);
          return;
        }
      }
      if (updateSuccessor.stopRequested || hostExitRequested) {
        await releaseLockIfHeld();
      }
      if (installationReplacement) {
        return exitReplacedInstallation(installationReplacement);
      }
      if (!forcedExitStarted && activeRestartRequest === restartRequest) {
        while (signals.pending) {
          await signals.pending;
        }
        if (forcedExitStarted || activeRestartRequest !== restartRequest) {
          await releaseLockIfHeld();
          continue;
        }
        activeRestartRequest = null;
        if (updateSuccessor.stopRequested || hostExitRequested) {
          return restartRequest?.hostedStop
            ? handleHostedStopAfterServerClose(restartRequest.hostedStop, undefined)
            : finishLoopAfterCleanup(0);
        }
        shuttingDown = false;
        signals.sealStore();
        restartResolver?.();
        return;
      }
      await releaseLockIfHeld();
    }
  };
  const markRestartHandoffUnavailable = (reason?: string) =>
    updateSuccessor.markHandoffUnavailable(foregroundUpdateClosed, reason);
  const handleRestartAfterServerClose = async (
    expectedOwner?: GatewayRestartIntent["successorOwner"],
    initiallyCancelled = false,
    failure?: ShutdownFailure,
  ): Promise<void> => {
    await signals.drain();
    let cancelled = initiallyCancelled;
    const foregroundHandoff =
      expectedOwner && !cancelled && eagerLifecycleRuntime.isForegroundUpdateHandoff(expectedOwner);
    if (foregroundHandoff) {
      // Finish lazy old-runtime cleanup while activation is still fenced by the helper.
      try {
        await eagerLifecycleRuntime.stopActiveManagedProviderLocalServices();
      } catch (error) {
        gatewayLog.error(
          `foreground update cancelled after provider cleanup failed: ${formatErrorMessage(error)}`,
        );
        await markRestartHandoffUnavailable("restart-local-service-stop-failed");
        const restoration = await eagerLifecycleRuntime
          .cancelManagedServiceUpdateHandoff(expectedOwner)
          .catch(() => false);
        if (!restoration) {
          gatewayLog.error("foreground update cancellation unconfirmed; remaining draining");
          return;
        }
        if (restoration === "restart-after-exit") {
          await releaseLockIfHeld();
          return finishLoopAfterCleanup(1, expectedOwner, "restore");
        }
        // Cancellation joins the updater before lock release or reuse of unchanged code.
        cancelled = true;
      }
    }
    await releaseLockIfHeld();
    if (forcedExitStarted) {
      return;
    }
    if (hostExitRequested) {
      completeBoot(loopCompletion.formatHostExitCompletion(Boolean(failure)));
      return finishLoopAfterCleanup(failure ? 1 : 0);
    }
    // Lock release may yield while a managed update upgrades this restart.
    const restartReason = activeRestartRequest?.restartReason;
    pendingRestartCompletion = loopCompletion.formatRestartCompletion(
      activeRestartRequest,
      Boolean(failure),
    );
    const isUpdateRestart = isUpdateProcessRestartReason(restartReason);

    if (cancelled) {
      return reacquireAndResumeInProcessRestart(expectedOwner);
    }
    if (activeRestartRequest?.restartIntent?.successorOwner) {
      if (!expectedOwner) {
        gatewayLog.error("managed update handoff arrived after successor parking closed");
        await markRestartHandoffUnavailable();
        return reacquireAndResumeInProcessRestart();
      }
      if (foregroundHandoff) {
        if (!sameManagedUpdateOwner(getManagedUpdateOwner(), expectedOwner)) {
          const cancelledOwner = await updateSuccessor.cancelHandoff(
            getManagedUpdateOwner,
            expectedOwner,
          );
          if (cancelledOwner === "restored-in-process") {
            return reacquireAndResumeInProcessRestart(getManagedUpdateOwner());
          }
          return;
        }
        foregroundUpdateClosed = true;
        forceActiveRestartExit?.();
        const completed = await updateSuccessor.completeForegroundHandoffAfterClose(expectedOwner);
        if (updateSuccessor.stopRequested && activeRestartRequest.hostedStop) {
          return handleHostedStopAfterServerClose(activeRestartRequest.hostedStop, undefined);
        }
        if (!completed.respawn) {
          gatewayLog.error(
            "foreground update did not authorize a fresh Gateway; leaving it stopped for recovery",
          );
          return finishLoopAfterCleanup(1);
        }
        if (updateSuccessor.stopRequested) {
          return finishLoopAfterCleanup(0);
        }
      } else {
        gatewayLog.info("restart mode: managed update handoff owns successor");
        return finishLoopAfterCleanup(0, expectedOwner);
      }
    }

    const respawnOptions = {
      decision: restartDecision,
      env: restartTrace.createGatewayRestartTraceHandoffEnv(
        restartTrace.captureGatewayRestartTraceHandoff(),
      ),
    };
    const isStandaloneUpdate = Boolean(foregroundHandoff) || (isUpdateRestart && !supervisorMode);
    const respawn = isStandaloneUpdate
      ? eagerLifecycleRuntime.respawnGatewayProcessForUpdate(respawnOptions)
      : eagerLifecycleRuntime.restartGatewayProcessWithFreshPid(respawnOptions);
    if (respawn.mode === "spawned") {
      const child = respawn.child;
      if (foregroundUpdateClosed) {
        updateSuccessor.commit(child);
      }
      const observedRestartRequest = activeRestartRequest;
      const accepted = await updateSuccessor.observeReadiness(child, {
        port: params.lockPort,
        host: params.healthHost,
        foreground: foregroundUpdateClosed,
        // Old-server cleanup must not consume the replacement's readiness window.
        beforeWait: () => forceActiveRestartExit?.(),
        isCurrent: () => !foregroundUpdateClosed && activeRestartRequest === observedRestartRequest,
      });
      if (updateSuccessor.stopRequested) {
        return finishLoopAfterCleanup(0);
      }
      if (accepted) {
        gatewayLog.info(
          `restart mode: update process respawn (spawned pid ${respawn.pid ?? "unknown"})`,
        );
        return finishLoopAfterCleanup(0);
      }
      gatewayLog.warn(
        `update respawn child did not become healthy (${respawn.pid ?? "unknown"}); ${foregroundUpdateClosed ? "shutdown pending; retaining the replacement until it closes; inspect its startup logs" : installationReplacement ? "the replaced runtime cannot resume" : "falling back to in-process restart"}`,
      );
      try {
        await (foregroundUpdateClosed ? updateSuccessor.cancel() : child.kill());
      } catch (error) {
        gatewayLog.warn(`update respawn child did not settle: ${formatErrorMessage(error)}`);
      }
      await markRestartHandoffUnavailable("restart-unhealthy");
      return reacquireAndResumeInProcessRestart();
    }
    if (respawn.mode === "supervised") {
      const restartKind = isUpdateRestart ? "update-process" : "full-process";
      restartTrace.markGatewayRestartTrace("restart.full-process-handoff", [
        ["kind", restartKind],
        ["mode", respawn.mode],
        ["pid", "none"],
        ["supervisorMode", supervisorMode ?? "none"],
      ]);
      const handoffRequest = activeRestartRequest;
      const handoffIsCurrent = () =>
        signals.active && !forcedExitStarted && activeRestartRequest === handoffRequest;
      let handoff: Awaited<ReturnType<typeof eagerLifecycleRuntime.writeGatewayRestartHandoff>> =
        null;
      const runtimePreparation = restartRuntime.current;
      try {
        handoff = await eagerLifecycleRuntime.writeGatewayRestartHandoff(
          {
            restartKind,
            reason: restartReason,
            processInstanceId,
            supervisorMode: supervisorMode ?? "external",
            restartTrace: restartTrace.captureGatewayRestartTraceHandoff(),
            ...(runtimePreparation ? { runtimePreparation } : {}),
          },
          () => {
            if (!handoffIsCurrent()) {
              throw new Error("Gateway restart handoff no longer owns the shutdown request");
            }
          },
        );
      } catch (error) {
        if (handoffIsCurrent()) {
          throw error;
        }
      } finally {
        if (runtimePreparation) {
          await restartRuntime.release(runtimePreparation);
        }
      }
      if (forcedExitStarted || !signals.active) {
        return;
      }
      if (activeRestartRequest !== handoffRequest) {
        return handleRestartAfterServerClose();
      }
      if (supervisorMode === "external" && !handoff) {
        gatewayLog.warn(
          `external supervisor restart handoff could not be persisted; ${installationReplacement ? "the replaced runtime cannot resume" : "falling back to in-process restart"}`,
        );
        if (isUpdateRestart) {
          await markRestartHandoffUnavailable();
        }
        return reacquireAndResumeInProcessRestart();
      }
      gatewayLog.info("restart mode: full process restart (supervisor restart)");
      if (supervisorMode === "launchd") {
        const spawned = await loopExit.waitForLaunchdRestartHandoff(respawn.handoffSpawned);
        if (!spawned) {
          writeStabilityBundle("gateway.restart_handoff_spawn_failed");
          gatewayLog.warn(
            `launchd restart handoff failed to spawn; ${installationReplacement ? "the replaced runtime cannot resume" : "falling back to in-process restart"}`,
          );
          if (isUpdateRestart) {
            await markRestartHandoffUnavailable();
          }
          return reacquireAndResumeInProcessRestart();
        }
      }
      updateSuccessor.commit(true);
      return finishLoopAfterCleanup(respawn.exitCode ?? 0);
    }
    if (respawn.mode === "failed") {
      if (!isStandaloneUpdate) {
        writeStabilityBundle("gateway.restart_respawn_failed");
      }
      gatewayLog.warn(
        `${isStandaloneUpdate ? "update respawn" : "full process restart"} failed (${respawn.detail ?? "unknown error"}); ${foregroundUpdateClosed ? "leaving Gateway stopped for recovery" : installationReplacement ? "the replaced runtime cannot resume" : "falling back to in-process restart"}`,
      );
      if (isUpdateRestart) {
        await markRestartHandoffUnavailable("restart-unhealthy");
      }
    } else {
      gatewayLog.info(
        `restart mode: ${foregroundUpdateClosed ? "fresh process unavailable; leaving Gateway stopped" : installationReplacement ? "replaced runtime must exit" : "in-process restart"} (${respawn.detail ?? "OPENCLAW_NO_RESPAWN"})`,
      );
    }
    if (!isUpdateRestart && isUpdateProcessRestartReason(activeRestartRequest?.restartReason)) {
      return handleRestartAfterServerClose();
    }
    return reacquireAndResumeInProcessRestart();
  };
  let reportedBudget = startupBudget;
  startupBudget.log("startup");
  const startupWatchdog = createGatewayStartupWatchdog({
    startupBudget,
    supervisorMode,
    gatewayLog,
    ownsProcessLifecycle: params.ownsProcessLifecycle,
    hardExitGraceMs: HARD_EXIT_WATCHDOG_GRACE_MS,
    retireWatchdog: cleanup.retireWatchdog,
    retainCleanup: cleanup.retain,
    hasPendingRequest: () => pendingStartupRequest !== null,
    reportBudget: (budget) => {
      reportedBudget = budget;
    },
    onTimeout: () => {
      cleanup.retain(forceExitAfterStabilityBundle("gateway.restart_startup_request_timeout"));
    },
  });

  const runAcceptedRequest = (acceptedRequest: GatewayRunSignalRequest) => {
    const { action, restartIntent } = acceptedRequest;
    let budget = startupBudget;
    reportedBudget = budget;
    const isRestart = action !== "stop";
    const restartWithoutSupervisor = action === "restart" && restartDecision.mode === "disabled";
    const acceptedStartupOperations = startupOperations;
    if (acceptedRequest.action === "stop") {
      // A queued restart still needs startup's close handle. Only an effective
      // stop cancels preflight, including a stop overriding that queued restart.
      acceptedStartupOperations.close();
    }
    if (action === "restart") {
      activeRestartRequest = acceptedRequest;
    } else if (!isRestart) {
      restartTrace.startGatewayRestartTrace("stop.signal.received", [
        ["signal", acceptedRequest.signal],
      ]);
    }
    const preparedRuntime = restartRuntime.prepare(acceptedRequest, restartDecision);
    let forceExitTimer: ReturnType<typeof setTimeout> | null = null;
    let shutdownDeadline: number | undefined;
    let hardExitWatchdog: ShutdownHardExitWatchdog | null = null;
    let lastDrainCounts = "not observed";
    let shutdownFailure: ShutdownFailure | undefined;
    const armForceExitTimer = (forceExitMs: number) => {
      if (forceExitTimer || (updateSuccessor.waitingForStop && !getManagedUpdateOwner())) {
        return;
      }
      shutdownDeadline = performance.now() + forceExitMs;
      forceExitTimer = setTimeout(() => {
        const exitOk = budget.nativeStopBudget && !restartWithoutSupervisor && !shutdownFailure;
        gatewayLog.warn(
          `shutdown deadline reached; waiting for unfinished cleanup and active work before ${action}; last observed: ${lastDrainCounts}; pending close steps: ${restartTrace.formatGatewayPendingCloseSteps()}; cleanup incomplete; exitCode=${exitOk ? 0 : 1}`,
        );
        cleanup.retain(
          forceExitAfterStabilityBundle(
            isRestart ? "gateway.restart_shutdown_timeout" : "gateway.stop_shutdown_timeout",
            exitOk ? 0 : 1,
            shutdownFailure,
          ),
        );
      }, forceExitMs);
      if (params.ownsProcessLifecycle === true) {
        // The process lease already retains unfinished cleanup. A future deadline must
        // not keep a failed-but-settled Gateway alive after that lease is released.
        forceExitTimer.unref();
        hardExitWatchdog = armShutdownHardExitWatchdog({
          delayMs: forceExitMs + HARD_EXIT_WATCHDOG_GRACE_MS,
          onError: (error) => {
            gatewayLog.warn(
              `hard-exit watchdog failed; retaining main-thread shutdown timer: ${formatErrorMessage(error)}`,
            );
          },
        });
      }
    };
    const clearForceExitTimer = () => {
      clearTimeout(forceExitTimer ?? undefined);
      forceExitTimer = null;
      shutdownDeadline = undefined;
      cleanup.retireWatchdog(hardExitWatchdog);
      hardExitWatchdog = null;
    };
    // Deadline paths keep their safety net until final settlement proves that
    // the late server handle and all retained shutdown work actually stopped.
    requestWatchdogs.add(clearForceExitTimer);
    if (action === "restart") {
      forceActiveRestartExit = () => {
        clearForceExitTimer();
        if (!getManagedUpdateOwner() && !updateSuccessor.waitingForStop) {
          armForceExitTimer(budget.timeoutMs);
        }
      };
    }

    const shutdownOperation = (async () => {
      if (process.platform === "linux" || process.platform === "darwin") {
        if (budget.nativeStopBudget && !getManagedUpdateOwner()) {
          armForceExitTimer(budget.timeoutMs);
        }
        budget = await resolveGatewayShutdownBudget(supervisorMode, gatewayLog, {
          previous: startupBudget,
          acceptedAtMs: acceptedRequest.acceptedAtMs,
        });
        if (forcedExitStarted) {
          return;
        }
        reportedBudget = budget;
        clearForceExitTimer();
      }
      budget.log("shutdown");
      let managedUpdateOwner: GatewayRestartIntent["successorOwner"];
      let managedUpdateCancellation:
        | false
        | "restored-in-process"
        | "restart-after-exit"
        | undefined;
      const drainBudget = resolveGatewayShutdownDrainBudget({
        budget,
        action,
        forceRestart: restartIntent?.force === true,
        restartWithoutSupervisor,
        acceptedAtMs: acceptedRequest.acceptedAtMs,
        requestedRestartDrainTimeoutMs: isRestart
          ? eagerLifecycleRuntime.resolveGatewayRestartDrainTimeoutMs(restartIntent)
          : 0,
      });
      // Managed helpers must reach native parking before either exit watchdog can arm.
      if (drainBudget.forceExitMs !== undefined && (!isRestart || !getManagedUpdateOwner())) {
        armForceExitTimer(drainBudget.forceExitMs);
      }
      let shutdownStep = "restart-failure-recovery";
      let startupFailure: { error: unknown } | undefined;
      try {
        // A stop/restart cancels triage at admission and joins its existing cleanup
        // before process exit can strand an external fixing agent.
        await restartRecovery.waitForCleanup();
        shutdownStep = "active-work-drain";
        await drainGatewayActiveWork({
          request: acceptedRequest,
          runtime: eagerLifecycleRuntime,
          drainTimeoutMs: drainBudget.drainTimeoutMs,
          restartDrainDeadlineAt: drainBudget.restartDrainDeadlineAt,
          recordCounts: (counts) => {
            lastDrainCounts = counts;
          },
          recordWarning: (warning) => {
            restartDrainWarning = warning;
          },
          logger: gatewayLog,
        });

        if (isRestart && activeRestartRequest?.restartIntent?.successorOwner) {
          const owner = activeRestartRequest.restartIntent.successorOwner;
          managedUpdateOwner = owner;
          try {
            if (
              !sameManagedUpdateOwner(getManagedUpdateOwner(), owner) ||
              !(await eagerLifecycleRuntime.requestManagedServiceUpdateHandoffPark(owner)) ||
              !sameManagedUpdateOwner(getManagedUpdateOwner(), owner) ||
              !eagerLifecycleRuntime.claimManagedServiceUpdateHandoff(owner)
            ) {
              throw new Error("managed update helper lost exact ownership during service parking");
            }
          } catch (err) {
            clearForceExitTimer();
            gatewayLog.error(
              `managed update handoff could not park ${supervisorMode}: ${String(err)}`,
            );
            await markRestartHandoffUnavailable();
            managedUpdateCancellation = await updateSuccessor.cancelHandoff(
              getManagedUpdateOwner,
              owner,
            );
            if (!managedUpdateCancellation) {
              return;
            }
            if (managedUpdateCancellation === "restart-after-exit") {
              await releaseLockIfHeld();
              await finishLoopAfterCleanup(0, owner, "restore");
              return;
            }
          }
        }

        if (isRestart && !forceExitTimer) {
          armForceExitTimer(drainBudget.restartTimeoutMs());
        }
        if (acceptedRequest.action === "stop") {
          shutdownStep = "startup-operations";
          try {
            await acceptedStartupOperations.drain();
          } catch (error) {
            startupFailure = { error };
          }
          // Preflight cancellation does not cover the whole start operation. Its
          // successful late handle is published before this join can complete.
          await startupWork?.catch(() => {});
        }
        shutdownStep = "restart-signal-settlement";
        await signals.settle();
        shutdownStep = "gateway-server-close";
        // Natural exit must retire native watchers, not detach them for a forced exit.
        // This retains the synchronous macOS watcher-close cost until native retirement improves.
        await runWithProcessCleanupBudget(
          budget.cleanupBudget(shutdownDeadline, HARD_EXIT_WATCHDOG_GRACE_MS),
          () =>
            server?.close({
              reason: isRestart ? "gateway restarting" : "gateway stopping",
              restartExpectedMs: isRestart ? 1500 : null,
              ...(isRestart ? { drainTimeoutMs: drainBudget.closeDrainTimeoutMs() } : {}),
            }),
        );
        if (startupFailure) {
          shutdownStep = "startup-operations";
          throw startupFailure.error;
        }
      } catch (err) {
        const error =
          startupFailure && startupFailure.error !== err
            ? new AggregateError(
                [startupFailure.error, err],
                "Gateway startup and close cleanup failed",
              )
            : err;
        shutdownFailure = { step: shutdownStep, error };
        cleanup.markFailed();
        gatewayLog.error(
          `shutdown step failed (${shutdownStep.replaceAll("-", " ")}): ${formatErrorMessage(error)}`,
        );
      } finally {
        signals.openStore();
        const handoffClosed =
          managedUpdateCancellation !== false && managedUpdateCancellation !== "restart-after-exit";
        if (handoffClosed) {
          server = null;
        }
        if (forcedExitStarted) {
          // A deadline records failure, not permission to abandon cleanup that later settles.
          // Do not overwrite its boot outcome or start a successor from the old generation.
          await cleanup.drainProcessResources();
        } else if (action === "restart") {
          if (!acceptedRequest.hostedStop) {
            await hostLifecycle?.retire();
          }
          if (shutdownFailure) {
            if (installationReplacement && supervisorMode && !getManagedUpdateOwner()) {
              writeStabilityBundle(
                "gateway.restart_close_failed",
                shutdownFailure.error,
                shutdownFailure.step,
              );
              await handleRestartAfterServerClose(undefined, false, shutdownFailure);
            } else {
              await forceExitAfterStabilityBundle(
                "gateway.restart_close_failed",
                1,
                shutdownFailure,
              );
            }
          } else if (handoffClosed) {
            await handleRestartAfterServerClose(
              managedUpdateOwner,
              managedUpdateCancellation === "restored-in-process",
            );
          }
        } else if (acceptedRequest.hostedStop) {
          await handleHostedStopAfterServerClose(acceptedRequest.hostedStop, shutdownFailure);
        } else {
          await hostLifecycle?.retire();
          if (isRestart && shutdownFailure) {
            await forceExitAfterStabilityBundle("gateway.restart_close_failed", 1, shutdownFailure);
          } else {
            if (shutdownFailure) {
              writeStabilityBundle(
                "gateway.stop_close_failed",
                shutdownFailure.error,
                shutdownFailure.step,
              );
            }
            completeBoot(
              loopCompletion.formatShutdownCompletion(acceptedRequest, Boolean(shutdownFailure)),
            );
            await releaseLockIfHeld();
            await finishLoopAfterCleanup(shutdownFailure ? 1 : 0);
          }
        }
        // Keep deadlines through final cleanup and updater handoff, not merely
        // server close. The next iteration also joins native watchdog retirement.
        if (!forcedExitStarted) {
          clearForceExitTimer();
          requestWatchdogs.delete(clearForceExitTimer);
        }
      }
    })().finally(() => {
      // A settled restart cannot transfer its deadlines to a later request.
      if (action === "restart") {
        forceActiveRestartExit = null;
      }
    });
    const completion = restartRuntime.settle(shutdownOperation, preparedRuntime);
    cleanup.retain(completion);
    if (acceptedRequest.action === "stop") {
      acceptedStartupOperations.retainStopCompletion(completion);
    }
  };
  const flushPendingStartupRequest = (opts: { allowMissingServer?: boolean } = {}) => {
    if (!pendingStartupRequest || !restartResolver) {
      return;
    }
    if (!server && opts.allowMissingServer !== true) {
      return;
    }
    const request = pendingStartupRequest;
    pendingStartupRequest = null;
    startupWatchdog.clear();
    startupFailedWithoutServerHandle = false;
    runAcceptedRequest(request);
  };
  const request = (
    action: GatewayRunSignalAction,
    signal: GatewayRunSignalRequest["signal"],
    restartReason?: string,
    restartIntent?: GatewayRestartIntent,
    hostedStop?: ReturnType<typeof createGatewayHostLifecycle>,
    signalContext?: GatewayRunSignalContext,
  ) => {
    if (terminalExitCode !== undefined || (hostExitRequested && action !== "stop")) {
      return;
    }
    if (
      updateSuccessor.handleSignal(
        { action, signal, restartIntent },
        foregroundUpdateClosed || (pendingStartupRequest ?? activeRestartRequest)?.foregroundUpdate,
        {
          beforeWait: () => {
            const drainReason = `stop (${signal})` as const;
            eagerLifecycleRuntime.markGatewayDraining(drainReason);
            startupWatchdog.clear();
            forceActiveRestartExit?.();
          },
          onPark: (successorOwner) =>
            request("restart", signal, "update.run", { successorOwner }, hostedStop),
          onSettled: () => request("stop", signal, undefined, undefined, hostedStop),
        },
      ) ||
      foregroundUpdateClosed
    ) {
      return;
    }
    const acceptedRequest: GatewayRunSignalRequest = {
      acceptedAtMs: signalContext?.acceptedAtMs ?? performance.now(),
      action,
      signal,
      restartReason,
      restartIntent,
      foregroundUpdate:
        action === "restart" &&
        restartIntent?.successorOwner !== undefined &&
        eagerLifecycleRuntime.isForegroundUpdateHandoff(restartIntent.successorOwner),
      hostedStop,
    };
    restartRecovery.abort();
    if (shuttingDown) {
      const currentRestartRequest = pendingStartupRequest ?? activeRestartRequest;
      const upgradedRequest = resolveGatewayRunSignalRequestUpgrade(
        currentRestartRequest,
        acceptedRequest,
      );
      if (upgradedRequest) {
        if (pendingStartupRequest) {
          pendingStartupRequest = upgradedRequest;
        } else {
          activeRestartRequest = upgradedRequest;
          forceActiveRestartExit?.();
        }
        gatewayLog.info(`received ${signal} during shutdown; upgrading to ${restartReason}`);
        return;
      }
      if (action === "stop" && pendingStartupRequest && !server) {
        gatewayLog.info(`received ${signal}; overriding pending startup restart with shutdown`);
        pendingStartupRequest = null;
        startupWatchdog.clear();
        startupFailedWithoutServerHandle = false;
        const drainReason = loopCompletion.formatShutdownReason(acceptedRequest);
        eagerLifecycleRuntime.markGatewayDraining(drainReason);
        runAcceptedRequest(acceptedRequest);
        return;
      }
      gatewayLog.info(
        `received ${signal} during shutdown; ${hostExitRequested ? "finishing shutdown without restart" : "ignoring"}`,
      );
      return;
    }
    if (action === "stop" && signal === "SIGTERM") {
      // Transfer the exact one-shot authority before host retirement and the
      // one-way fence discard it; neither operation may precede consumption.
      const handoff =
        signalContext?.suspendHandoff ??
        consumeGatewaySuspendHandoff(hostLifecycle?.capability.externalRestart);
      if (!handoff.ok) {
        gatewayLog.warn(`external restart handoff refused: ${handoff.error}`);
      } else if (handoff.value) {
        acceptedRequest.action = "external-restart";
        acceptedRequest.restartIntent = { force: true };
      }
    }
    const isRestart = acceptedRequest.action !== "stop";
    if (hostLifecycle !== hostedStop) {
      const retirement = hostLifecycle?.retire();
      if (retirement) {
        cleanup.retain(retirement);
      }
    }
    // A restart captured during reset waits for the next close handle. Its fresh
    // startup drain signal stays usable until drainGatewayActiveWork commits it.
    const drainReason = loopCompletion.formatShutdownReason(acceptedRequest);
    if (action !== "restart" || !signalContext?.deferRestartDrain || (server && restartResolver)) {
      eagerLifecycleRuntime.markGatewayDraining(drainReason);
    }
    shuttingDown = true;
    gatewayLog.info(`received ${signal}; ${isRestart ? "restarting" : "shutting down"}`);
    if (isRestart) {
      restartTrace.startGatewayRestartTrace("restart.signal.received", [
        ["signal", signal],
        ["reason", restartReason ?? signal],
        ["force", acceptedRequest.restartIntent?.force === true],
        ["waitMs", restartIntent?.waitMs ?? "default"],
      ]);
    }
    if (action === "stop") {
      runAcceptedRequest(acceptedRequest);
      return;
    }
    if (!server && restartResolver && startupFailedWithoutServerHandle) {
      startupFailedWithoutServerHandle = false;
      runAcceptedRequest(acceptedRequest);
      return;
    }
    if (!server || !restartResolver) {
      pendingStartupRequest = acceptedRequest;
      startupWatchdog.arm(acceptedRequest);
      return;
    }
    runAcceptedRequest(acceptedRequest);
  };

  const signals = createGatewayRunSignals({
    lifecycle: eagerLifecycleRuntime,
    logger: gatewayLog,
    timeoutMs: startupBudget.timeoutMs,
    getIteration: () => startupOperations,
    isTerminal: () => terminalExitCode !== undefined,
    isForcedExitStarted: () => forcedExitStarted,
    isForegroundUpdateClosed: () => foregroundUpdateClosed,
    isRuntimeResetPending: () => runtimeResetPending,
    isShuttingDown: () => shuttingDown,
    getExternalRestartOwner: () => hostLifecycle?.capability.externalRestart,
    getTerminalHostedStop: () =>
      terminalHostedStop === hostLifecycle ? terminalHostedStop : undefined,
    updateSuccessor,
    forceExit: (reason) => cleanup.retain(forceExitAfterStabilityBundle(reason)),
    request,
  });
  const releaseInstallationObserver = registerGatewayRunInstallationReplacement({
    waitForUpdates: eagerLifecycleRuntime.waitForSystemServiceUpdateHandoffs,
    logger: gatewayLog,
    supervised: Boolean(supervisorMode),
    accept: (fact) => {
      installationReplacement = fact;
      request("restart", "SIGUSR2", fact.reason);
    },
  });
  let loopFailure: { error: unknown } | undefined;
  try {
    if (params.ownsProcessLifecycle) {
      releaseOutputOwner = registerSignalExitOwner((code) => {
        if (Number(code) !== 0 && hostExitCode === 0) {
          hostExitCode = Number(code);
        }
        hostExitRequested = true;
        request("stop", "host lifeline closed");
      });
    }
    releaseHostLifeline = installGatewayHostLifeline(() => {
      hostExitRequested = true;
      request("stop", "host lifeline closed");
    });
    let isFirstIteration = true;
    let retryAfterTriage = false;
    for (;;) {
      if (terminalExitCode !== undefined) {
        break;
      }
      const isTriageRetry = retryAfterTriage;
      retryAfterTriage = false;
      const iterationStartupOperations = isFirstIteration
        ? startupOperations
        : createGatewayStartupOperations();
      startupOperations = iterationStartupOperations;
      runtimeResetPending = !isFirstIteration;
      await hostLifecycle?.retire();
      if (terminalExitCode !== undefined) {
        break;
      }
      const iterationHost = createGatewayHostLifecycle({
        processOwner: {
          ownsProcessLifecycle: params.ownsProcessLifecycle === true,
          supervisor: supervisorMode,
        },
        isCurrent: () => hostLifecycle === iterationHost,
        isServing: () => server !== null && restartResolver !== null && !shuttingDown,
        getShutdownBudget: () => (shuttingDown ? reportedBudget : startupBudget),
        acceptStop: () =>
          request("stop", "hosted Gateway stop", undefined, undefined, iterationHost),
        commitExternalStop: () => request("stop", "SIGTERM"),
      });
      hostLifecycle = iterationHost;
      let startupFailedBeforeServerHandle = false;
      const isRestartIteration = !isFirstIteration;
      isFirstIteration = false;
      try {
        cleanup.beginIteration();
        if (isRestartIteration) {
          startupWork = prepareGatewayRestartIteration(
            eagerLifecycleRuntime,
            gatewayLog,
            () => terminalExitCode === undefined,
          );
          await startupWork;
          startupWork = undefined;
          if (terminalExitCode !== undefined) {
            break;
          }
        }
        runtimeResetPending = false;
        signals.openStore();
        if (installationReplacement) {
          await exitReplacedInstallation(installationReplacement);
          break;
        }
        if (pendingRestartCompletion) {
          completeBoot(pendingRestartCompletion);
        }
        if (iterationStartupOperations.getStopCompletion()) {
          await iterationStartupOperations.getStopCompletion();
          break;
        }
        startupStartedAt = Date.now();
        startupWork = measureGatewayBootstrapStep("cli.bootstrap.boot-lifecycle", () =>
          params.beginBoot?.(startupStartedAt),
        );
        await startupWork;
        startupWork = undefined;
        if (terminalExitCode !== undefined) {
          break;
        }
        if (installationReplacement) {
          await exitReplacedInstallation(installationReplacement);
          break;
        }
        if (iterationStartupOperations.getStopCompletion()) {
          await iterationStartupOperations.getStopCompletion();
          break;
        }
        const starting = params
          .start({
            ...(isRestartIteration ? {} : { processStartedAt: performance.timeOrigin }),
            startupStartedAt,
            requestHotReloadRecovery:
              eagerLifecycleRuntime.requestGatewayRestartWithSignalAdmission,
            hostLifecycle: iterationHost.capability,
            startupOperation: iterationStartupOperations.run,
            gatewayStateOwner: lock ?? undefined,
          })
          .then((startedServer) => {
            server = startedServer;
            return startedServer;
          });
        startupWork = starting;
        const startedServer = await starting;
        server = startedServer;
        startupWork = undefined;
        iterationStartupOperations.close();
        startupFailedWithoutServerHandle = false;
        if (terminalExitCode !== undefined) {
          // Final settlement owns a late handle when no accepted Stop already does.
          break;
        }
        await new Promise<void>((resolve, reject) => {
          restartResolver = () => {
            restartResolver = null;
            resolve();
          };
          void startedServer.startupSettled.then(undefined, reject);
          flushPendingStartupRequest();
        });
      } catch (err) {
        runtimeResetPending = false;
        startupWork = undefined;
        iterationStartupOperations.close();
        signals.openStore();
        if (
          iterationStartupOperations.getStopCompletion() &&
          (iterationStartupOperations.cancelledWith(err) ||
            iterationStartupOperations.failedWith(err))
        ) {
          await iterationStartupOperations.getStopCompletion();
          if (iterationStartupOperations.cancelledWith(err)) {
            break;
          }
          throw err;
        }
        await iterationHost.retire();
        const failedServer = server;
        server = null;
        const maintenanceRequired = findStartupMaintenanceRequiredError(err);
        completeBoot(loopCompletion.formatStartupFailureCompletion(err, maintenanceRequired?.code));
        try {
          await signals.settle();
          await failedServer?.close({ reason: "gateway startup failed" });
        } catch (closeError) {
          throw new GatewayStartupCleanupError(err, closeError);
        } finally {
          signals.openStore();
        }
        // The startup owner uses this error only when native retirement is unconfirmed.
        // Keep its dependencies retained, including when the installation was replaced.
        if (
          collectNestedErrorCandidates(err).some(
            (error) => error instanceof GatewayStartupCleanupError,
          )
        ) {
          throw err;
        }
        if (installationReplacement) {
          await exitReplacedInstallation(installationReplacement);
          break;
        }
        // Keep TCC recovery after clean restart failures (#35862), but never reuse a
        // generation whose startup cleanup failed. The outer CLI exits nonzero.
        if (
          terminalExitCode !== undefined ||
          maintenanceRequired ||
          !isRestartIteration ||
          (isTriageRetry && supervisorMode)
        ) {
          await cleanup.waitForCleanup();
          if (!cleanup.failed && !cleanup.drained) {
            try {
              try {
                await iterationStartupOperations.drain();
              } catch (startupError) {
                // The admission scope remembers the original refusal as well as joining work.
                if (startupError !== err) {
                  throw startupError;
                }
              }
              // A clean kernel rollback does not own process-wide providers or snapshots.
              await cleanup.drainProcessResources();
            } catch (cleanupError) {
              throw new GatewayStartupCleanupError(err, cleanupError);
            }
          }
          throw err;
        }
        startupFailedWithoutServerHandle = true;
        startupFailedBeforeServerHandle = true;
        if (!pendingStartupRequest) {
          // A failed listener must release its lock for daemon restart/stop (#35862).
          await releaseLockIfHeld();
        }
        writeStabilityBundle("gateway.restart_startup_failed", err);
        restartRecovery.reportStartupFailure(err, isTriageRetry);
        if (!shuttingDown && !isTriageRetry) {
          retryAfterTriage = (await restartRecovery.attempt(err)) && !shuttingDown;
        }
        if (!retryAfterTriage && !shuttingDown) {
          restartRecovery.reportManualRecovery();
        }
      }
      if (startupFailedBeforeServerHandle && terminalExitCode === undefined) {
        await new Promise<void>((resolve) => {
          restartResolver = () => {
            restartResolver = null;
            resolve();
          };
          flushPendingStartupRequest({ allowMissingServer: true });
          if (retryAfterTriage && !shuttingDown) {
            request("restart", "SIGUSR2", "gateway.triage_completed");
          }
        });
      }
      await cleanup.waitForCleanup();
      if (cleanup.failed) {
        finishLoop(1);
      }
    }
  } catch (error) {
    loopFailure = { error };
  }
  const failures = await cleanup.settleFinalResources({
    retireSignals: () => signals.retire(),
    drainSignals: () => signals.drain(),
    releaseRestartRuntime: () => restartRuntime.release(),
    closeTerminalServer: async () => {
      if (server) {
        await server.close({ reason: "gateway stopping" });
        server = null;
        await cleanup.drainProcessResources();
      }
    },
    retireHost: () => hostLifecycle?.retire(),
    releaseLock: releaseLockIfHeld,
    clearStartupWatchdog: startupWatchdog.clear,
    clearRequestWatchdogs: () => {
      for (const clear of requestWatchdogs) {
        clear();
      }
      requestWatchdogs.clear();
    },
    cleanupSignals,
    onSettled: params.onProcessResourcesSettled,
  });
  if (loopFailure) {
    failures.unshift(loopFailure.error);
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Gateway loop and final resource cleanup failed", {
      cause: failures[0],
    });
  }
  const code = hostExitRequested && terminalExitCode === 0 ? hostExitCode : (terminalExitCode ?? 0);
  // Cleanup failure promotes success, but cannot replace a supervisor-owned
  // failure status that already selects its terminal recovery behavior.
  return cleanup.failed && code === 0 ? 1 : code;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
