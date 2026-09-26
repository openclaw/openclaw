// Gateway post-ready runtime services.
// Starts delayed maintenance, cron, heartbeat, recovery, and pricing refresh work.
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureDeliveryQueueStateContext,
  resolveDeliveryQueueStateEnv,
  type DeliveryQueueStateContext,
} from "../infra/delivery-queue-sqlite.js";
import { computeBackoffMs } from "../infra/delivery-recovery.shared.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { resolveHeartbeatAgents, resolveHeartbeatIntervalMs } from "../infra/heartbeat-config.js";
import type { runHeartbeatOnce } from "../infra/heartbeat-runner-run.js";
import { startHeartbeatRunner, type HeartbeatRunner } from "../infra/heartbeat-runner-scheduler.js";
import { getHeartbeatWakeAbortSignal } from "../infra/heartbeat-wake.js";
import type { DeliverOutboundPayloadsParams } from "../infra/outbound/deliver.js";
import {
  schedulePendingSessionDeliveries,
  startSessionDeliveryRuntime,
} from "../infra/session-delivery-queue-runtime.js";
import {
  isGatewayWorkAdmissionClosed,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { startSessionUpstreamMonitor } from "../sessions/session-upstream-monitor.js";
import { runInDetachedAsyncContext } from "../shared/async-work-scope.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveSkillWorkshopConfig } from "../skills/workshop/config.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { assertQueuedConversationDeliveryAttemptAuthorized } from "./conversation-route-ownership.js";
import {
  createScheduledGatewayRunner,
  fenceScheduledGatewayContextResolver,
} from "./scheduled-run-gateway-context.js";
import type { GatewayCronReconciliation } from "./server-cron-reconciled.js";
import type { GatewayCronState } from "./server-cron.js";
import {
  clearGatewayMaintenanceHandles,
  type GatewayMaintenanceHandles,
} from "./server-maintenance-lifecycle.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import {
  createNoopHeartbeatRunner,
  type GatewayRuntimeServiceLogger,
} from "./server-runtime-service-shared.js";
export { scheduleGatewayIdleTask, type GatewayIdleTaskHandle } from "./server-idle-task.js";
export {
  startGatewayChannelHealthMonitor,
  type GatewayChannelManager,
} from "./server-runtime-startup-services.js";

const loadHeartbeatExecution = createLazyRuntimeModule(
  () => import("../infra/heartbeat-runner-run.js"),
);

type GatewayPostReadyLogger = {
  warn: (message: string) => void;
};

/** Starts cron without making the surrounding startup or reload transaction wait. */
export function startGatewayCronWithLogging(params: {
  cronState: GatewayCronState;
  cronReconciliation: GatewayCronReconciliation;
  reason: "startup" | "reload";
  config: OpenClawConfig;
  afterStart?: () => Promise<void>;
  onStartError?: (error: unknown) => void;
  logCron: { error: (message: string) => void };
}): void {
  const reconciliation = params.cronReconciliation.arm({
    reason: params.reason,
    config: params.config,
    cronState: params.cronState,
  });
  void runInDetachedAsyncContext(() =>
    runWithGatewayIndependentRootWorkAdmission(async () => {
      try {
        await params.cronState.cron.start();
        await params.afterStart?.();
        await reconciliation.complete();
      } catch (err) {
        params.logCron.error(`failed to start: ${String(err)}`);
        // Recovery callbacks must run before this independent root releases its
        // admission fence; restart and suspension cannot race past this point.
        params.onStartError?.(err);
      }
    }, "runtime:cron-start").catch((err: unknown) =>
      params.logCron.error(`failed to enter start root: ${String(err)}`),
    ),
  );
}

