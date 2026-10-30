import type { Server as HttpServer } from "node:http";
import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import type { WebSocketServer } from "ws";
import { disposeAcpSessionManager } from "../acp/control-plane/manager.js";
import { disposeAllSessionMcpRuntimes } from "../agents/agent-bundle-mcp-tools.js";
import { disposeAllCliLiveSessions } from "../agents/cli-runner/cli-live-session-registry.js";
import { disposeRegisteredAgentHarnesses } from "../agents/harness/registry.js";
import { closePreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.lifecycle.js";
import { fenceSessionSuspensionWritesForGatewayShutdown } from "../agents/session-suspension.js";
import { closeSwarmScheduler } from "../agents/subagents/swarm/swarm-scheduler.js";
import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { closeSessionTranscriptReconcileWorkerPool } from "../config/sessions/session-transcript-reconcile-pool.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import { formatErrorMessage, hasErrnoCode } from "../infra/errors.js";
import { heartbeatNotifications } from "../infra/heartbeat-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { GatewayPluginMetadataOwner } from "../plugins/plugin-metadata-lifecycle.js";
import { hasRetainedPluginRuntimeCloseError } from "../plugins/runtime-close-error.js";
import type { createPluginRegistryOwner } from "../plugins/runtime.js";
import { getCanonicalGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "../process/supervisor/cancellation-policy.js";
import { shutdownProcessSupervisor } from "../process/supervisor/index.js";
import { finalizeActiveDebugProxyCaptures } from "../proxy-capture/runtime-cleanup.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { settlesWithin } from "../shared/settle-within.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { clearArtifactDownloads } from "./artifact-download-grants.js";
import {
  collectGatewayProcessMemoryUsageMb,
  measureGatewayCloseStep,
  recordGatewayRestartTrace,
} from "./restart-trace.js";
import type { ChatRunState } from "./server-chat-state.js";
import { WEBSOCKET_CLOSE_GRACE_MS } from "./server-constants.js";
import type { GatewayMaintenanceHandles } from "./server-maintenance-lifecycle.js";
import {
  waitForMediaCleanupDrainsToSettle,
  type MediaCleanupStopResult,
} from "./server-media-cleanup-lifecycle.js";
import { clearSessionTypingState } from "./server-methods/session-typing-state.js";
import type { GatewayCloseOptions } from "./server-public.js";
import { prepareGatewayRunShutdown, type GatewayRunShutdownParams } from "./server-run-shutdown.js";
import {
  recordGatewayShutdownWarning as recordShutdownWarning,
  resolveGatewayShutdownNotice,
  GatewayShutdownCleanupRetainedError,
  isGatewayCleanupRetainedError,
} from "./server-shutdown.js";

const shutdownLog = createSubsystemLogger("gateway/shutdown");
const GATEWAY_SHUTDOWN_HOOK_TIMEOUT_MS = 1_000;
const GATEWAY_PRE_RESTART_HOOK_TIMEOUT_MS = 1_000;
const ACTIVE_SESSIONS_SHUTDOWN_DRAIN_TIMEOUT_MS = 2_000;
const WEBSOCKET_CLOSE_FORCE_CONTINUE_MS = 250;
const HTTP_CLOSE_GRACE_MS = 1_000;
const HTTP_CLOSE_FORCE_WAIT_MS = 5_000;
const RUNTIME_CLOSE_GRACE_MS = 5_000;
const PERSISTENCE_CLOSE_GRACE_MS = 3_000;
const REGISTRY_CLOSE_GRACE_MS = 10_000;
type ShutdownResult = {
  durationMs: number;
  warnings: string[];
};

function createCloseSteps(
  reason: string,
  warnings: string[],
  cleanupWork: AsyncWorkScope,
  exitAfterClose: boolean,
) {
  const retainedErrors: unknown[] = [];
  const measureCloseStep = async <T>(
    name: string,
    run: () => Promise<T> | T,
    timeoutMs = RUNTIME_CLOSE_GRACE_MS,
  ) => {
    const work = measureGatewayCloseStep(`restart.close.${name}`, run, [["reason", reason]]);
    if (exitAfterClose && !(await settlesWithin(work, timeoutMs))) {
      throw new GatewayShutdownCleanupRetainedError([], `${name} resources remain after grace`);
    }
    return await work;
  };
  const shutdownStep = async (name: string, fn: () => Promise<void> | void, phase = name) => {
    const work = cleanupWork.track(async () => {
      try {
        await measureGatewayCloseStep(`restart.close.${phase}`, fn, [["reason", reason]]);
      } catch (err: unknown) {
        if (isGatewayCleanupRetainedError(err)) {
          retainedErrors.push(err);
        }
        const detail = err instanceof Error ? err.message : String(err);
        shutdownLog.warn(`${name}: ${detail}`);
        recordShutdownWarning(warnings, name);
      }
    });
    if (!exitAfterClose) {
      await work;
    } else if (!(await settlesWithin(work, RUNTIME_CLOSE_GRACE_MS))) {
      // The final persistence barrier still owns this exact operation after its grace.
      shutdownLog.warn(`${name}: resources remain after grace`);
      recordShutdownWarning(warnings, name);
    }
  };
  return { measureCloseStep, shutdownStep, retainedErrors };
}

export async function runGatewayClosePrelude(params: {
  stopDiagnostics?: () => void;
  skillsChangeUnsub?: () => void | Promise<void>;
  disposeNodeReapproval: () => void;
  stopChannelHealthMonitor?: () => Promise<void>;
  stopReadinessEventLoopHealth?: () => void;
  closeMcpServer?: () => Promise<void>;
}): Promise<void> {
  params.stopDiagnostics?.();
  await measureGatewayCloseStep("restart.close.skills-watcher", () => params.skillsChangeUnsub?.());
  params.disposeNodeReapproval();
  await measureGatewayCloseStep("restart.close.channel-health-monitor", () =>
    params.stopChannelHealthMonitor?.(),
  );
  params.stopReadinessEventLoopHealth?.();
  await measureGatewayCloseStep("restart.close.mcp-server", () =>
    params.closeMcpServer?.().catch(() => {}),
  );
}

async function waitForHttpClose(params: {
  closePromise: Promise<void>;
  timeoutMs: number;
  label: string;
  warnings: string[];
}): Promise<boolean> {
  return await settlesWithin(params.closePromise, params.timeoutMs).catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    shutdownLog.warn(`${params.label}: ${detail}`);
    recordShutdownWarning(params.warnings, params.label);
    return true;
  });
}

