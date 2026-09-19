// In-process gateway run loop, restart signaling, drain, and update respawn handling.
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { MessageChannel } from "node:worker_threads";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  captureGatewayRestartTraceHandoff,
  createGatewayRestartTraceHandoffEnv,
  measureGatewayRestartTrace,
  markGatewayRestartTrace,
  startGatewayRestartTrace,
} from "../../gateway/restart-trace.js";
import type { GatewayHostLifecycle, GatewayStartupOperation } from "../../gateway/server-public.js";
import { GatewayStartupCleanupError } from "../../gateway/server-shutdown.js";
import type { startGatewayServer } from "../../gateway/server.js";
import {
  registerGatewayInstallationReplacementHandler,
  type GatewayInstallationReplacement,
} from "../../gateway/stale-install.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  GATEWAY_BOOT_REASON_MAX_UTF16_CODE_UNITS,
  type GatewayBootLifecycleCompletion,
} from "../../infra/gateway-boot-lifecycle.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import { GATEWAY_SHUTDOWN_TIMEOUT_MS as SHUTDOWN_TIMEOUT_MS } from "../../infra/gateway-shutdown-budget.js";
import { consumeGatewaySuspendHandoff } from "../../infra/gateway-suspend-coordinator.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import type { GatewayRestartEmitter } from "../../infra/restart.js";
import { cleanupSnapshotOperations } from "../../infra/sqlite-readonly-location-cleanup.js";
import { findStartupMaintenanceRequiredError } from "../../infra/startup-maintenance-required.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  type GatewayDrainReason,
  runOutsideGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { runWithProcessCleanupBudget } from "../../process/supervisor/cleanup-budget.js";
import type { RuntimeEnv } from "../../runtime.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { formatCliCommand } from "../command-format.js";
import { createGatewayHostLifecycle } from "./host-lifecycle.js";
import * as loopLogs from "./run-loop-log-flush.js";
import {
  isUpdateProcessRestartReason,
  sameManagedUpdateOwner,
  type GatewayRunSignalAction,
  type GatewayRunSignalRequest,
} from "./run-loop-request.js";
import { resolveGatewayShutdownBudget } from "./run-loop-shutdown-budget.js";
import { formatDrainCounts, formatShutdownReason } from "./run-loop-shutdown-format.js";
import {
  createGatewayStartupOperations,
  prepareGatewayRestartIteration,
} from "./run-loop-startup.js";
import {
  armShutdownHardExitWatchdog,
  type ShutdownHardExitWatchdog,
} from "./shutdown-hard-exit.js";
const gatewayLog = createSubsystemLogger("gateway");
const LAUNCHD_SUPERVISED_RESTART_EXIT_DELAY_MS = 1500;
const DEFAULT_RESTART_DRAIN_TIMEOUT_MS = 300_000;
const HARD_EXIT_WATCHDOG_GRACE_MS = 2_000;

type ShutdownFailure = { step: string; error: unknown };

const gatewayLifecycleRuntimeLoader = createLazyImportLoader(
  () => import("./lifecycle.runtime.js"),
);