/** Schedules post-ready maintenance and cleans up if shutdown wins the race. */
export function scheduleGatewayPostReadyMaintenance(params: {
  scheduler: GatewayScheduler;
  signal: AbortSignal;
  delayMs: number;
  isClosing: () => boolean;
  startMaintenance: () => Promise<GatewayMaintenanceHandles | null>;
  applyMaintenance: (maintenance: GatewayMaintenanceHandles) => Promise<void> | void;
  shouldStartCron: () => boolean;
  markCronStartHandled: () => void;
  cronState: GatewayCronState;
  cronReconciliation: GatewayCronReconciliation;
  cronConfig: OpenClawConfig;
  logCron: { error: (message: string) => void };
  log: GatewayPostReadyLogger;
  recordPostReadyMemory: () => void;
}): void {
  params.scheduler.schedule({
    id: "startup:maintenance",
    delayMs: params.delayMs,
    run: () => {
      if (params.isClosing()) {
        return undefined;
      }
      return runWithGatewayIndependentRootWorkAdmission(
        async () => {
          try {
            if (!params.isClosing()) {
              const maintenance = await params.startMaintenance();
              if (params.isClosing()) {
                // Startup may publish maintenance after shutdown has already fenced new work.
                await clearGatewayMaintenanceHandles(maintenance);
              } else if (maintenance) {
                await params.applyMaintenance(maintenance);
              }
            }
          } catch (err) {
            params.log.warn(`gateway post-ready maintenance startup failed: ${String(err)}`);
          }
          if (!params.isClosing() && params.shouldStartCron()) {
            params.markCronStartHandled();
            startGatewayCronWithLogging({
              cronState: params.cronState,
              cronReconciliation: params.cronReconciliation,
              reason: "startup",
              config: params.cronConfig,
              logCron: params.logCron,
            });
          }
          if (!params.isClosing()) {
            params.recordPostReadyMemory();
          }
        },
        "runtime:maintenance",
        params.signal,
      ).catch((err: unknown) => {
        const ownedCancellation =
          params.signal.aborted &&
          (err === params.signal.reason ||
            (err instanceof Error && err.cause === params.signal.reason));
        if (!ownedCancellation) {
          params.log.warn(`gateway post-ready maintenance deferred task failed: ${String(err)}`);
        }
      });
    },
  });
}

const RECOVERY_SHUTDOWN_STILL_PENDING_WARN_MS = 5_000;

function startPendingOutboundDeliveryRecovery(params: {
  scheduler: GatewayScheduler;
  cfg: OpenClawConfig;
  log: GatewayRuntimeServiceLogger;
}): () => Promise<void> {
  const recoveryContext = captureDeliveryQueueStateContext();
  let stopped = false;
  let initialPass = true;
  let inFlight: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let logRecovery: ReturnType<GatewayRuntimeServiceLogger["child"]> | undefined;

  const recover = (): Promise<void> | undefined => {
    if (stopped || inFlight || isGatewayWorkAdmissionClosed()) {
      return undefined;
    }
    const recovery = runWithGatewayIndependentRootWorkAdmission(async () => {
      if (stopped) {
        return;
      }
      const { drainPendingDeliveriesCore, recoverPendingDeliveries } =
        await import("../infra/outbound/delivery-queue-recovery.js");
      const { deliverOutboundPayloadsInternal } = await import("../infra/outbound/deliver.js");
      if (stopped) {
        return;
      }
      const deliverWithCurrentConversationAuthority = async (
        deliveryParams: DeliverOutboundPayloadsParams,
        stateContext?: DeliveryQueueStateContext,
      ) => {
        const completion = deliveryParams.deliveryCompletion;
        const attemptAuthority =
          completion?.kind === "conversation"
            ? completion
            : deliveryParams.conversationDeliveryAttemptAuthority;
        if (!attemptAuthority) {
          return await deliverOutboundPayloadsInternal(deliveryParams, stateContext);
        }
        return await deliverOutboundPayloadsInternal(
          {
            ...deliveryParams,
            onDeliveryAttempt: async () => {
              await deliveryParams.onDeliveryAttempt?.();
              if (!attemptAuthority.routeFingerprint) {
                return;
              }
              await assertQueuedConversationDeliveryAttemptAuthorized(
                {
                  readCurrentConfig: getRuntimeConfig,
                  operationId: attemptAuthority.operationId,
                  routeFingerprint: attemptAuthority.routeFingerprint,
                },
                {
                  agentId: attemptAuthority.agentId,
                  ...(attemptAuthority.storePath ? { storePath: attemptAuthority.storePath } : {}),
                  env: resolveDeliveryQueueStateEnv(
                    deliveryParams.deliveryQueueStateDir,
                    stateContext,
                  ),
                },
              );
            },
          },
          stateContext,
        );
      };
      logRecovery ??= params.log.child("delivery-recovery");
      if (initialPass) {
        const cfg = params.cfg;
        initialPass = false;
        const { countPendingDeliveryQueueEntries } =
          await import("../infra/delivery-queue-sqlite.js");
        const {
          LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
          OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
          OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
        } = await import("../infra/outbound/delivery-queue-namespaces.js");
        const remaining = countPendingDeliveryQueueEntries(
          [
            LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
            OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
            OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
          ],
          undefined,
          recoveryContext,
        );
        const { listLegacyDeliveryQueueArtifacts } =
          await import("../infra/delivery-queue-legacy-files.js");
        const legacyFiles = listLegacyDeliveryQueueArtifacts(recoveryContext.stateDir);
        if (remaining > 0 || legacyFiles.length > 0) {
          logRecovery.warn(
            `${remaining} legacy outbound deliveries and ${legacyFiles.length} legacy queue files need repair. Stop the Gateway and run openclaw doctor --fix.`,
          );
        }
        await recoverPendingDeliveries(
          {
            deliver: deliverWithCurrentConversationAuthority,
            log: logRecovery,
            cfg,
            shouldContinue: () => !stopped,
          },
          deliverWithCurrentConversationAuthority,
          recoveryContext,
        );
        return;
      }
      // Normal retries use fresh config so revoked accounts cannot inherit the
      // authority captured at gateway startup.
      await drainPendingDeliveriesCore(
        {
          drainKey: "gateway:outbound",
          logLabel: "Outbound delivery retry",
          cfg: getRuntimeConfig(),
          log: logRecovery,
          deliver: deliverWithCurrentConversationAuthority,
          selectEntry: () => ({ match: true, bypassBackoff: false }),
          shouldContinue: () => !stopped,
        },
        deliverWithCurrentConversationAuthority,
        recoveryContext,
      );
    }, "runtime:delivery-recovery").catch((err: unknown) =>
      params.log.error(`Delivery recovery failed: ${String(err)}`),
    );
    const settled: Promise<void> = recovery.finally(() => {
      if (inFlight === settled) {
        inFlight = null;
      }
    });
    inFlight = settled;
    return settled;
  };

  // Match the queue's first backoff window without holding admission between
  // ticks; otherwise suspended/restarting gateways retain invisible work.
  const retryJob = params.scheduler.schedule({
    id: "delivery:outbound-recovery",
    delayMs: computeBackoffMs(1),
    everyMs: computeBackoffMs(1),
    run: recover,
  });
  void recover();
  return () => {
    stopped = true;
    retryJob.cancel();
    if (stopPromise) {
      return stopPromise;
    }
    const recovery = inFlight;
    if (!recovery) {
      stopPromise = Promise.resolve();
      return stopPromise;
    }
    const stillPendingTimer = setTimeout(() => {
      (logRecovery ??= params.log.child("delivery-recovery")).warn(
        `delivery recovery is still pending after ${RECOVERY_SHUTDOWN_STILL_PENDING_WARN_MS}ms; waiting before runtime teardown`,
      );
    }, RECOVERY_SHUTDOWN_STILL_PENDING_WARN_MS);
    stillPendingTimer.unref?.();
    // Provider dispatch is not generically cancellable. Keep its runtime alive
    // until the admitted recovery settles; the process watchdog owns forced exit.
    stopPromise = recovery.finally(() => {
      clearTimeout(stillPendingTimer);
    });
    return stopPromise;
  };
}