async function closeHttpListener(params: {
  server: HttpServer;
  label: string;
  warnings: string[];
}): Promise<void> {
  const { server, label, warnings } = params;
  server.closeIdleConnections?.();
  const closePromise = new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (!err || hasErrnoCode(err, "ERR_SERVER_NOT_RUNNING")) {
        resolve();
        return;
      }
      reject(err);
    });
  });
  void closePromise.catch(() => undefined);
  const closedWithinGrace = await waitForHttpClose({
    closePromise,
    timeoutMs: HTTP_CLOSE_GRACE_MS,
    label,
    warnings,
  });
  if (closedWithinGrace) {
    return;
  }
  shutdownLog.warn(
    `${label} close exceeded ${HTTP_CLOSE_GRACE_MS}ms; forcing connection shutdown and waiting for close`,
  );
  recordShutdownWarning(warnings, label);
  server.closeAllConnections?.();
  const closedAfterForce = await waitForHttpClose({
    closePromise,
    timeoutMs: HTTP_CLOSE_FORCE_WAIT_MS,
    label,
    warnings,
  });
  if (!closedAfterForce) {
    throw new GatewayShutdownCleanupRetainedError(
      [],
      `${label} close still pending after forced connection shutdown (${HTTP_CLOSE_FORCE_WAIT_MS}ms)`,
    );
  }
}

