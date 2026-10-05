import type { Server as HttpServer } from "node:http";
import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import type { WebSocketServer } from "ws";
import { disposeAcpSessionManager } from "../acp/control-plane/manager.js";
import { disposeAllSessionMcpRuntimes } from "../agents/agent-bundle-mcp-tools.js";
import { disposeRegisteredAgentHarnesses } from "../agents/harness/registry.js";
import { closePreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.lifecycle.js";
import { fenceSessionSuspensionWritesForGatewayShutdown } from "../agents/session-suspension.js";
import { closeSwarmScheduler } from "../agents/subagents/swarm/swarm-scheduler.js";
import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import { closeSessionTranscriptReconcileWorkerPool } from "../config/sessions/session-transcript-reconcile-pool.js";
import { drainCronReceiptAuthority } from "../cron/store/receipt-authority-owner.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { HeartbeatRunner } from "../infra/heartbeat-runner.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { closePluginStateDatabaseAsync } from "../plugin-state/plugin-state-store.js";
import type { GatewayPluginMetadataOwner } from "../plugins/plugin-metadata-lifecycle.js";
import { hasRetainedPluginRuntimeCloseError } from "../plugins/runtime-close-error.js";
import type { createPluginRegistryOwner } from "../plugins/runtime.js";
import { getCanonicalGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import { finalizeActiveDebugProxyCaptures } from "../proxy-capture/runtime-cleanup.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { settlesWithin } from "../shared/settle-within.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { withAgentDatabaseCloseFence } from "../state/openclaw-agent-db-resources.js";
import {
  collectGatewayProcessMemoryUsageMb,
  measureGatewayCloseStep,
  recordGatewayRestartTrace,
} from "./restart-trace.js";
import type { ChatRunState } from "./server-chat-state.js";
import { closeGatewayTransports } from "./server-close-transports.js";
import type { GatewayMaintenanceHandles } from "./server-maintenance-lifecycle.js";
import {
  waitForMediaCleanupDrainsToSettle,
  type MediaCleanupStopResult,
} from "./server-media-cleanup-lifecycle.js";
import type { GatewayCloseOptions } from "./server-public.js";
import { prepareGatewayRunShutdown, type GatewayRunShutdownParams } from "./server-run-shutdown.js";
import {
  recordGatewayShutdownWarning as recordShutdownWarning,
  resolveGatewayShutdownNotice,
} from "./server-shutdown.js";

const shutdownLog = createSubsystemLogger("gateway/shutdown");
const GATEWAY_SHUTDOWN_HOOK_TIMEOUT_MS = 5_000;
const GATEWAY_PRE_RESTART_HOOK_TIMEOUT_MS = 10_000;
const ACTIVE_SESSIONS_SHUTDOWN_DRAIN_TIMEOUT_MS = 2_000;
const RUNTIME_CLOSE_GRACE_MS = 5_000;
type ShutdownResult = {
  durationMs: number;
  warnings: string[];
  processWritersRetired: boolean;
};

function createCloseSteps(reason: string, warnings: string[]) {
  const measureCloseStep = <T>(name: string, run: () => Promise<T> | T) =>
    measureGatewayCloseStep(`restart.close.${name}`, run, [["reason", reason]]);
  const shutdownStep = async (name: string, fn: () => Promise<void> | void, phase = name) => {
    try {
      await measureCloseStep(phase, fn);
    } catch (err: unknown) {
      if (hasRetainedPluginRuntimeCloseError(err)) {
        throw err;
      }
      const detail = err instanceof Error ? err.message : String(err);
      shutdownLog.warn(`${name}: ${detail}`);
      recordShutdownWarning(warnings, name);
    }
  };
  return { measureCloseStep, shutdownStep };
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

export type GatewayCloseParams = {
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
  drainRetainedOpenAiEmbeddingProviders: () => Promise<void>;
  stopGmailWatcher: () => Promise<void>;
  disposeAllCodeModeRuns: () => Promise<void> | void;
  closeProviderTransportDispatcherPool: () => Promise<void>;
  cron: { stop: () => void; stopAndDrain?: () => Promise<void> };
  stopCronMaintenance?: () => Promise<void>;
  heartbeatRunner: HeartbeatRunner;
  maintenance: GatewayMaintenanceHandles | null;
  stopMediaCleanup: () => Promise<MediaCleanupStopResult>;
  agentUnsub: (() => Promise<void> | void) | null;
  heartbeatUnsub: (() => void) | null;
  transcriptUnsub: (() => void) | null;
  lifecycleUnsub: (() => void) | null;
  clients: Set<{
    connect?: { role?: string };
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
  preparePluginRegistryClose: ReturnType<typeof createPluginRegistryOwner>["prepareClose"];
  drainPersistence: () => Promise<void>;
  updateCheckStop?: (() => Promise<void> | void) | null;
  configReloader: { stop: () => Promise<void> };
  getPendingReplyCount: () => number;
};

export type GatewayClosePreparation = {
  start: number;
  notice: ReturnType<typeof resolveGatewayShutdownNotice>;
  restart: boolean;
  warnings: string[];
  cleanupWork: AsyncWorkScope;
  retainReaderTransport?: true;
};

export async function prepareGatewayClose(
  params: GatewayClosePrepareParams,
  opts?: GatewayCloseOptions,
): Promise<GatewayClosePreparation> {
  const start = Date.now();
  const warnings: string[] = [];
  const notice = resolveGatewayShutdownNotice(opts);
  const { reason } = notice;
  const restartExpectedMs = notice.restartExpectedMs ?? null;
  const restart = restartExpectedMs !== null;
  const { measureCloseStep, shutdownStep } = createCloseSteps(reason, warnings);
  const cleanupWork = new AsyncWorkScope();
  // Fence async session-state writes before the first awaited shutdown step.
  fenceSessionSuspensionWritesForGatewayShutdown();
  // Debug-level: the signal handler already announced the stop/restart at
  // info, and the completion line below reports duration and outcome.
  shutdownLog.debug(`shutdown started: ${reason}`);

  const triggerLifecycleHook = (action: "shutdown" | "pre-restart", timeoutMs: number) => {
    const hookName = `gateway:${action}` as const;
    return shutdownStep(
      hookName,
      async () => {
        const event = createInternalHookEvent("gateway", action, hookName, {
          reason,
          restartExpectedMs,
        });
        const hookPromise = cleanupWork.track(() =>
          measureCloseStep(`gateway-${action}-hook`, () => triggerInternalHook(event)),
        );
        void hookPromise.catch(() => undefined);
        if (!(await settlesWithin(hookPromise, timeoutMs))) {
          shutdownLog.warn(`${hookName} hook timed out after ${timeoutMs}ms; continuing shutdown`);
          recordShutdownWarning(warnings, hookName);
        }
      },
      `gateway-${action}-hook-grace`,
    );
  };

  try {
    await shutdownStep("update-check", () => params.updateCheckStop?.());
    await shutdownStep("config-reloader", () => params.configReloader.stop());
    if (!opts?.onProcessExitReady) {
      await triggerLifecycleHook("shutdown", GATEWAY_SHUTDOWN_HOOK_TIMEOUT_MS);
      if (restart) {
        await triggerLifecycleHook("pre-restart", GATEWAY_PRE_RESTART_HOOK_TIMEOUT_MS);
      }
    }
    const drainTimeoutMs =
      typeof opts?.drainTimeoutMs === "number" && Number.isFinite(opts.drainTimeoutMs)
        ? Math.max(0, Math.floor(opts.drainTimeoutMs))
        : 0;
    await measureCloseStep("reply-drain", () =>
      prepareGatewayRunShutdown({
        ...params,
        restart,
        timeoutMs: drainTimeoutMs,
        warnings,
      }),
    );
    // ACPX owns agent-process cleanup; memory retirement must not overtake its drain.
    await shutdownStep("acp-session-manager", () => disposeAcpSessionManager("gateway-shutdown"));
    // Memory owns database borrows independent of stalled model/tool finalizers.
    // The registry retains and later joins this same preparation before retirement.
    const memoryPreparation = cleanupWork.track(() =>
      measureCloseStep("memory-preparation", params.preparePluginRegistryClose),
    );
    void memoryPreparation.catch((error: unknown) => {
      shutdownLog.warn(`memory preparation failed during shutdown: ${formatErrorMessage(error)}`);
      recordShutdownWarning(warnings, "memory-managers");
    });
    if (opts?.onProcessExitReady) {
      await measureCloseStep("terminal-persistence", params.drainPersistence);
      await memoryPreparation;
      // Keep every path fenced through host lock release and exit: a per-path
      // idle receipt alone does not prevent accepted cleanup from reopening it.
      await withAgentDatabaseCloseFence({}, async () => {
        await measureCloseStep("agent-databases", () => closeOpenClawAgentDatabasesAsync());
        await measureCloseStep("process-exit", opts.onProcessExitReady!);
      });
    }
    return {
      start,
      notice,
      restart,
      warnings,
      cleanupWork,
      ...(opts?.retainReaderTransport ? { retainReaderTransport: true as const } : {}),
    };
  } catch (error) {
    await measureCloseStep("preparation-cleanup", () => cleanupWork.drain());
    throw error;
  }
}

export function completeGatewayClose(
  params: GatewayCloseParams,
  preparation: GatewayClosePreparation,
): Promise<ShutdownResult> {
  // Cleanup belongs to shutdown, not the initiating RPC's drained connection scope.
  return preparation.cleanupWork.run(async () => {
    try {
      return await closeGatewayResources(params, preparation);
    } finally {
      await measureGatewayCloseStep("restart.close.cleanup", () => preparation.cleanupWork.drain());
    }
  });
}

async function closeGatewayResources(
  params: GatewayCloseParams,
  preparation: GatewayClosePreparation,
): Promise<ShutdownResult> {
  await measureGatewayCloseStep("restart.close.metadata-begin", () =>
    params.pluginMetadata.beginClose(),
  );
  const { start, notice, restart, warnings, cleanupWork } = preparation;
  const { reason } = notice;
  const restartExpectedMs = notice.restartExpectedMs ?? null;
  let pluginServicesCleanup: Promise<void> | undefined;
  let mediaCleanupStopResult: MediaCleanupStopResult | undefined;
  const resourceCleanupErrors: unknown[] = [];
  const recordResourceCleanupFailure = (error: unknown) => {
    if (hasRetainedPluginRuntimeCloseError(error)) {
      throw error;
    }
    resourceCleanupErrors.push(error);
  };
  let closeFailure: { error: unknown } | undefined;
  const { measureCloseStep, shutdownStep } = createCloseSteps(reason, warnings);
  let processWritersRetired = false;
  const disposeRuntime = async (
    label:
      | "plugin-services"
      | "agent-harnesses"
      | "bundle-mcp"
      | "bundle-lsp"
      | "embedding-providers",
    dispose: () => Promise<void>,
  ) => {
    const disposePromise = cleanupWork
      .track(() => measureCloseStep(label, () => Promise.resolve().then(dispose)))
      .catch((err: unknown) => {
        shutdownLog.warn(`${label} runtime disposal failed during shutdown: ${String(err)}`);
        recordShutdownWarning(warnings, label);
      });
    if (!(await settlesWithin(disposePromise, RUNTIME_CLOSE_GRACE_MS))) {
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
      pluginServicesCleanup = cleanup;
      // A stalled plugin must not prevent later runtime and child-process cleanup.
      await disposeRuntime("plugin-services", () => cleanup);
    }
    await measureCloseStep("channels", async () => {
      const channelIds = params.channelIds ?? listChannelPlugins().map((plugin) => plugin.id);
      for (const channelId of channelIds) {
        await shutdownStep(`channel/${channelId}`, () => params.stopChannel(channelId));
      }
    });
    await shutdownStep("code-mode-runs", () => params.disposeAllCodeModeRuns());
    await disposeRuntime("agent-harnesses", disposeRegisteredAgentHarnesses);
    await shutdownStep("ai-session-resources", () => cleanupSessionResources());
    await shutdownStep("provider-transport-dispatchers", () =>
      params.closeProviderTransportDispatcherPool(),
    );
    await measureCloseStep("bundle-runtimes", async () => {
      await Promise.all([
        disposeRuntime("bundle-mcp", disposeAllSessionMcpRuntimes),
        disposeRuntime("bundle-lsp", params.disposeAllBundleLspRuntimes),
      ]);
    });
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
    // Cron heartbeat runs await this owner's queued wakes after handing off cancellation.
    // Settle those waiters before joining cron so shutdown cannot wait on its own next step.
    await shutdownStep("heartbeat-runner", () => params.heartbeatRunner.stop());
    await shutdownStep("cron", () =>
      params.cron.stopAndDrain ? params.cron.stopAndDrain() : params.cron.stop(),
    );
    await shutdownStep("cron-maintenance", () => params.stopCronMaintenance?.());
    await shutdownStep("cron-receipt-authority", () => drainCronReceiptAuthority());
    if (params.agentUnsub) {
      await shutdownStep("agent-unsub", () => params.agentUnsub!());
    }
    if (params.heartbeatUnsub) {
      await shutdownStep("heartbeat-unsub", () => params.heartbeatUnsub!());
    }
    if (params.transcriptUnsub) {
      await shutdownStep("transcript-unsub", () => params.transcriptUnsub!());
    }
    if (params.lifecycleUnsub) {
      await shutdownStep("lifecycle-unsub", () => params.lifecycleUnsub!());
    }
    params.chatRunState.clear();
    await closeGatewayTransports(params, {
      reason,
      warnings,
      retainReaderTransport: preparation.retainReaderTransport,
    });
    await disposeRuntime("embedding-providers", params.drainRetainedOpenAiEmbeddingProviders);
  } catch (error) {
    closeFailure = { error };
  } finally {
    // Grace lets independent teardown advance; raw cleanup and its descendants
    // still join before registry and shared-state retirement.
    await measureCloseStep("cleanup-work", () => cleanupWork.runWhenIdle(() => {}));
    await pluginServicesCleanup;
    await measureCloseStep("request-entries", () => params.finishRequestEntries?.());
    await measureCloseStep("media-cleanup-drains", waitForMediaCleanupDrainsToSettle);
    // Drain before metadata elects the final Gateway that owns model retirement.
    await measureCloseStep("sdk-work", () => params.drainSdkWork?.());
    const swarmOwner = getCanonicalGatewayContextResolver(params.resolveGatewayContext);
    if (swarmOwner) {
      await measureCloseStep("swarm-scheduler", () =>
        closeSwarmScheduler(swarmOwner).catch(recordResourceCleanupFailure),
      );
    }
    // Owner cleanup releases scheduled work; join it before retiring shared dependencies.
    await measureCloseStep("scheduler", () => params.stopScheduler());
    // A sibling Gateway retains metadata before its registry exists. Only the
    // final owner may retire shared state and process-wide plugin caches.
    try {
      const registryClose = await measureCloseStep("plugin-registry", () =>
        params.closePluginRegistry(async (retireRegistry) => {
          // SDK cleanup can use prepared donors; release its claims before model or registry disposal.
          await measureCloseStep("sdk-resources", () =>
            params.closeSdkResources?.().catch(recordResourceCleanupFailure),
          );
          return measureCloseStep("plugin-metadata", () =>
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
              await measureCloseStep("retirement-cleanup", () => cleanupWork.runWhenIdle(() => {}));
              // Releasing agent leases still writes shared state; keep its owner alive until then.
              await measureCloseStep("agent-databases", closeOpenClawAgentDatabasesAsync);
              await measureCloseStep("debug-proxy", () =>
                finalizeActiveDebugProxyCaptures().catch(recordResourceCleanupFailure),
              );
              if (mediaCleanupStopResult !== undefined) {
                await measureCloseStep("plugin-state-database", closePluginStateDatabaseAsync);
              }
              try {
                await measureCloseStep("global-singletons", () =>
                  drainGlobalSingletonLifecycleState(restart ? "restart" : "close"),
                );
              } finally {
                try {
                  params.clearSecretsRuntimeSnapshot?.();
                } catch {
                  /* ignore */
                }
              }
              processWritersRetired = true;
            }, retireRegistry),
          );
        }),
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
      resourceCleanupErrors.push(error);
    }
  }
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
    throw new AggregateError(resourceCleanupErrors, "Gateway resource cleanup failed", {
      cause: resourceCleanupErrors[0],
    });
  }
  if (closeFailure) {
    throw closeFailure.error;
  }
  if (preparation.retainReaderTransport && warnings.length > 0) {
    throw new Error(`Native reader writer retirement is incomplete: ${warnings.join(", ")}`);
  }
  if (preparation.retainReaderTransport && !processWritersRetired) {
    throw new Error("Native reader retirement still has another process runtime owner");
  }
  return { durationMs, warnings, processWritersRetired };
}