function startPendingSessionDeliveryRuntime(params: {
  deps: import("../cli/deps.types.js").CliDeps;
  log: GatewayRuntimeServiceLogger;
  maxEnqueuedAt: number;
  resolveGatewayContext?: GatewayContextResolver;
}): () => Promise<void> {
  const queueContext = captureOpenClawStateWorkerContext();
  const controller = new AbortController();
  const { signal } = controller;
  let recovery: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let stopRuntime: (() => Promise<void>) | undefined;
  // Delay session continuation recovery so the gateway has time to publish ready state and
  // request routing before replaying restart-sentinel deliveries.
  const timer = setTimeout(() => {
    recovery = runWithGatewayIndependentRootWorkAdmission(
      async () => {
        const {
          deliverQueuedSessionDelivery,
          recoverPendingRestartContinuationDeliveries,
          settleQueuedSessionDelivery,
        } = await import("./server-restart-sentinel.js");
        if (signal.aborted) {
          return;
        }
        const logRecovery = params.log.child("session-delivery-recovery");
        stopRuntime = startSessionDeliveryRuntime({
          queueContext,
          deliver: (entry, { queueContext: deliveryContext }) =>
            deliverQueuedSessionDelivery({
              deps: params.deps,
              entry,
              queueContext: deliveryContext,
              ...(params.resolveGatewayContext
                ? { resolveGatewayContext: params.resolveGatewayContext }
                : {}),
            }),
          log: logRecovery,
          onSettled: settleQueuedSessionDelivery,
        });
        try {
          await recoverPendingRestartContinuationDeliveries({
            deps: params.deps,
            queueContext,
            log: logRecovery,
            maxEnqueuedAt: params.maxEnqueuedAt,
            ...(params.resolveGatewayContext
              ? { resolveGatewayContext: params.resolveGatewayContext }
              : {}),
          });
        } finally {
          // Recovery and scheduling are independent safeguards. A transient
          // recovery failure must not leave persisted rows without timers.
          if (!signal.aborted) {
            await schedulePendingSessionDeliveries();
          }
        }
      },
      "runtime:session-delivery-recovery",
      signal,
    ).catch((err: unknown) => {
      const ownedCancellation =
        signal.aborted &&
        (err === signal.reason || (err instanceof Error && err.cause === signal.reason));
      if (!ownedCancellation) {
        params.log.error(`Session delivery recovery failed: ${String(err)}`);
      }
    });
  }, 1_250);
  timer.unref?.();
  return () => {
    // Cancel queued admission, but join imports and work already admitted before their runtime closes.
    controller.abort();
    clearTimeout(timer);
    stopPromise ??= Promise.all([recovery, stopRuntime?.()]).then(() => {});
    return stopPromise;
  };
}