export type GatewayCloseParams = {
  retainSharedState?: boolean;
  resolveGatewayContext: GatewayRunShutdownParams["resolveGatewayContext"];
  closePluginRegistry: ReturnType<typeof createPluginRegistryOwner>["close"];
  pluginMetadata: Pick<GatewayPluginMetadataOwner, "beginClose" | "close">;
  bonjourStop: (() => Promise<void>) | null;
  tailscaleCleanup: (() => Promise<void>) | null;
  clearSecretsRuntimeSnapshot?: (() => void) | null;
  channelIds?: readonly ChannelId[];
  stopChannel: (name: ChannelId, accountId?: string) => Promise<void>;
  pluginServices: PluginServicesHandle | null;
  disposeAllBundleLspRuntimes: () => Promise<void>;
  drainWorktreeRunEnd: () => Promise<void>;
  drainRetainedOpenAiEmbeddingProviders: () => Promise<void>;
  stopGmailWatcher: () => Promise<void>;
  closeProviderTransportDispatcherPool: () => Promise<void>;
  cron: { stop: () => void; stopAndDrain?: () => Promise<void> };
  stopCronMaintenance?: () => Promise<void>;
  stopScheduledServices: () => Promise<void>;
  maintenance: GatewayMaintenanceHandles | null;
  stopMediaCleanup: () => Promise<MediaCleanupStopResult>;
  agentUnsub: (() => Promise<void> | void) | null;
  transcriptUnsub: (() => void) | null;
  lifecycleUnsub: (() => void) | null;
  clients: Set<{
    connectionKind?: "gateway" | "worker";
    socket: { close: (code: number, reason: string) => void };
  }>;
  finishRequestEntries?: () => Promise<void>;
  drainSdkWork?: () => Promise<void>;
  stopScheduler: () => Promise<void>;
  closeSdkResources?: () => Promise<void>;
  wss?: WebSocketServer;
  httpServer?: HttpServer;
  httpServers?: HttpServer[];
  drainActiveSessionsForShutdown?: (params: {
    reason: "shutdown" | "restart";
    totalTimeoutMs?: number;
  }) => Promise<{ emittedSessionIds: string[]; timedOut: boolean }>;
  chatRunState: ChatRunState;
};

export type GatewayClosePrepareParams = GatewayRunShutdownParams & {
  disposeAllCodeModeRuns: () => Promise<void> | void;
  preparePluginRegistryClose: ReturnType<typeof createPluginRegistryOwner>["prepareClose"];
  updateCheckStop?: (() => Promise<void> | void) | null;
  configReloader: { stop: () => Promise<void> };
};