export async function runGatewayLoop(params: {
  start: (params?: {
    processStartedAt?: number;
    startupStartedAt?: number;
    requestHotReloadRecovery?: GatewayRestartEmitter;
    hostLifecycle?: GatewayHostLifecycle;
    startupOperation?: GatewayStartupOperation;
  }) => Promise<Awaited<ReturnType<typeof startGatewayServer>>>;
  runtime: RuntimeEnv;
  /** Grants this run loop authority over the process it exclusively owns. */
  ownsProcessLifecycle?: boolean;
  lockPort?: number;
  lifecycleLockDeadlineMs?: number;
  healthHost?: string;
  beginBoot?: (startedAtMs: number) => void | Promise<void>;
  completeBoot?: (completion: GatewayBootLifecycleCompletion) => void;
  onRestartStartupFailure?: (error: unknown, signal: AbortSignal) => Promise<void>;
}) {
  // macOS/BSD process inspection reports process.title instead of the original
  // argv. Give the long-running Gateway a verifiable identity for lock readers.
  if (process.title === "openclaw") {
    process.title = "openclaw-gateway";
  }
  let startupStartedAt: number;
  const processStartedAt = performance.timeOrigin;
  // Eagerly resolve the lifecycle runtime module before installing signal
  // listeners. Without this, every subsequent lifecycle path (SIGUSR1,
  // SIGTERM-with-intent, restart iteration hook, stability bundle writer)
  // depends on a dynamic import() call. After an in-place package upgrade
  // (e.g. `npm install -g openclaw@latest` triggered via update.run),
  // dist/ chunk hashes rotate while the process is still running. The next
  // SIGUSR1 — including the one update.run schedules for itself — would
  // hit ERR_MODULE_NOT_FOUND from inside its async IIFE, reject silently,
  // and leave restart.ts's emittedRestartToken permanently unconsumed.
  // From that point every scheduleGatewaySigusr1Restart() returns
  // { coalesced: true } and the gateway never restarts. Priming the loader
  // here pulls the lifecycle re-export graph into memory, immune to later disk
  // rotation.
  const eagerLifecycleRuntime = await gatewayLifecycleRuntimeLoader.load();
  const supervisor = eagerLifecycleRuntime.detectGatewayRespawnSupervisorIdentity(
    process.env,
    process.platform,
    { includeLinuxOpenClawGatewayServiceMarker: true },
  );
  const supervisorMode = supervisor?.kind ?? null;
  let lock = await acquireGatewayLock({
    port: params.lockPort,
    listenerMode: supervisorMode ? "supervised" : "foreground",
    supervisor,
    ...(params.lifecycleLockDeadlineMs !== undefined
      ? { lifecycleDeadlineMs: params.lifecycleLockDeadlineMs }
      : {}),
  });
  // Process-owned signal handling must survive gaps with no listening server.
  // Node's signal listeners and pending promises do not retain the event loop.
  const processLifetime = params.ownsProcessLifecycle ? new MessageChannel() : undefined;
  processLifetime?.port1.ref();
  let server: Awaited<ReturnType<typeof startGatewayServer>> | null = null;
  let hostLifecycle: ReturnType<typeof createGatewayHostLifecycle> | undefined;
  let startupOperations = createGatewayStartupOperations();
  let terminalHostedStop: ReturnType<typeof createGatewayHostLifecycle> | undefined;
  let shuttingDown = false;
  let forcedExitStarted = false;
  let restartResolver: (() => void) | null = null;
  // The HTTP server can report ready before params.start returns its close handle.
  // Defer lifecycle signals from that window until the loop can close and advance.
  let pendingStartupRequest: GatewayRunSignalRequest | null = null;
  let activeRestartRequest: GatewayRunSignalRequest | null = null;
  let committedGenericSuccessor: ChildProcess | true | null = null;
  let forceActiveRestartExit: (() => void) | null = null;
  let pendingStartupForceExitTimer: ReturnType<typeof setTimeout> | null = null;
  let installationReplacement: GatewayInstallationReplacement | undefined;
  let pendingRestartCompletion: GatewayBootLifecycleCompletion | undefined;
  const completeBoot = (completion: GatewayBootLifecycleCompletion) => {
    pendingRestartCompletion = undefined;
    params.completeBoot?.({
      ...completion,
      ...(installationReplacement
        ? {
            reason: truncateUtf16Safe(
              `${installationReplacement.reason}; ${completion.reason ?? completion.outcome}`,
              GATEWAY_BOOT_REASON_MAX_UTF16_CODE_UNITS,
            ),
          }
        : {}),
    });
  };
  let restartDrainingMarked = false;
  const observeSignal = loopLogs.createGatewaySignalObserver(gatewayLog);
  let startupFailedWithoutServerHandle = false;
  let failureWork: { controller: AbortController; settled: Promise<void> } | undefined;
  const processInstanceId = randomUUID();
  const getManagedUpdateOwner = () =>
    (pendingStartupRequest ?? activeRestartRequest)?.restartIntent?.successorOwner;

  const cleanupSignals = () => {
    releaseInstallationObserver();
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGUSR1", onSigusr1);
    processLifetime?.port1.close();
    processLifetime?.port2.close();
  };
  const exitProcess = (code: number) => {
    if (pendingRestartCompletion) {
      completeBoot(pendingRestartCompletion);
    }
    clearPendingStartupForceExitTimer();
    void hostLifecycle?.retire();
    cleanupSignals();
    params.runtime.exit(code);
  };
  const exitProcessAfterLogFlush = async (
    code: number,
    initialOwner?: GatewayRestartIntent["successorOwner"],
    initialOutcome: "update" | "restore" = "update",
    hostStopOwner?: ReturnType<typeof createGatewayHostLifecycle>,
  ): Promise<void> => {
    if (hostStopOwner && hostLifecycle !== hostStopOwner) {
      return;
    }
    let ownerToCommit = initialOwner;
    let commitOutcome = initialOutcome;
    // Graceful signal/restart paths call process.exit(), which skips beforeExit.
    await eagerLifecycleRuntime
      .stopGatewayManagedProviderLocalServices()
      .catch((error: unknown) => {
        gatewayLog.warn(`managed local service shutdown failed: ${formatErrorMessage(error)}`);
      });
    await cleanupSnapshotOperations();
    if (hostStopOwner && hostLifecycle !== hostStopOwner) {
      return;
    }
    await loopLogs.flushGatewayLogsBeforeExit(gatewayLog);
    for (;;) {
      if (hostStopOwner && hostLifecycle !== hostStopOwner) {
        return;
      }
      const owner = getManagedUpdateOwner();
      if (!owner) {
        if (!ownerToCommit) {
          exitProcess(code);
        }
        return;
      }
      if (
        sameManagedUpdateOwner(owner, ownerToCommit) &&
        eagerLifecycleRuntime.claimManagedServiceUpdateHandoff(owner) &&
        (await eagerLifecycleRuntime.commitManagedServiceUpdateHandoff(owner, commitOutcome)) &&
        sameManagedUpdateOwner(getManagedUpdateOwner(), owner) &&
        eagerLifecycleRuntime.claimManagedServiceUpdateHandoff(owner)
      ) {
        // Keep exact request ownership live through the synchronous exit call.
        exitProcess(code);
        return;
      }
      await markRestartHandoffUnavailable();
      const ownerToCancel = ownerToCommit ?? owner;
      const restoration = await cancelManagedUpdateHandoffBeforeRecovery(ownerToCancel);
      if (!restoration) {
        const child = committedGenericSuccessor === true ? null : committedGenericSuccessor;
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = new Promise<void>((resolve) => {
            child.once("exit", () => {
              resolve();
            });
          });
          try {
            child.kill("SIGKILL");
            await exited;
          } catch {}
        }
        return;
      }
      if (restoration === "restart-after-exit") {
        ownerToCommit = ownerToCancel;
        commitOutcome = "restore";
        const currentRequest = pendingStartupRequest ?? activeRestartRequest;
        if (
          currentRequest &&
          !sameManagedUpdateOwner(currentRequest.restartIntent?.successorOwner, ownerToCancel)
        ) {
          currentRequest.restartIntent = {
            ...currentRequest.restartIntent,
            successorOwner: ownerToCancel,
          };
        }
        continue;
      }
      // Restoring the helper does not make a failed generation reusable.
      if (code === 0 && !forcedExitStarted && !committedGenericSuccessor && initialOwner) {
        return reacquireAndResumeInProcessRestart(getManagedUpdateOwner() ?? owner);
      }
      exitProcess(code);
      return;
    }
  };
  const writeStabilityBundle = (reason: string, error?: unknown, shutdownStep?: string) => {
    const result = eagerLifecycleRuntime.writeDiagnosticStabilityBundleForFailureSync(
      reason,
      error,
      ...(shutdownStep ? [{ shutdownStep }] : []),
    );
    if ("message" in result) {
      gatewayLog.warn(result.message);
    }
  };
  const releaseLockIfHeld = async (): Promise<void> => {
    await lock?.release();
    lock = null;
  };
  const exitReplacedInstallation = async (replacement: GatewayInstallationReplacement) => {
    gatewayLog.error(
      `${replacement.message} Cannot continue in this process. Run: ${formatCliCommand(supervisorMode ? "openclaw gateway restart" : "openclaw gateway run")}`,
    );
    pendingRestartCompletion ??= {
      outcome: "planned_restart",
      reason: "gateway.installation_replaced",
    };
    await releaseLockIfHeld();
    await exitProcessAfterLogFlush(1);
  };
  const cancelManagedUpdateHandoffBeforeRecovery = async (
    initialOwner = getManagedUpdateOwner(),
  ): Promise<false | "restored-in-process" | "restart-after-exit"> => {
    let owner = initialOwner;
    let requiresParentExit = false;
    try {
      for (;;) {
        if (!owner) {
          return requiresParentExit ? "restart-after-exit" : "restored-in-process";
        }
        const restoration = await eagerLifecycleRuntime.cancelManagedServiceUpdateHandoff(owner);
        if (!restoration) {
          gatewayLog.error("managed update handoff cancellation unconfirmed; remaining draining");
          return false;
        }
        requiresParentExit ||= restoration === "restart-after-exit";
        const replacement = getManagedUpdateOwner();
        if (!replacement || sameManagedUpdateOwner(owner, replacement)) {
          return requiresParentExit ? "restart-after-exit" : "restored-in-process";
        }
        owner = replacement;
      }
    } catch (err) {
      gatewayLog.error(`managed update handoff cancellation failed: ${formatErrorMessage(err)}`);
      return false;
    }
  };
  const forceExitAfterStabilityBundle = async (
    reason: string,
    exitCode = 1,
    failure?: ShutdownFailure,
  ) => {
    if (forcedExitStarted) {
      return;
    }
    forcedExitStarted = true;
    void hostLifecycle?.retire();
    try {
      writeStabilityBundle(reason, failure?.error, failure?.step);
    } finally {
      // Exit rescue cannot replay an issued file append; join it before final authority checks.
      // Reserve half the hard-exit grace for final shutdown bookkeeping.
      await loopLogs.flushGatewayLogsBeforeExit(gatewayLog, HARD_EXIT_WATCHDOG_GRACE_MS / 2);
      const owner = getManagedUpdateOwner();
      if (owner) {
        forceActiveRestartExit?.();
      }
      const restoration = await cancelManagedUpdateHandoffBeforeRecovery(owner);
      if (restoration) {
        completeBoot({ outcome: "forced_stop", reason });
        if (restoration === "restart-after-exit") {
          await exitProcessAfterLogFlush(exitCode, owner, "restore");
        } else {
          exitProcess(exitCode);
        }
      }
    }
  };
  const reacquireAndResumeInProcessRestart = async (
    alreadyCancelledOwner?: GatewayRestartIntent["successorOwner"],
  ): Promise<void> => {
    for (;;) {
      if (forcedExitStarted) {
        return;
      }
      const restartRequest = activeRestartRequest;
      const restartOwner = restartRequest?.restartIntent?.successorOwner;
      const restoration = sameManagedUpdateOwner(restartOwner, alreadyCancelledOwner)
        ? "restored-in-process"
        : await cancelManagedUpdateHandoffBeforeRecovery(restartOwner);
      if (!restoration || forcedExitStarted) {
        return;
      }
      if (restoration === "restart-after-exit") {
        await releaseLockIfHeld();
        return exitProcessAfterLogFlush(0, restartOwner, "restore");
      }
      if (activeRestartRequest !== restartRequest) {
        continue;
      }
      if (installationReplacement) {
        // The old module graph cannot recover after its package has been replaced.
        return exitReplacedInstallation(installationReplacement);
      }
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
        gatewayLog.error(`failed to reacquire gateway lock for in-process restart: ${String(err)}`);
        exitProcess(1);
        return;
      }
      if (installationReplacement) {
        return exitReplacedInstallation(installationReplacement);
      }
      if (!forcedExitStarted && activeRestartRequest === restartRequest) {
        activeRestartRequest = null;
        shuttingDown = false;
        restartResolver?.();
        return;
      }
      await releaseLockIfHeld();
    }
  };
  const markRestartHandoffUnavailable = async (reason = "restart-handoff-unavailable") => {
    await eagerLifecycleRuntime.markUpdateRestartSentinelFailure(reason).catch((err: unknown) => {
      gatewayLog.warn(`failed to mark update restart ${reason}: ${String(err)}`);
    });
  };
  const handleRestartAfterServerClose = async (
    expectedOwner?: GatewayRestartIntent["successorOwner"],
    cancelled = false,
    failure?: ShutdownFailure,
  ): Promise<void> => {
    await releaseLockIfHeld();
    if (forcedExitStarted) {
      return;
    }
    // Lock release may yield while a managed update upgrades this restart.
    const restartReason = activeRestartRequest?.restartReason;
    pendingRestartCompletion = failure
      ? { outcome: "forced_stop", reason: "gateway.restart_close_failed" }
      : {
          outcome: "planned_restart",
          reason: activeRestartRequest
            ? formatShutdownReason(activeRestartRequest)
            : "gateway.restart",
        };
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
      gatewayLog.info("restart mode: managed update handoff owns successor");
      return exitProcessAfterLogFlush(0, expectedOwner);
    }

    const respawnOptions = {
      env: createGatewayRestartTraceHandoffEnv(captureGatewayRestartTraceHandoff()),
    };
    const isStandaloneUpdate = isUpdateRestart && !supervisorMode;
    const respawn = isStandaloneUpdate
      ? eagerLifecycleRuntime.respawnGatewayProcessForUpdate(respawnOptions)
      : eagerLifecycleRuntime.restartGatewayProcessWithFreshPid(respawnOptions);
    if (respawn.mode === "spawned") {
      const observedRestartRequest = activeRestartRequest;
      const updateSentinel = await eagerLifecycleRuntime.readRestartSentinelReadOnly();
      // Old-server cleanup must not consume the replacement's readiness window.
      forceActiveRestartExit?.();
      const health =
        typeof params.lockPort === "number"
          ? await eagerLifecycleRuntime.waitForGatewayHealthyRestart({
              port: params.lockPort,
              child: respawn.child,
              probeHosts: [params.healthHost ?? "127.0.0.1"],
              requireRunningService: true,
              requirePluginHealth: false,
            })
          : undefined;
      if (health?.waitOutcome === "healthy" || health?.waitOutcome === "still-starting") {
        committedGenericSuccessor = respawn.child;
        if (health.waitOutcome === "still-starting") {
          gatewayLog.warn(
            "update respawn is still starting; leaving the replacement process running",
          );
          if (
            updateSentinel?.payload.kind === "update" &&
            updateSentinel.payload.status !== "error"
          ) {
            await eagerLifecycleRuntime
              .writeRestartSentinelIfUnchanged({
                payload: {
                  ...updateSentinel.payload,
                  status: "skipped",
                  continuation: null,
                  stats: { ...updateSentinel.payload.stats, reason: "still-starting" },
                },
                expectedRevision: updateSentinel.revision,
                isCurrent: () => activeRestartRequest === observedRestartRequest,
              })
              .catch((error: unknown) =>
                gatewayLog.warn(
                  `failed to record pending update readiness: ${formatErrorMessage(error)}`,
                ),
              );
          }
        }
        gatewayLog.info(
          `restart mode: update process respawn (spawned pid ${respawn.pid ?? "unknown"})`,
        );
        return exitProcessAfterLogFlush(0);
      }
      gatewayLog.warn(
        `update respawn child did not become healthy (${respawn.pid ?? "unknown"}); ${installationReplacement ? "the replaced runtime cannot resume" : "falling back to in-process restart"}`,
      );
      try {
        respawn.child.kill();
      } catch {
        // Best-effort; parent fallback keeps the gateway reachable for recovery.
      }
      await markRestartHandoffUnavailable("restart-unhealthy");
      return reacquireAndResumeInProcessRestart();
    }
    if (respawn.mode === "supervised") {
      const restartKind = isUpdateRestart ? "update-process" : "full-process";
      markGatewayRestartTrace("restart.full-process-handoff", [
        ["kind", restartKind],
        ["mode", respawn.mode],
        ["pid", "none"],
        ["supervisorMode", supervisorMode ?? "none"],
      ]);
      const handoff = eagerLifecycleRuntime.writeGatewayRestartHandoffSync({
        restartKind,
        reason: restartReason,
        processInstanceId,
        supervisorMode: supervisorMode ?? "external",
        restartTrace: captureGatewayRestartTraceHandoff(),
      });
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
        const delay = new Promise<void>((resolve) => {
          setTimeout(resolve, LAUNCHD_SUPERVISED_RESTART_EXIT_DELAY_MS);
        });
        const spawned = respawn.handoffSpawned
          ? await Promise.race([respawn.handoffSpawned, delay.then(() => true)])
          : false;
        // Preserve the crash-loop throttle window even when spawn settles early.
        await delay;
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
      committedGenericSuccessor = true;
      return exitProcessAfterLogFlush(respawn.exitCode ?? 0);
    }
    if (respawn.mode === "failed") {
      if (!isStandaloneUpdate) {
        writeStabilityBundle("gateway.restart_respawn_failed");
      }
      gatewayLog.warn(
        `${isStandaloneUpdate ? "update respawn" : "full process restart"} failed (${respawn.detail ?? "unknown error"}); ${installationReplacement ? "the replaced runtime cannot resume" : "falling back to in-process restart"}`,
      );
      if (isUpdateRestart) {
        await markRestartHandoffUnavailable("restart-unhealthy");
      }
    } else {
      gatewayLog.info(
        `restart mode: ${installationReplacement ? "replaced runtime must exit" : "in-process restart"} (${respawn.detail ?? "OPENCLAW_NO_RESPAWN"})`,
      );
    }
    if (!isUpdateRestart && isUpdateProcessRestartReason(activeRestartRequest?.restartReason)) {
      return handleRestartAfterServerClose();
    }
    return reacquireAndResumeInProcessRestart();
  };
  const {
    nativeStopBudget,
    timeoutMs: acceptedShutdownTimeoutMs,
    reserveMs: RESTART_CLOSE_REPLY_DRAIN_SHUTDOWN_RESERVE_MS,
    cleanupDeadline,
    log: logShutdownBudget,
  } = await resolveGatewayShutdownBudget(supervisorMode, gatewayLog);
  logShutdownBudget("startup");
  const clearPendingStartupForceExitTimer = () => {
    clearTimeout(pendingStartupForceExitTimer ?? undefined);
    pendingStartupForceExitTimer = null;
  };
  const armPendingStartupForceExitTimer = () => {
    if (pendingStartupForceExitTimer) {
      return;
    }
    pendingStartupForceExitTimer = setTimeout(() => {
      pendingStartupForceExitTimer = null;
      gatewayLog.error(
        "startup restart request timed out before gateway returned a close handle; exiting for supervisor recovery",
      );
      void forceExitAfterStabilityBundle("gateway.restart_startup_request_timeout");
    }, acceptedShutdownTimeoutMs);
    pendingStartupForceExitTimer.unref?.();
  };
  const resolveRestartDrainTimeoutMs = (
    restartIntent?: GatewayRestartIntent,
  ): number | undefined => {
    if (restartIntent?.force) {
      return 0;
    }
    if (typeof restartIntent?.waitMs === "number" && Number.isFinite(restartIntent.waitMs)) {
      return restartIntent.waitMs > 0 ? Math.floor(restartIntent.waitMs) : undefined;
    }
    try {
      return eagerLifecycleRuntime.resolveGatewayRestartDeferralTimeoutMs();
    } catch {
      return DEFAULT_RESTART_DRAIN_TIMEOUT_MS;
    }
  };
  const markRestartDraining = (reason: GatewayDrainReason) => {
    if (restartDrainingMarked) {
      return;
    }
    // The lifecycle module is primed before listeners are installed. Keep this
    // transition synchronous so an accepted signal cannot yield between token
    // handling and closing process-wide root admission.
    eagerLifecycleRuntime.markGatewayDraining(reason);
    restartDrainingMarked = true;
  };

  const handleHostedStopAfterServerClose = async (
    owner: ReturnType<typeof createGatewayHostLifecycle>,
    shutdownFailure: ShutdownFailure | undefined,
  ) => {
    if (hostLifecycle !== owner) {
      return;
    }
    terminalHostedStop = owner;
    try {
      if (shutdownFailure) {
        await forceExitAfterStabilityBundle("gateway.stop_close_failed", 1, shutdownFailure);
        return;
      }
      // This continuation belongs to the run loop, not to the closed kernel or
      // requesting lane. Native stop starts only after the existing joins.
      const result = await owner.finishStop();
      if (result.outcome === "retired" || hostLifecycle !== owner) {
        return;
      }
      if (result.outcome !== "accepted" && result.outcome !== "exit") {
        gatewayLog.error(`Scheduled Gateway stop failed: ${result.detail}`);
        if (result.outcome === "refused") {
          pendingRestartCompletion = { outcome: "planned_restart", reason: "gateway.stop_refused" };
          await releaseLockIfHeld();
          if (hostLifecycle === owner) {
            await reacquireAndResumeInProcessRestart();
          }
        } else {
          await forceExitAfterStabilityBundle("gateway.stop_native_unconfirmed");
        }
        return;
      }
      gatewayLog.info(
        result.outcome === "accepted"
          ? "Native service manager accepted Gateway stop"
          : "Gateway host completed graceful stop",
      );
      completeBoot({ outcome: "clean_stop", reason: "stop (hosted Gateway stop)" });
      await releaseLockIfHeld();
      await exitProcessAfterLogFlush(0, undefined, "update", owner);
    } catch (error) {
      gatewayLog.error(`Scheduled Gateway stop failed: ${formatErrorMessage(error)}`);
      if (hostLifecycle === owner) {
        await forceExitAfterStabilityBundle("gateway.stop_native_unconfirmed", 1, {
          step: "hosted-gateway-stop",
          error,
        });
      }
    } finally {
      if (terminalHostedStop === owner) {
        terminalHostedStop = undefined;
      }
    }
  };

  const runAcceptedRequest = (acceptedRequest: GatewayRunSignalRequest) => {
    const { action, restartIntent } = acceptedRequest;
    logShutdownBudget("shutdown");
    const isRestart = action !== "stop";
    const acceptedStartupOperations = startupOperations;
    if (acceptedRequest.action === "stop") {
      // A queued restart still needs startup's close handle. Only an effective
      // stop cancels preflight, including a stop overriding that queued restart.
      acceptedStartupOperations.close();
    }
    if (action === "restart") {
      activeRestartRequest = acceptedRequest;
    } else if (!isRestart) {
      startGatewayRestartTrace("stop.signal.received", [["signal", acceptedRequest.signal]]);
    }
    let forceExitTimer: ReturnType<typeof setTimeout> | null = null;
    let shutdownDeadline: number | undefined;
    let hardExitWatchdog: ShutdownHardExitWatchdog | null = null;
    let lastDrainCounts = "not observed";
    let shutdownFailure: ShutdownFailure | undefined;
    const armForceExitTimer = (forceExitMs: number) => {
      if (forceExitTimer) {
        return;
      }
      shutdownDeadline = performance.now() + forceExitMs;
      forceExitTimer = setTimeout(() => {
        const cleanExit = nativeStopBudget && !shutdownFailure;
        gatewayLog.warn(
          `shutdown deadline reached; abandoning unfinished cleanup and active work before ${action}; last observed: ${lastDrainCounts}; exiting ${cleanExit ? "cleanly" : "with incomplete cleanup"}`,
        );
        void forceExitAfterStabilityBundle(
          isRestart ? "gateway.restart_shutdown_timeout" : "gateway.stop_shutdown_timeout",
          cleanExit ? 0 : 1,
          shutdownFailure,
        );
      }, forceExitMs);
      if (params.ownsProcessLifecycle === true) {
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
      hardExitWatchdog?.cancel();
      hardExitWatchdog = null;
    };
    if (action === "restart") {
      forceActiveRestartExit = () => {
        clearForceExitTimer();
        if (!getManagedUpdateOwner()) {
          armForceExitTimer(acceptedShutdownTimeoutMs);
        }
      };
    }

    const completion = (async () => {
      let managedUpdateOwner: GatewayRestartIntent["successorOwner"];
      let managedUpdateCancellation:
        | false
        | "restored-in-process"
        | "restart-after-exit"
        | undefined;
      const requestedRestartDrainTimeoutMs = isRestart
        ? resolveRestartDrainTimeoutMs(restartIntent)
        : 0;
      const restartDrainTimeoutMs = nativeStopBudget
        ? Math.min(
            requestedRestartDrainTimeoutMs ?? Infinity,
            Math.max(0, acceptedShutdownTimeoutMs - RESTART_CLOSE_REPLY_DRAIN_SHUTDOWN_RESERVE_MS),
          )
        : requestedRestartDrainTimeoutMs;
      const restartDrainDeadlineAt =
        isRestart && restartDrainTimeoutMs !== undefined
          ? Date.now() + restartDrainTimeoutMs
          : undefined;
      // Managed helpers must reach native parking before either exit watchdog can arm.
      if (!isRestart) {
        armForceExitTimer(acceptedShutdownTimeoutMs);
      } else if (restartDrainTimeoutMs !== undefined && !getManagedUpdateOwner()) {
        armForceExitTimer(
          restartDrainTimeoutMs +
            (nativeStopBudget
              ? RESTART_CLOSE_REPLY_DRAIN_SHUTDOWN_RESERVE_MS
              : SHUTDOWN_TIMEOUT_MS),
        );
      }

      const drainTimeoutMs = isRestart
        ? restartDrainTimeoutMs
        : Math.max(0, acceptedShutdownTimeoutMs - RESTART_CLOSE_REPLY_DRAIN_SHUTDOWN_RESERVE_MS);
      const reportDrainSnapshot = loopLogs.createGatewayDrainReporter(
        action,
        drainTimeoutMs,
        eagerLifecycleRuntime,
        gatewayLog,
        (counts) => {
          lastDrainCounts = counts;
        },
      );
      let shutdownStep = "restart-failure-recovery";
      try {
        // A stop/restart cancels triage at admission and joins its existing cleanup
        // before process exit can strand an external fixing agent.
        if (failureWork) {
          await failureWork.settled;
        }
        shutdownStep = "active-work-drain";
        // On restart, wait for the canonical process activity inventory before
        // tearing down the server so active work can settle.
        if (isRestart) {
          let activeWorkAtDrainStart = 0;
          let activeRunsAtDrainStart = 0;
          let drainTimedOut = false;
          await measureGatewayRestartTrace(
            "restart.drain",
            async () => {
              const {
                abortEmbeddedAgentRun,
                createGatewayActiveWorkSnapshot,
                waitForGatewayActiveWork,
              } = await gatewayLifecycleRuntimeLoader.load();
              // Reject new enqueues immediately during the drain window so
              // sessions get an explicit restart error instead of silent task loss.
              markRestartDraining(formatShutdownReason(acceptedRequest));
              const initialSnapshot = createGatewayActiveWorkSnapshot();
              activeWorkAtDrainStart = initialSnapshot.counts.totalActive;
              activeRunsAtDrainStart = initialSnapshot.counts.embeddedRuns;
              if (activeRunsAtDrainStart > 0) {
                abortEmbeddedAgentRun(undefined, { mode: "compacting", reason: "restart" });
              }

              reportDrainSnapshot(initialSnapshot);
              if (restartIntent?.force) {
                gatewayLog.warn("forced restart requested; skipping active work drain");
                return;
              }

              const remainingDrainTimeoutMs =
                restartDrainDeadlineAt === undefined
                  ? undefined
                  : Math.max(0, restartDrainDeadlineAt - Date.now());
              const drain = await waitForGatewayActiveWork(remainingDrainTimeoutMs, {
                onSnapshot: reportDrainSnapshot,
              });
              if (drain.drained) {
                if (!initialSnapshot.idle) {
                  gatewayLog.info("all active work drained");
                }
                return;
              }
              drainTimedOut = true;
              eagerLifecycleRuntime.abortActiveCronTaskRuns("Gateway restarting.");
              gatewayLog.warn(
                `active-work drain timeout reached; proceeding with restart: ${formatDrainCounts(drain.snapshot)}`,
              );
            },
            () => [
              ["activeWork", activeWorkAtDrainStart],
              ["activeRuns", activeRunsAtDrainStart],
              ["timedOut", drainTimedOut],
              ["force", restartIntent?.force === true],
            ],
          );
        } else {
          // Keep all process-owned work alive without spending the shutdown reserve
          // that server teardown and the supervisor watchdog need.
          try {
            markGatewayRestartTrace("stop.drain.begin");
            const activeWorkDrain = await measureGatewayRestartTrace("stop.drain", () =>
              eagerLifecycleRuntime.waitForGatewayActiveWork(drainTimeoutMs, {
                onSnapshot: reportDrainSnapshot,
              }),
            );
            if (!activeWorkDrain.drained) {
              gatewayLog.warn(
                `gateway active-work drain timeout reached; proceeding with shutdown: ${formatDrainCounts(activeWorkDrain.snapshot)}`,
              );
              eagerLifecycleRuntime.abortEmbeddedAgentRun(undefined, { mode: "all" });
              eagerLifecycleRuntime.abortActiveCronTaskRuns("Gateway stopping.");
            }
          } catch (err) {
            gatewayLog.warn(
              `gateway active-work drain failed; proceeding with shutdown: ${formatErrorMessage(err)}`,
            );
          }
          gatewayLog.info("active-work drain settled; beginning server close");
        }

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
            managedUpdateCancellation = await cancelManagedUpdateHandoffBeforeRecovery(owner);
            if (!managedUpdateCancellation) {
              return;
            }
            if (managedUpdateCancellation === "restart-after-exit") {
              await releaseLockIfHeld();
              await exitProcessAfterLogFlush(0, owner, "restore");
              return;
            }
          }
        }

        if (isRestart && !forceExitTimer) {
          armForceExitTimer(
            nativeStopBudget
              ? Math.max(0, (restartDrainDeadlineAt ?? Date.now()) - Date.now()) +
                  RESTART_CLOSE_REPLY_DRAIN_SHUTDOWN_RESERVE_MS
              : SHUTDOWN_TIMEOUT_MS,
          );
        }
        const closeDrainTimeoutMs = !isRestart
          ? null
          : restartDrainTimeoutMs === undefined
            ? SHUTDOWN_TIMEOUT_MS - RESTART_CLOSE_REPLY_DRAIN_SHUTDOWN_RESERVE_MS
            : Math.max(0, (restartDrainDeadlineAt ?? Date.now()) - Date.now());
        if (acceptedRequest.action === "stop") {
          shutdownStep = "startup-operations";
          await acceptedStartupOperations.drain();
        }
        shutdownStep = "gateway-server-close";
        await runWithProcessCleanupBudget(
          {
            deadline: cleanupDeadline(shutdownDeadline!, HARD_EXIT_WATCHDOG_GRACE_MS),
            warn: (message) => gatewayLog.warn(message),
          },
          () =>
            server?.close({
              reason: isRestart ? "gateway restarting" : "gateway stopping",
              restartExpectedMs: isRestart ? 1500 : null,
              ...(closeDrainTimeoutMs !== null ? { drainTimeoutMs: closeDrainTimeoutMs } : {}),
            }),
        );
      } catch (err) {
        shutdownFailure = { step: shutdownStep, error: err };
        gatewayLog.error(
          `shutdown step failed (${shutdownStep.replaceAll("-", " ")}): ${formatErrorMessage(err)}`,
        );
      } finally {
        const handoffClosed =
          managedUpdateCancellation !== false && managedUpdateCancellation !== "restart-after-exit";
        if (handoffClosed) {
          server = null;
        }
        if (action === "restart") {
          try {
            await hostLifecycle?.retire();
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
          } finally {
            clearForceExitTimer();
            forceActiveRestartExit = null;
          }
        } else if (acceptedRequest.hostedStop) {
          try {
            await handleHostedStopAfterServerClose(acceptedRequest.hostedStop, shutdownFailure);
          } finally {
            clearForceExitTimer();
          }
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
              isRestart
                ? {
                    outcome: "planned_restart",
                    reason: formatShutdownReason(acceptedRequest),
                  }
                : {
                    outcome: shutdownFailure ? "forced_stop" : "clean_stop",
                    reason: shutdownFailure
                      ? "gateway.stop_close_failed"
                      : formatShutdownReason(acceptedRequest),
                  },
            );
            await releaseLockIfHeld();
            await exitProcessAfterLogFlush(shutdownFailure ? 1 : 0);
          }
          clearForceExitTimer();
        }
      }
    })();
    if (acceptedRequest.action === "stop") {
      acceptedStartupOperations.stopCompletion = completion;
    }
    // Startup can still be awaiting unrelated work; observe shutdown immediately
    // while retaining its rejecting promise for the cancelled startup's join.
    void completion.catch((error: unknown) => {
      gatewayLog.error(`gateway lifecycle completion failed: ${formatErrorMessage(error)}`);
    });
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
    clearPendingStartupForceExitTimer();
    startupFailedWithoutServerHandle = false;
    runAcceptedRequest(request);
  };
  const request = (
    action: GatewayRunSignalAction,
    signal: GatewayRunSignalRequest["signal"],
    restartReason?: string,
    restartIntent?: GatewayRestartIntent,
    hostedStop?: ReturnType<typeof createGatewayHostLifecycle>,
  ) => {
    const acceptedRequest: GatewayRunSignalRequest = {
      action,
      signal,
      restartReason,
      restartIntent,
      hostedStop,
    };
    failureWork?.controller.abort();
    if (shuttingDown) {
      const currentRestartRequest = pendingStartupRequest ?? activeRestartRequest;
      if (
        action === "restart" &&
        isUpdateProcessRestartReason(restartReason) &&
        currentRestartRequest?.action === "restart" &&
        (!isUpdateProcessRestartReason(currentRestartRequest.restartReason) ||
          (restartIntent?.successorOwner &&
            !sameManagedUpdateOwner(
              restartIntent.successorOwner,
              currentRestartRequest.restartIntent?.successorOwner,
            )))
      ) {
        const upgradedRequest = {
          ...currentRestartRequest,
          signal,
          restartReason,
          restartIntent: {
            ...currentRestartRequest.restartIntent,
            ...restartIntent,
            force: true,
            reason: restartReason,
          },
        };
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
        clearPendingStartupForceExitTimer();
        startupFailedWithoutServerHandle = false;
        runAcceptedRequest(acceptedRequest);
        return;
      }
      gatewayLog.info(`received ${signal} during shutdown; ignoring`);
      return;
    }
    if (action === "stop" && signal === "SIGTERM") {
      // Transfer the exact one-shot authority before host retirement and the
      // one-way fence discard it; neither operation may precede consumption.
      const handoff = consumeGatewaySuspendHandoff(hostLifecycle?.capability.externalRestart);
      if (!handoff.ok) {
        gatewayLog.warn(`external restart handoff refused: ${handoff.error}`);
      } else if (handoff.value) {
        acceptedRequest.action = "external-restart";
        acceptedRequest.restartIntent = { force: true };
      }
    }
    const isRestart = acceptedRequest.action !== "stop";
    if (hostLifecycle !== hostedStop) {
      void hostLifecycle?.retire();
    }
    // Fence new roots synchronously for stops as well as restarts so admitted
    // detached finalizers can drain before the signal tears down the gateway.
    markRestartDraining(formatShutdownReason(acceptedRequest));
    shuttingDown = true;
    gatewayLog.info(`received ${signal}; ${isRestart ? "restarting" : "shutting down"}`);
    if (isRestart) {
      startGatewayRestartTrace("restart.signal.received", [
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
      armPendingStartupForceExitTimer();
      return;
    }
    runAcceptedRequest(acceptedRequest);
  };

  const onSigterm = () => {
    observeSignal("SIGTERM");
    // Debug-level: every accepted signal is announced by request()'s
    // "received <signal>; ..." line, so an info pre-log would double up.
    gatewayLog.debug("signal SIGTERM received");
    if (terminalHostedStop && terminalHostedStop === hostLifecycle) {
      // Kernel cleanup is already joined. A native stop signal belongs to this
      // terminal continuation, not to restart-intent storage in the closed kernel.
      terminalHostedStop.notifyStopSignal();
      return;
    }
    void (async () => {
      const { consumeGatewayRestartIntentPayloadSync } = await gatewayLifecycleRuntimeLoader.load();
      const restartIntent = consumeGatewayRestartIntentPayloadSync();
      // SIGTERM hands replacement to the caller (e.g. systemctl restart).
      // Drain as a restart, then exit even when in-process respawn is configured.
      request(
        restartIntent ? "external-restart" : "stop",
        "SIGTERM",
        restartIntent?.reason,
        restartIntent ?? undefined,
      );
    })().catch((err: unknown) => {
      gatewayLog.error(`failed to handle SIGTERM: ${String(err)}`);
      request("stop", "SIGTERM");
    });
  };
  const onSigint = () => {
    observeSignal("SIGINT");
    gatewayLog.debug("signal SIGINT received");
    request("stop", "SIGINT");
  };
  const onSigusr1 = () => {
    observeSignal("SIGUSR1");
    gatewayLog.debug("signal SIGUSR1 received");
    void (async () => {
      const {
        abortPendingChannelReloads,
        consumeGatewayRestartIntentPayloadSync,
        consumeGatewaySigusr1RestartIntent,
        consumeGatewaySigusr1RestartAuthorization,
        isGatewaySigusr1RestartExternallyAllowed,
        markGatewaySigusr1RestartHandled,
        peekGatewaySigusr1RestartReason,
        scheduleGatewaySigusr1Restart,
      } = await gatewayLifecycleRuntimeLoader.load();
      const restartIntent = consumeGatewayRestartIntentPayloadSync();
      if (restartIntent) {
        abortPendingChannelReloads();
        const authorized = consumeGatewaySigusr1RestartAuthorization();
        const processLocalIntent = authorized ? consumeGatewaySigusr1RestartIntent() : null;
        if (processLocalIntent?.successorOwner) {
          Object.assign(restartIntent, processLocalIntent);
        }
        markRestartDraining(
          formatShutdownReason({
            action: "restart",
            signal: "SIGUSR1",
            restartReason: restartIntent.reason ?? "gateway.restart",
          }),
        );
        if (authorized) {
          markGatewaySigusr1RestartHandled();
        }
        request("restart", "SIGUSR1", restartIntent.reason ?? "gateway.restart", restartIntent);
        return;
      }
      const authorized = consumeGatewaySigusr1RestartAuthorization();
      if (!authorized) {
        markGatewaySigusr1RestartHandled();
        if (!isGatewaySigusr1RestartExternallyAllowed()) {
          gatewayLog.warn("SIGUSR1 restart ignored (not authorized; commands.restart=false).");
          gatewayLog.warn(
            "An unauthorized SIGUSR1 restart signal was received and ignored. " +
              "If a pending gateway restart needs to be applied, run `openclaw gateway restart` " +
              "or restart the gateway through your service manager.",
          );
          return;
        }
        if (shuttingDown) {
          gatewayLog.info("received SIGUSR1 during shutdown; ignoring");
          return;
        }
        // External SIGUSR1 requests should still reuse the in-process restart
        // scheduler so idle drain and restart coalescing stay consistent.
        abortPendingChannelReloads();
        scheduleGatewaySigusr1Restart({ delayMs: 0, reason: "SIGUSR1" });
        return;
      }
      abortPendingChannelReloads();
      const sigusr1RestartIntent = consumeGatewaySigusr1RestartIntent();
      const restartReason = peekGatewaySigusr1RestartReason();
      markRestartDraining(
        formatShutdownReason({
          action: "restart",
          signal: "SIGUSR1",
          restartReason: sigusr1RestartIntent?.reason ?? restartReason,
        }),
      );
      markGatewaySigusr1RestartHandled();
      request(
        "restart",
        "SIGUSR1",
        sigusr1RestartIntent?.reason ?? restartReason,
        sigusr1RestartIntent ?? undefined,
      );
    })().catch((err: unknown) => {
      // Defense in depth: if anything in the listener body rejects, the
      // SIGUSR1 emit has already advanced emittedRestartToken but no one
      // called markGatewaySigusr1RestartHandled. Without unsticking the
      // token here, every subsequent scheduleGatewaySigusr1Restart() would
      // silently coalesce into the dead in-flight signal and the gateway
      // would never restart again until manually kickstarted.
      gatewayLog.error(`SIGUSR1 handler failed: ${formatErrorMessage(err)}`);
      try {
        eagerLifecycleRuntime.markGatewaySigusr1RestartHandled();
      } catch {
        // Best-effort: the eager reference itself is the recovery path.
      }
      try {
        eagerLifecycleRuntime.rollbackGatewayRestartSignalAdmission();
        // A later signal must repeat the synchronous close transition even if
        // this handler failed after marking the one-way drain.
        restartDrainingMarked = false;
      } catch {
        // Keep admission recovery independent from restart-token recovery.
      }
    });
  };

  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  process.on("SIGUSR1", onSigusr1);
  const releaseInstallationObserver = registerGatewayInstallationReplacementHandler((fact) => {
    installationReplacement = fact;
    gatewayLog.warn(fact.message);
    if (!supervisorMode) {
      gatewayLog.error(
        `The foreground Gateway must stop after its installation was replaced. Restart it with: ${formatCliCommand("openclaw gateway run")}`,
      );
    }
    request("restart", "SIGUSR1", fact.reason);
  });

  try {
    // Keep process alive; SIGUSR1 triggers an in-process restart (no supervisor required).
    // SIGTERM/SIGINT still exit after a graceful shutdown.
    let isFirstIteration = true;
    for (;;) {
      const iterationStartupOperations = isFirstIteration
        ? startupOperations
        : createGatewayStartupOperations();
      startupOperations = iterationStartupOperations;
      await hostLifecycle?.retire();
      const iterationHost = createGatewayHostLifecycle({
        processOwner: {
          ownsProcessLifecycle: params.ownsProcessLifecycle === true,
          supervisor: supervisorMode,
        },
        isCurrent: () => hostLifecycle === iterationHost,
        isServing: () => server !== null && restartResolver !== null && !shuttingDown,
        acceptStop: () =>
          runOutsideGatewayRootWorkAdmission(() =>
            request("stop", "hosted Gateway stop", undefined, undefined, iterationHost),
          ),
      });
      hostLifecycle = iterationHost;
      let startupFailedBeforeServerHandle = false;
      const isRestartIteration = !isFirstIteration;
      isFirstIteration = false;
      try {
        if (isRestartIteration) {
          await prepareGatewayRestartIteration(
            await gatewayLifecycleRuntimeLoader.load(),
            gatewayLog,
            () => {
              restartDrainingMarked = false;
            },
          );
        }
        if (installationReplacement) {
          await exitReplacedInstallation(installationReplacement);
          return;
        }
        if (pendingRestartCompletion) {
          completeBoot(pendingRestartCompletion);
        }
        startupStartedAt = Date.now();
        await params.beginBoot?.(startupStartedAt);
        if (installationReplacement) {
          await exitReplacedInstallation(installationReplacement);
          return;
        }
        const startedServer = await params.start({
          ...(isRestartIteration ? {} : { processStartedAt }),
          startupStartedAt,
          requestHotReloadRecovery: eagerLifecycleRuntime.requestGatewayRestartWithSignalAdmission,
          hostLifecycle: iterationHost.capability,
          startupOperation: iterationStartupOperations.run,
        });
        iterationStartupOperations.close();
        server = startedServer;
        startupFailedWithoutServerHandle = false;
        await new Promise<void>((resolve, reject) => {
          restartResolver = () => {
            restartResolver = null;
            resolve();
          };
          void startedServer.startupSettled.then(undefined, reject);
          flushPendingStartupRequest();
        });
      } catch (err) {
        iterationStartupOperations.close();
        if (
          iterationStartupOperations.stopCompletion &&
          (iterationStartupOperations.cancelledWith(err) ||
            iterationStartupOperations.failedWith(err))
        ) {
          await iterationStartupOperations.stopCompletion;
          if (iterationStartupOperations.cancelledWith(err)) {
            return;
          }
          throw err;
        }
        await iterationHost.retire();
        const failedServer = server;
        server = null;
        const maintenanceRequired = findStartupMaintenanceRequiredError(err);
        completeBoot({
          outcome: "startup_failed",
          reason: truncateUtf16Safe(
            formatErrorMessage(err),
            GATEWAY_BOOT_REASON_MAX_UTF16_CODE_UNITS,
          ),
          ...(maintenanceRequired ? { startupReason: maintenanceRequired.code } : {}),
        });
        try {
          await failedServer?.close({ reason: "gateway startup failed" });
        } catch (closeError) {
          throw new GatewayStartupCleanupError(err, closeError);
        }
        if (installationReplacement) {
          await exitReplacedInstallation(installationReplacement);
          return;
        }
        // Keep TCC recovery after clean restart failures (#35862), but never reuse a
        // generation whose startup cleanup failed. The outer CLI exits nonzero.
        if (
          maintenanceRequired ||
          !isRestartIteration ||
          err instanceof GatewayStartupCleanupError
        ) {
          throw err;
        }
        startupFailedWithoutServerHandle = true;
        startupFailedBeforeServerHandle = true;
        if (!pendingStartupRequest) {
          // Release the gateway lock so that `daemon restart/stop` (which
          // discovers PIDs via the gateway port) can still manage the process.
          // Without this, the process holds the lock but is not listening,
          // forcing manual cleanup. (#35862)
          await releaseLockIfHeld();
        }
        const errMsg = formatErrorMessage(err);
        const errStack = err instanceof Error && err.stack ? `\n${err.stack}` : "";
        writeStabilityBundle("gateway.restart_startup_failed", err);
        gatewayLog.error(
          `gateway startup failed: ${errMsg}. ` +
            `Process will stay alive; fix the issue and restart.${errStack}`,
        );
        const onRestartStartupFailure = params.onRestartStartupFailure;
        if (!shuttingDown && onRestartStartupFailure) {
          const controller = new AbortController();
          failureWork = {
            controller,
            settled: Promise.resolve().then(() => onRestartStartupFailure(err, controller.signal)),
          };
          try {
            await failureWork.settled;
          } finally {
            failureWork = undefined;
          }
        }
      }
      if (startupFailedBeforeServerHandle) {
        await new Promise<void>((resolve) => {
          restartResolver = () => {
            restartResolver = null;
            resolve();
          };
          flushPendingStartupRequest({ allowMissingServer: true });
        });
      }
    }
  } finally {
    await hostLifecycle?.retire();
    await releaseLockIfHeld();
    cleanupSignals();
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