/** Activates background gateway services after core runtime startup is ready. */
export function activateGatewayScheduledServices(params: {
  scheduler: GatewayScheduler;
  minimalTestGateway: boolean;
  cfgAtStart: OpenClawConfig;
  deps: import("../cli/deps.types.js").CliDeps;
  sessionDeliveryRecoveryMaxEnqueuedAt: number;
  cronEnabled: boolean;
  log: GatewayRuntimeServiceLogger;
  resolveGatewayContext?: GatewayContextResolver;
}): { heartbeatRunner: HeartbeatRunner; stopDeliveryRecovery: () => Promise<void> } {
  if (params.minimalTestGateway) {
    // Minimal gateways keep handles callable but inert so tests can share shutdown paths with
    // production starts without launching background loops.
    return {
      heartbeatRunner: createNoopHeartbeatRunner(),
      stopDeliveryRecovery: async () => {},
    };
  }
  const { scheduler } = params;
  if (
    !params.cronEnabled &&
    resolveHeartbeatAgents(params.cfgAtStart).some((agent) =>
      Boolean(resolveHeartbeatIntervalMs(params.cfgAtStart, undefined, agent.heartbeat)),
    )
  ) {
    params.log
      .child("heartbeat")
      .warn(
        "scheduled heartbeats are disabled because the cron scheduler is disabled; enable cron and restart the gateway",
      );
  }
  if (
    !params.cronEnabled &&
    resolveSkillWorkshopConfig(params.cfgAtStart).autonomous.mode === "auto"
  ) {
    params.log
      .child("skill-workshop")
      .warn(
        "scheduled skill collection reviews are disabled because the cron scheduler is disabled; enable cron and restart the gateway",
      );
  }
  // Scheduled heartbeat wakes fire from a timer with no Gateway request, so
  // without this the turn runs contextless and trusted built-in tools fail.
  const heartbeatGatewayContextResolver = fenceScheduledGatewayContextResolver(
    params.resolveGatewayContext,
  );
  const runScheduledHeartbeat = createScheduledGatewayRunner(heartbeatGatewayContextResolver);
  let heartbeatStopped = false;
  const heartbeatRunner = startHeartbeatRunner({
    cfg: params.cfgAtStart,
    readCurrentConfig: getRuntimeConfig,
    ...(heartbeatGatewayContextResolver
      ? {
          runOnce: async (opts: Parameters<typeof runHeartbeatOnce>[0]) => {
            const wakeSignal = getHeartbeatWakeAbortSignal();
            const { runHeartbeatOnce } = await loadHeartbeatExecution();
            // A stopped service or replaced wake must not enter execution after
            // the import settles; the wake owner handles canceled work.
            if (heartbeatStopped || wakeSignal?.aborted) {
              return { status: "skipped", reason: "disabled" };
            }
            return await runScheduledHeartbeat(async () => await runHeartbeatOnce(opts));
          },
        }
      : {}),
  });
  const sessionUpstreamMonitor = startSessionUpstreamMonitor({ scheduler });
  const stopSessionDeliveryRuntime = startPendingSessionDeliveryRuntime({
    deps: params.deps,
    log: params.log,
    maxEnqueuedAt: params.sessionDeliveryRecoveryMaxEnqueuedAt,
    ...(params.resolveGatewayContext
      ? { resolveGatewayContext: params.resolveGatewayContext }
      : {}),
  });
  const stopOutboundDeliveryRecovery = startPendingOutboundDeliveryRecovery({
    scheduler,
    cfg: params.cfgAtStart,
    log: params.log,
  });
  let deliveryRecoveryStopPromise: Promise<void> | undefined;
  const stopDeliveryRecovery = () => {
    // Both owners fence synchronously before the close prelude awaits either.
    deliveryRecoveryStopPromise ??= Promise.all([
      stopOutboundDeliveryRecovery(),
      stopSessionDeliveryRuntime(),
    ]).then(() => {});
    return deliveryRecoveryStopPromise;
  };
  const heartbeatRunnerWithUpstreamMonitor: HeartbeatRunner = {
    updateConfig: heartbeatRunner.updateConfig,
    stop: () => {
      heartbeatStopped = true;
      void stopDeliveryRecovery();
      void sessionUpstreamMonitor.stop();
      heartbeatRunner.stop();
    },
  };
  return {
    heartbeatRunner: heartbeatRunnerWithUpstreamMonitor,
    stopDeliveryRecovery,
  };
}