export async function prepareGatewayClose(
  params: GatewayClosePrepareParams,
  opts?: GatewayCloseOptions,
) {
  const start = Date.now();
  const warnings: string[] = [];
  const notice = resolveGatewayShutdownNotice(opts);
  const { reason } = notice;
  const restartExpectedMs = notice.restartExpectedMs ?? null;
  const restart = restartExpectedMs !== null;
  const cleanupWork = new AsyncWorkScope();
  const exitAfterClose = opts?.exitAfterClose === true;
  const { shutdownStep, retainedErrors } = createCloseSteps(
    reason,
    warnings,
    cleanupWork,
    exitAfterClose,
  );
  // Fence async session-state writes before the first awaited shutdown step.
  fenceSessionSuspensionWritesForGatewayShutdown();

  const triggerLifecycleHook = async (action: "shutdown" | "pre-restart", timeoutMs: number) => {
    const hookName = `gateway:${action}` as const;
    try {
      const event = createInternalHookEvent("gateway", action, hookName, {
        reason,
        restartExpectedMs,
      });
      const hookPromise = cleanupWork.track(() =>
        measureGatewayCloseStep(`gateway-${action}-hook`, () => triggerInternalHook(event)),
      );
      void hookPromise.catch(() => undefined);
      if (!exitAfterClose) {
        await hookPromise;
      } else if (!(await settlesWithin(hookPromise, timeoutMs))) {
        shutdownLog.warn(`${hookName} hook timed out after ${timeoutMs}ms; continuing shutdown`);
        recordShutdownWarning(warnings, hookName);
      }
    } catch (error) {
      shutdownLog.warn(`${hookName}: ${formatErrorMessage(error)}`);
      recordShutdownWarning(warnings, hookName);
    }
  };

  const prepareRuns = async () => {
    const admissions = await measureGatewayCloseStep("restart.close.session-abort", () =>
      prepareGatewayRunShutdown({
        ...params,
        warnings,
        exitAfterClose,
      }),
    );
    // Start the join immediately, alongside the remaining shutdown hooks.
    void shutdownStep("session-admissions", () => admissions.released);
    return admissions.failure;
  };

  try {
    const failure = await prepareRuns();
    await shutdownStep("update-check", () => params.updateCheckStop?.());
    await shutdownStep("config-reloader", () => params.configReloader.stop());
    await triggerLifecycleHook("shutdown", GATEWAY_SHUTDOWN_HOOK_TIMEOUT_MS);
    if (restart) {
      await triggerLifecycleHook("pre-restart", GATEWAY_PRE_RESTART_HOOK_TIMEOUT_MS);
    }
    // Cancel code cells before received work joins their pending bridge calls.
    await shutdownStep("code-mode-runs", () => params.disposeAllCodeModeRuns());
    // ACPX owns agent-process cleanup; memory retirement must not overtake its drain.
    await shutdownStep("acp-session-manager", () => disposeAcpSessionManager("gateway-shutdown"));
    // Memory owns database borrows independent of stalled model/tool finalizers.
    // The registry retains and later joins this same preparation before retirement.
    const memoryPreparation = cleanupWork.track(() =>
      measureGatewayCloseStep(
        "restart.close.memory-preparation",
        params.preparePluginRegistryClose,
      ),
    );
    void memoryPreparation.catch((error: unknown) => {
      shutdownLog.warn(`memory preparation failed during shutdown: ${formatErrorMessage(error)}`);
      recordShutdownWarning(warnings, "memory-managers");
    });
    return {
      start,
      notice,
      restart,
      warnings,
      cleanupWork,
      retainedErrors,
      failure,
      exitAfterClose,
    };
  } catch (error) {
    if (!isGatewayCleanupRetainedError(error)) {
      if (exitAfterClose) {
        await settlesWithin(cleanupWork.drain(), RUNTIME_CLOSE_GRACE_MS);
      } else {
        await cleanupWork.drain();
      }
    }
    throw error;
  }
}

export function completeGatewayClose(
  params: GatewayCloseParams,
  preparation: Awaited<ReturnType<typeof prepareGatewayClose>>,
): Promise<ShutdownResult> {
  // Cleanup belongs to shutdown, not the initiating RPC's drained connection scope.
  return preparation.cleanupWork.run(async () => {
    const result = await closeGatewayResources(params, preparation).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const drain = preparation.cleanupWork.drain();
    if (!result.ok) {
      // Resource close already gave retained work its grace; sealing keeps its custody.
      throw result.error;
    }
    if (!preparation.exitAfterClose) {
      await drain;
    } else if (!(await settlesWithin(drain, RUNTIME_CLOSE_GRACE_MS))) {
      throw new GatewayShutdownCleanupRetainedError([]);
    }
    return result.value;
  });
}

async function closeGatewayResources(
  params: GatewayCloseParams,
  preparation: Awaited<ReturnType<typeof prepareGatewayClose>>,
): Promise<ShutdownResult> {
  await measureGatewayCloseStep("restart.close.metadata-begin", () =>
    params.pluginMetadata.beginClose(),
  );
  const { start, notice, restart, warnings, cleanupWork } = preparation;
  const { reason } = notice;
  const restartExpectedMs = notice.restartExpectedMs ?? null;
  let mediaCleanupStopResult: MediaCleanupStopResult | undefined;
  const resourceCleanupErrors: unknown[] = [];
  const recordResourceCleanupFailure = (error: unknown) => {
    if (hasRetainedPluginRuntimeCloseError(error)) {
      throw error;
    }
    resourceCleanupErrors.push(error);
  };
  let closeFailure: { error: unknown } | undefined;
  const { measureCloseStep, shutdownStep, retainedErrors } = createCloseSteps(
    reason,
    warnings,
    cleanupWork,
    preparation.exitAfterClose,
  );
  const disposeRuntime = async (
    label:
      | "plugin-services"
      | "cli-live-sessions"
      | "agent-harnesses"
      | "bundle-mcp"
      | "bundle-lsp"
      | "embedding-providers",
    dispose: () => Promise<void>,
  ) => {
    const disposePromise = cleanupWork
      .track(() => measureGatewayCloseStep(label, () => Promise.resolve().then(dispose)))
      .catch((err: unknown) => {
        shutdownLog.warn(`${label} runtime disposal failed during shutdown: ${String(err)}`);
        recordShutdownWarning(warnings, label);
        resourceCleanupErrors.push(err);
      });
    if (!preparation.exitAfterClose) {
      await disposePromise;
    } else if (!(await settlesWithin(disposePromise, RUNTIME_CLOSE_GRACE_MS))) {
      shutdownLog.warn(
        `${label} runtime disposal exceeded ${RUNTIME_CLOSE_GRACE_MS}ms; continuing shutdown`,
      );
      recordShutdownWarning(warnings, label);
    }
  };
  try {
    if (params.drainActiveSessionsForShutdown) {
      await shutdownStep("session-end-drain", async () => {
        const drainReason: "shutdown" | "restart" = restart ? "restart" : "shutdown";
        const result = await params.drainActiveSessionsForShutdown!({
          reason: drainReason,
          totalTimeoutMs: ACTIVE_SESSIONS_SHUTDOWN_DRAIN_TIMEOUT_MS,
        });
        if (result.timedOut) {
          shutdownLog.warn(
            `session-end-drain timed out after ${ACTIVE_SESSIONS_SHUTDOWN_DRAIN_TIMEOUT_MS}ms after ${result.emittedSessionIds.length} sessions; continuing shutdown`,
          );
          recordShutdownWarning(warnings, "session-end-drain");
        }
      });
    }
    if (params.bonjourStop) {
      await shutdownStep("bonjour", () => params.bonjourStop!());
    }
    if (params.pluginServices) {
      const cleanup = cleanupWork.track(() =>
        Promise.resolve().then(async () => {
          const result = await params.pluginServices!.stop();
          if (result?.errors.length) {
            recordShutdownWarning(warnings, "plugin-services");
          }
        }),
      );
      // A stalled plugin must not prevent later runtime and child-process cleanup.
      await disposeRuntime("plugin-services", () => cleanup);
    }
    await measureGatewayCloseStep("restart.close.channels", async () => {
      const channelIds = params.channelIds ?? listChannelPlugins().map((plugin) => plugin.id);
      for (const channelId of channelIds) {
        await shutdownStep(`channel/${channelId}`, () => params.stopChannel(channelId));
      }
    });
    await disposeRuntime("cli-live-sessions", disposeAllCliLiveSessions);
    await disposeRuntime("agent-harnesses", disposeRegisteredAgentHarnesses);
    await shutdownStep("ai-session-resources", () => cleanupSessionResources());
    await measureGatewayCloseStep("restart.close.bundle-runtimes", async () => {
      await Promise.all([
        disposeRuntime("bundle-mcp", disposeAllSessionMcpRuntimes),
        disposeRuntime("bundle-lsp", params.disposeAllBundleLspRuntimes),
      ]);
    });
    await shutdownStep("artifact-downloads", clearArtifactDownloads);
    await shutdownStep("periodic-maintenance", () => params.maintenance?.stopPeriodicTasks());
    await shutdownStep("skill-usage", () => params.maintenance?.skillUsageCleanup());
    try {
      mediaCleanupStopResult = await measureCloseStep("media-cleanup", () =>
        params.stopMediaCleanup(),
      );
    } catch (err) {
      shutdownLog.warn(`media-cleanup: ${err instanceof Error ? err.message : String(err)}`);
      recordShutdownWarning(warnings, "media-cleanup");
    }
    if (mediaCleanupStopResult !== "drained") {
      // Timed-out cleanup still owns shared SQLite. Keep the process store open
      // so late completion cannot resume against a database torn down by shutdown.
      recordShutdownWarning(warnings, "media-cleanup");
    }
    await shutdownStep("gmail-watcher", () => params.stopGmailWatcher());
    await shutdownStep("scheduled-services", params.stopScheduledServices);
    await shutdownStep("cron", () =>
      params.cron.stopAndDrain ? params.cron.stopAndDrain() : params.cron.stop(),
    );
    await shutdownStep("cron-maintenance", () => params.stopCronMaintenance?.());
    if (params.agentUnsub) {
      await shutdownStep("agent-unsub", () => params.agentUnsub!());
    }
    heartbeatNotifications.onEvent = () => {};
    if (params.transcriptUnsub) {
      await shutdownStep("transcript-unsub", () => params.transcriptUnsub!());
    }
    if (params.lifecycleUnsub) {
      await shutdownStep("lifecycle-unsub", () => params.lifecycleUnsub!());
    }
    params.chatRunState.clear();
    let clientCloseFailures = 0;
    for (const c of params.clients) {
      try {
        c.socket.close(
          1012,
          c.connectionKind === "worker" ? "gateway-shutdown" : "service restart",
        );
      } catch {
        clientCloseFailures++;
      }
    }
    if (clientCloseFailures > 0) {
      shutdownLog.warn(`failed to close ${clientCloseFailures} WebSocket client(s)`);
      recordShutdownWarning(warnings, "ws-clients");
    }
    params.clients.clear();
    if (params.wss) {
      await measureCloseStep(
        "websocket-server",
        async () => {
          const wsClients = params.wss?.clients ?? new Set();
          const closePromise = new Promise<void>((resolve) => {
            params.wss?.close(() => resolve());
          });
          const closedWithinGrace = await settlesWithin(closePromise, WEBSOCKET_CLOSE_GRACE_MS);
          if (!closedWithinGrace) {
            shutdownLog.warn(
              `websocket server close exceeded ${WEBSOCKET_CLOSE_GRACE_MS}ms; forcing shutdown continuation with ${wsClients.size} tracked client(s)`,
            );
            recordShutdownWarning(warnings, "websocket-server");
            for (const client of wsClients) {
              try {
                client.terminate();
              } catch {
                /* ignore */
              }
            }
            if (!(await settlesWithin(closePromise, WEBSOCKET_CLOSE_FORCE_CONTINUE_MS))) {
              shutdownLog.warn(
                `websocket server close still pending after ${WEBSOCKET_CLOSE_FORCE_CONTINUE_MS}ms force window; continuing shutdown`,
              );
            }
          }
        },
        WEBSOCKET_CLOSE_GRACE_MS + WEBSOCKET_CLOSE_FORCE_CONTINUE_MS + 250,
      );
    }
    // Node cleanup replies remain admissible until sockets close. Join their
    // uncancellable preparation before releasing the remaining process state.
    await measureCloseStep("request-entries", () => params.finishRequestEntries?.());
    clearSessionTypingState();
    const transportServers =
      params.httpServers && params.httpServers.length > 0
        ? params.httpServers
        : params.httpServer
          ? [params.httpServer]
          : [];
    try {
      if (transportServers.length > 0) {
        await measureCloseStep(
          "http-server",
          async () => {
            const results = await Promise.allSettled(
              transportServers.map((server, index) =>
                closeHttpListener({
                  server,
                  label: transportServers.length > 1 ? `http-server[${index}]` : "http-server",
                  warnings,
                }),
              ),
            );
            const failure = results.find(
              (result): result is PromiseRejectedResult => result.status === "rejected",
            );
            if (failure) {
              throw failure.reason;
            }
          },
          HTTP_CLOSE_GRACE_MS + HTTP_CLOSE_FORCE_WAIT_MS + 250,
        );
      }
    } finally {
      // The foreground Tailscale session owns the route, so closing its claim
      // releases the ephemeral backend before this lifecycle is forgotten.
      if (params.tailscaleCleanup) {
        await shutdownStep("tailscale", () => params.tailscaleCleanup!());
      }
    }
    await disposeRuntime("embedding-providers", params.drainRetainedOpenAiEmbeddingProviders);
  } catch (error) {
    closeFailure = { error };
  }
  try {
    // Keep shared databases alive when a model, tool, or cleanup owner outlives
    // its grace. Only a fresh process may restart that retained generation.
    await measureCloseStep("cleanup-work", () => cleanupWork.runWhenIdle(() => {}));
    if (resourceCleanupErrors.length) {
      throw resourceCleanupErrors[0];
    }
    if (preparation.retainedErrors.length || retainedErrors.length) {
      throw new GatewayShutdownCleanupRetainedError([
        ...preparation.retainedErrors,
        ...retainedErrors,
      ]);
    }
    if (closeFailure) {
      throw closeFailure.error;
    }
    await measureCloseStep("worktree-run-end", params.drainWorktreeRunEnd);
    await shutdownStep(
      "provider-transport-dispatchers",
      params.closeProviderTransportDispatcherPool,
    );
    await measureCloseStep("request-entries", () => params.finishRequestEntries?.());
    await measureCloseStep("media-cleanup-drains", waitForMediaCleanupDrainsToSettle);
    await measureCloseStep("sdk-work", () => params.drainSdkWork?.());
    const swarmOwner = getCanonicalGatewayContextResolver(params.resolveGatewayContext);
    if (swarmOwner) {
      await measureCloseStep("swarm-scheduler", () =>
        closeSwarmScheduler(swarmOwner).catch(recordResourceCleanupFailure),
      );
    }
    await measureCloseStep("scheduler", () => params.stopScheduler());
    const registryClose = await measureCloseStep(
      "plugin-registry",
      () =>
        params.closePluginRegistry(async (retireRegistry) => {
          // SDK cleanup can use prepared donors; release its claims before model or registry disposal.
          await measureCloseStep("sdk-resources", () =>
            params.closeSdkResources?.().catch(recordResourceCleanupFailure),
          );
          return measureCloseStep(
            "plugin-metadata",
            () =>
              params.pluginMetadata.close(async (retire) => {
                await measureCloseStep("shared-swarm-scheduler", () =>
                  closeSwarmScheduler().catch(recordResourceCleanupFailure),
                );
                await measureCloseStep("prepared-models", closePreparedModelRuntimeSnapshots);
                await measureCloseStep(
                  "transcript-workers",
                  closeSessionTranscriptReconcileWorkerPool,
                );
                await measureCloseStep("metadata-retirement", retire);
                await measureCloseStep("retirement-cleanup", () =>
                  cleanupWork.runWhenIdle(() => {}),
                );
                await measureCloseStep("incognito-sessions", () =>
                  memorySessionActorOwners.reset(),
                );
                // Owned process trees get their normal TERM window before shared state retires.
                await measureCloseStep(
                  "process-supervisor",
                  shutdownProcessSupervisor,
                  GRACEFUL_CANCEL_TIMEOUT_MS + 1_000,
                );
                // Releasing agent leases still writes shared state; keep its owner alive until then.
                await measureCloseStep("agent-databases", closeOpenClawAgentDatabasesAsync);
                await measureCloseStep("debug-proxy", () =>
                  finalizeActiveDebugProxyCaptures().catch(recordResourceCleanupFailure),
                );
                try {
                  await measureCloseStep(
                    "global-singletons",
                    () =>
                      drainGlobalSingletonLifecycleState(restart ? "restart" : "close", {
                        retainSharedState: params.retainSharedState,
                        measureReset: (name, reset) =>
                          measureGatewayCloseStep(`restart.close.global-singleton.${name}`, reset),
                      }),
                    PERSISTENCE_CLOSE_GRACE_MS,
                  );
                } finally {
                  try {
                    params.clearSecretsRuntimeSnapshot?.();
                  } catch {
                    /* ignore */
                  }
                }
              }, retireRegistry),
            REGISTRY_CLOSE_GRACE_MS,
          );
        }),
      REGISTRY_CLOSE_GRACE_MS,
    );
    for (const error of registryClose.memoryErrors) {
      shutdownLog.warn(`memory-managers: ${formatErrorMessage(error)}`);
      recordShutdownWarning(warnings, "memory-managers");
    }
    for (const { pluginId, hookId, error } of registryClose.pluginFailures) {
      recordShutdownWarning(warnings, `plugin/${pluginId}`);
      const message = `Plugin ${pluginId} cleanup failed (${hookId}): ${formatErrorMessage(error)}`;
      shutdownLog.warn(message);
      // Retirement has joined admitted work; callback faults are diagnostic, unlike lost state.
      if (hookId === "session-store") {
        resourceCleanupErrors.push(new Error(message, { cause: error }));
      }
    }
  } catch (error) {
    if (!resourceCleanupErrors.includes(error)) {
      resourceCleanupErrors.push(error);
    }
  }
  if (closeFailure && !resourceCleanupErrors.includes(closeFailure.error)) {
    resourceCleanupErrors.unshift(closeFailure.error);
  }
  // Failed resume persistence remains fatal, but must not leave ingress listening.
  if (preparation.failure) {
    resourceCleanupErrors.push(preparation.failure.error);
  }
  resourceCleanupErrors.push(...preparation.retainedErrors, ...retainedErrors);
  const durationMs = Date.now() - start;
  if (resourceCleanupErrors.length > 0 || closeFailure) {
    shutdownLog.warn(
      `shutdown failed in ${durationMs}ms${warnings.length ? `: ${warnings.join(", ")}` : ""}`,
    );
  } else if (warnings.length > 0) {
    shutdownLog.warn(`shutdown completed in ${durationMs}ms with warnings: ${warnings.join(", ")}`);
  } else {
    shutdownLog.info(`shutdown completed cleanly in ${durationMs}ms`);
  }

  recordGatewayRestartTrace("restart.close.total", durationMs, [
    ["reason", reason],
    ["restartExpectedMs", restartExpectedMs ?? "none"],
    ...collectGatewayProcessMemoryUsageMb(),
  ]);
  if (resourceCleanupErrors.length === 1) {
    throw resourceCleanupErrors[0];
  }
  if (resourceCleanupErrors.length > 1) {
    if (resourceCleanupErrors.every(isGatewayCleanupRetainedError)) {
      throw new GatewayShutdownCleanupRetainedError(resourceCleanupErrors);
    }
    throw new AggregateError(resourceCleanupErrors, "Gateway resource cleanup failed", {
      cause: resourceCleanupErrors[0],
    });
  }
  return { durationMs, warnings };
}
