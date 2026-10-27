import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { notifyOutboundDeliveryEnqueued } from "../infra/delivery-queue-cache.js";
import { captureDeliveryQueueStateContext } from "../infra/delivery-queue-sqlite.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
  hasGatewayContextOwner,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import {
  beginGatewayRestartSignalAdmission,
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { getSpawnBroker, runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { useSpawnBrokerTestFixture } from "../process/spawn-broker/host.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { clearGatewayMaintenanceHandles } from "./server-maintenance-lifecycle.js";
import { registerGatewayCronStartupTests } from "./server-runtime-services.cron.test-support.js";
import {
  createLog,
  createTestCronReconciliation,
  createTestCronState,
  createMaintenanceHandles,
  runtimeServiceMocks as hoisted,
  resetRuntimeServiceMocks,
  waitForFast,
} from "./server-runtime-services.test-harness.js";

const {
  activateGatewayScheduledServices,
  startGatewayChannelHealthMonitor,
  startGatewayCronWithLogging,
} = await import("./server-runtime-services.js");

const cleanupReleases: Array<() => void> = [];
const serviceLifetimes: Array<ReturnType<typeof activateGatewayScheduledServices>> = [];
function hold() {
  const pending = createDeferredCore();
  cleanupReleases.push(() => pending.resolve());
  return pending;
}

describe("server-runtime-services", () => {
  const createBroker = useSpawnBrokerTestFixture(afterEach);
  beforeEach(() => {
    vi.useRealTimers();
    // Gateway test helpers set these at module load. Stub them off so a shared
    // worker's import order cannot silently disable this suite's health monitor.
    vi.stubEnv("OPENCLAW_SKIP_CHANNELS", "");
    vi.stubEnv("OPENCLAW_SKIP_PROVIDERS", "");
    resetGatewayWorkAdmission();
    resetRuntimeServiceMocks();
  });

  afterEach(async () => {
    // Release held work before joining the service owners, including on assertion failure.
    cleanupReleases.splice(0).forEach((release) => release());
    try {
      await Promise.all(
        serviceLifetimes.splice(0).map((services) => services.stopScheduledServices()),
      );
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
      resetGatewayWorkAdmission();
      clearRuntimeConfigSnapshot();
    }
  });

  it.each(["OPENCLAW_SKIP_CHANNELS", "OPENCLAW_SKIP_PROVIDERS"])(
    "keeps channel health recovery disabled when %s suppresses startup",
    (envKey) => {
      vi.stubEnv(envKey, "1");
      const monitor = startGatewayChannelHealthMonitor({
        scheduler: createTestGatewayScheduler(),
        channelManager: {} as never,
      });

      expect(monitor).toBeNull();
      expect(hoisted.startChannelHealthMonitor).not.toHaveBeenCalled();
    },
  );

  registerGatewayCronStartupTests(startGatewayCronWithLogging);

  it("keeps refused cron startup quiet until a fresh lifecycle admits it", async () => {
    vi.useFakeTimers();
    const cron = { start: vi.fn(async () => {}) };
    const cronReconciliation = createTestCronReconciliation();
    const logCron = { error: vi.fn() };
    const params = {
      cronState: createTestCronState(cron),
      cronReconciliation,
      reason: "startup" as const,
      config: {},
      logCron,
    };
    markGatewayRestartDraining("stop (SIGTERM)");
    startGatewayCronWithLogging(params);
    await vi.advanceTimersByTimeAsync(0);
    expect(cron.start).not.toHaveBeenCalled();
    expect(cronReconciliation.complete).not.toHaveBeenCalled();
    expect(logCron.error).not.toHaveBeenCalled();

    resetGatewayWorkAdmission();
    startGatewayCronWithLogging(params);
    await vi.advanceTimersByTimeAsync(0);
    expect(cron.start).toHaveBeenCalledOnce();
    expect(cronReconciliation.complete).toHaveBeenCalledOnce();
    expect(logCron.error).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it.each(["session recovery", "session retry"] as const)(
    "gives standalone scheduled %s its owning Gateway context and broker",
    async (kind) => {
      const broker = await createBroker();
      vi.useFakeTimers();
      const gatewayContext = {
        terminalSessions: {},
        resolveGatewayContext: () => gatewayContext,
      } as never;
      const resolveGatewayContext = () => gatewayContext;
      const admittedOwner = {};
      let observed: unknown = "never-ran";
      let observedClient: unknown = "never-ran";
      let observedBroker: unknown = "never-ran";
      const observe = () => {
        const scope = getPluginRuntimeGatewayRequestScope();
        bindGatewayContextResolver(admittedOwner, scope?.resolveGatewayContext);
        observed = scope?.resolveGatewayContext?.();
        observedClient = scope?.client;
        observedBroker = getSpawnBroker();
        return undefined;
      };
      if (kind === "session recovery") {
        hoisted.recoverPendingProducedSessionDeliveries.mockImplementationOnce(async () =>
          observe(),
        );
      } else {
        hoisted.deliverQueuedSessionDelivery.mockImplementationOnce(async () => observe());
      }
      const { services } = runWithSpawnBroker(broker, () =>
        withPluginRuntimeGatewayRequestScope({ client: { id: "retired-request" } } as never, () =>
          activateScheduledServicesForTest({ resolveGatewayContext }),
        ),
      );
      try {
        await vi.advanceTimersByTimeAsync(1_250);
        await vi.dynamicImportSettled();
        if (kind === "session retry") {
          const runtime = hoisted.startSessionDeliveryRuntime.mock.calls[0]?.[0];
          assert(runtime, "Expected the session delivery runtime to start");
          await runtime.deliver(
            {
              id: "scheduled-retry",
              kind: "agentTurn",
              sessionKey: "agent:main:scheduled-retry",
              message: "Retry the synthetic turn",
              messageId: "scheduled-retry-message",
              enqueuedAt: 1,
              retryCount: 1,
            },
            { queueContext: runtime.queueContext },
          );
        }
        expect(observed).toBe(gatewayContext);
        expect(observedClient).toBeUndefined();
        expect(observedBroker).toBe(broker);
        expect(hasGatewayContextOwner(admittedOwner, resolveGatewayContext)).toBe(true);
        expect(hasGatewayContextOwner(admittedOwner, () => gatewayContext)).toBe(false);
      } finally {
        await services.stopScheduledServices();
      }
    },
  );

  it.each(["neither", "legacy", "recovery"] as const)(
    "joins upstream monitoring, legacy diagnostics and current recovery when %s fails",
    async (failing) => {
      vi.useFakeTimers();
      const legacy = createDeferredCore<number>();
      cleanupReleases.push(() => legacy.resolve(0));
      const recovery = hold();
      const upstream = hold();
      hoisted.stopSessionUpstreamMonitor.mockReturnValueOnce(upstream.promise);
      hoisted.countPendingDeliveryQueueEntries.mockReturnValueOnce(legacy.promise);
      hoisted.recoverPendingDeliveries.mockImplementationOnce(async () => {
        await recovery.promise;
        return { recovered: 0, failed: 0, skippedMaxRetries: 0, deferredBackoff: 0 };
      });
      const { services, log } = activateScheduledServicesForTest();
      await vi.dynamicImportSettled();
      expect(hoisted.recoverPendingDeliveries).toHaveBeenCalledOnce();
      expect(hoisted.drainPendingDeliveries).not.toHaveBeenCalled();
      const failure = new Error(`${failing} failed`);
      if (failing === "legacy") {
        legacy.reject(failure);
      } else if (failing === "recovery") {
        recovery.reject(failure);
      }
      const deliveryStopped = vi.fn();
      const deliveryStopping = services.stopDeliveryRecovery().then(deliveryStopped);
      const stopped = vi.fn();
      const stopping = services.stopScheduledServices();
      expect(services.stopScheduledServices()).toBe(stopping);
      const stopPromise = stopping.then(stopped);
      await vi.advanceTimersByTimeAsync(0);
      expect(deliveryStopped).not.toHaveBeenCalled();
      expect(stopped).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      legacy.resolve(0);
      recovery.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await deliveryStopping;
      expect(deliveryStopped).toHaveBeenCalledOnce();
      expect(stopped).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      upstream.resolve();
      await stopPromise;
      expect(stopped).toHaveBeenCalledOnce();
      expect(hoisted.stopSessionUpstreamMonitor).toHaveBeenCalledOnce();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      if (failing !== "neither") {
        expect(log.error).toHaveBeenCalledWith(`Delivery recovery failed: ${String(failure)}`);
      }
    },
  );

  it("warns but holds shutdown until outbound recovery settles", async () => {
    vi.useFakeTimers();
    const drain = hold();
    hoisted.drainPendingDeliveries.mockReturnValueOnce(drain.promise);
    const log = createLog();
    const { services } = activateScheduledServicesForTest({ log });
    await vi.dynamicImportSettled();
    notifyOutboundDeliveryEnqueued(captureDeliveryQueueStateContext().stateDir);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(hoisted.recoverPendingDeliveries).toHaveBeenCalledOnce();
    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledOnce();

    const firstStopped = vi.fn();
    const secondStopped = vi.fn();
    const firstStop = services.stopDeliveryRecovery().then(firstStopped);
    const secondStop = services.stopDeliveryRecovery().then(secondStopped);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(firstStopped).not.toHaveBeenCalled();
    expect(secondStopped).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    expect(log.child.mock.results[0]?.value.warn).toHaveBeenCalledOnce();
    expect(log.child.mock.results[0]?.value.warn).toHaveBeenCalledWith(
      "delivery recovery is still pending after 5000ms; waiting before runtime teardown",
    );

    await vi.advanceTimersByTimeAsync(15_000);
    expect(hoisted.recoverPendingDeliveries).toHaveBeenCalledOnce();
    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledOnce();
    expect(firstStopped).not.toHaveBeenCalled();
    expect(secondStopped).not.toHaveBeenCalled();
    expect(log.child.mock.results[0]?.value.warn).toHaveBeenCalledOnce();

    drain.resolve();
    await Promise.all([firstStop, secondStop]);
    expect(firstStopped).toHaveBeenCalledOnce();
    expect(secondStopped).toHaveBeenCalledOnce();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it.for(["signal fence", "hard drain"])(
    "stops unadmitted session recovery quietly during %s",
    async (reason) => {
      vi.useFakeTimers();
      const fence = beginGatewayRestartSignalAdmission();
      assert(fence, "Expected restart signal admission fence");
      if (reason === "hard drain") {
        markGatewayRestartDraining("stop (SIGTERM)");
      }
      const { services, log } = activateScheduledServicesForTest();
      cleanupReleases.push(() => fence.rollback());
      await vi.advanceTimersByTimeAsync(1_250);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      const stopped = vi.fn();
      const stopping = services.stopDeliveryRecovery().then(stopped);
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toHaveBeenCalledOnce();
      expect(hoisted.startSessionDeliveryRuntime).not.toHaveBeenCalled();
      expect(hoisted.recoverPendingProducedSessionDeliveries).not.toHaveBeenCalled();
      expect(log.error).not.toHaveBeenCalled();
      await stopping;
    },
  );

  it("resumes pending session recovery when the restart fence rolls back", async () => {
    vi.useFakeTimers();
    const fence = beginGatewayRestartSignalAdmission();
    assert(fence, "Expected restart signal admission fence");
    activateScheduledServicesForTest();
    cleanupReleases.push(() => fence.rollback());
    await vi.advanceTimersByTimeAsync(1_250);
    expect(hoisted.startSessionDeliveryRuntime).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(fence.rollback()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.dynamicImportSettled();
    expect(hoisted.recoverPendingProducedSessionDeliveries).toHaveBeenCalledOnce();
    expect(hoisted.schedulePendingSessionDeliveries).toHaveBeenCalledOnce();
  });

  it.each(
    (["recovery", "scheduling"] as const).flatMap((stage) =>
      (["completion", "AbortError"] as const).map((outcome) => ({ stage, outcome })),
    ),
  )(
    "joins pending session $stage $outcome before scheduled-service shutdown finishes",
    async ({ stage, outcome }) => {
      vi.useFakeTimers();
      const pending = createDeferredCore<undefined>();
      cleanupReleases.push(() => pending.resolve(undefined));
      const operation =
        stage === "recovery"
          ? hoisted.recoverPendingProducedSessionDeliveries
          : hoisted.schedulePendingSessionDeliveries;
      operation.mockReturnValueOnce(pending.promise);
      const { services, log } = activateScheduledServicesForTest();
      await vi.advanceTimersByTimeAsync(1_250);
      await vi.dynamicImportSettled();
      expect(operation).toHaveBeenCalledOnce();
      expect(getActiveGatewayRootWorkCount()).toBe(1);

      const stopped = vi.fn();
      const stopPromise = services.stopScheduledServices().then(stopped);
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).not.toHaveBeenCalled();

      if (outcome === "AbortError") {
        const error = new Error(`admitted ${stage} aborted`);
        error.name = "AbortError";
        pending.reject(error);
      } else {
        pending.resolve(undefined);
      }
      await stopPromise;
      expect(stopped).toHaveBeenCalledOnce();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      if (outcome === "AbortError") {
        expect(log.error).toHaveBeenCalledWith(
          `Session delivery recovery failed: AbortError: admitted ${stage} aborted`,
        );
      } else {
        expect(log.error).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["service", "scheduler"] as const)(
    "joins a pending session import without installing a runtime after %s shutdown",
    async (owner) => {
      const clock = createGatewaySchedulerClock();
      const scheduler = createTestGatewayScheduler(clock.clock);
      const importStarted = createDeferredCore();
      const releaseImport = createDeferredCore();
      const exports = {
        deliverQueuedSessionDelivery: hoisted.deliverQueuedSessionDelivery,
        recoverPendingProducedSessionDeliveries: hoisted.recoverPendingProducedSessionDeliveries,
        settleQueuedSessionDelivery: hoisted.settleQueuedSessionDelivery,
      };
      vi.doMock("./server-restart-sentinel.js", async () => {
        importStarted.resolve();
        await releaseImport.promise;
        return exports;
      });
      const { services, log } = activateScheduledServicesForTest({ scheduler });
      let stopPromise: Promise<void> | undefined;
      let waking: void | Promise<void> = undefined;
      try {
        waking = clock.advanceBy(1_250);
        await importStarted.promise;
        const stopped = vi.fn();
        stopPromise = (
          owner === "service" ? services.stopDeliveryRecovery() : scheduler.stop()
        ).then(stopped);
        await Promise.resolve();
        expect(stopped).not.toHaveBeenCalled();

        releaseImport.resolve();
        await stopPromise;
        await services.stopDeliveryRecovery();
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        expect(hoisted.startSessionDeliveryRuntime).not.toHaveBeenCalled();
        expect(hoisted.recoverPendingProducedSessionDeliveries).not.toHaveBeenCalled();
        expect(log.error).not.toHaveBeenCalled();
      } finally {
        releaseImport.resolve();
        await vi.dynamicImportSettled();
        await services.stopScheduledServices();
        await stopPromise;
        await waking;
        await scheduler.stop();
        vi.doMock("./server-restart-sentinel.js", () => exports);
      }
    },
  );

  it("schedules pending session deliveries when startup recovery fails", async () => {
    vi.useFakeTimers();
    hoisted.recoverPendingProducedSessionDeliveries.mockRejectedValueOnce(
      new Error("database busy"),
    );
    const log = createLog();
    activateScheduledServicesForTest({ log });

    await vi.advanceTimersByTimeAsync(1_250);
    await vi.dynamicImportSettled();

    expect(hoisted.schedulePendingSessionDeliveries).toHaveBeenCalledTimes(1);
    await waitForFast(() =>
      expect(log.error).toHaveBeenCalledWith(
        "Session delivery recovery failed: Error: database busy",
      ),
    );
  });

  it("diagnoses legacy state once and leaves an empty outbound queue idle until enqueue", async () => {
    vi.useFakeTimers();
    const log = createLog();
    const recoveryLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    log.child.mockReturnValue(recoveryLog);
    hoisted.countPendingDeliveryQueueEntries.mockResolvedValue(2);
    const { services } = activateScheduledServicesForTest({ log });
    await vi.dynamicImportSettled();
    expect(hoisted.recoverPendingDeliveries).toHaveBeenCalledOnce();
    expect(recoveryLog.warn).toHaveBeenCalledWith(expect.stringContaining("openclaw doctor --fix"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(hoisted.countPendingDeliveryQueueEntries).toHaveBeenCalledOnce();
    expect(hoisted.recoverPendingDeliveries).toHaveBeenCalledOnce();
    expect(hoisted.drainPendingDeliveries).not.toHaveBeenCalled();
    notifyOutboundDeliveryEnqueued(`${captureDeliveryQueueStateContext().stateDir}/other-state`);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(hoisted.drainPendingDeliveries).not.toHaveBeenCalled();
    notifyOutboundDeliveryEnqueued(captureDeliveryQueueStateContext().stateDir);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledOnce();
    await services.stopDeliveryRecovery();
    notifyOutboundDeliveryEnqueued(captureDeliveryQueueStateContext().stateDir);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledOnce();
  });

  it("reconstructs conversation route authorization for a recovered delivery attempt", async () => {
    vi.useFakeTimers();
    activateScheduledServicesForTest();
    await vi.dynamicImportSettled();
    const recovery = hoisted.recoverPendingDeliveries.mock.calls[0]?.[0];
    assert(recovery, "Expected outbound recovery to start");
    hoisted.deliverOutboundPayloads.mockImplementationOnce(async (params) => {
      await params.withDirectAdapterHandoff?.(async () => []);
      return [];
    });
    const denial = new Error("conversation route reassigned");
    hoisted.withAuthorizedQueuedConversationDelivery.mockImplementationOnce(() => {
      throw denial;
    });

    await expect(
      recovery.deliver({
        cfg: {},
        channel: "reef",
        to: "reef:molty",
        payloads: [{ text: "hello" }],
        conversationDeliveryAttemptAuthority: {
          agentId: "main",
          operationId: "operation-recovery",
          storePath: "/tmp/agent.sqlite",
          routeFingerprint: "route-recovery",
        },
      }),
    ).rejects.toBe(denial);

    expect(hoisted.withAuthorizedQueuedConversationDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        readCurrentConfig: expect.any(Function),
        operationId: "operation-recovery",
        routeFingerprint: "route-recovery",
      }),
      expect.objectContaining({ agentId: "main", storePath: "/tmp/agent.sqlite" }),
      expect.any(Function),
    );
  });

  it("uses the current runtime config when retrying queued outbound deliveries", async () => {
    vi.useFakeTimers();
    const configModule = await import("../config/config.js");
    const reloadedConfig = { channels: { discord: { enabled: false } } };
    const runtimeConfig = vi
      .spyOn(configModule, "getRuntimeConfig")
      .mockReturnValue(reloadedConfig as never);
    const { services } = activateScheduledServicesForTest({
      cfgAtStart: { channels: { discord: { enabled: true } } } as never,
    });

    try {
      await vi.dynamicImportSettled();
      notifyOutboundDeliveryEnqueued(captureDeliveryQueueStateContext().stateDir);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(hoisted.drainPendingDeliveries).toHaveBeenCalledWith(
        expect.objectContaining({ cfg: reloadedConfig }),
        expect.any(Function),
        expect.any(Object),
      );
      const [drain] = hoisted.drainPendingDeliveries.mock.calls[0] ?? [];
      expect(drain?.selectEntry({ channel: "discord" } as never, Date.now())).toEqual({
        match: true,
        bypassBackoff: false,
      });
      expect(runtimeConfig).toHaveBeenCalledOnce();
    } finally {
      await services.stopScheduledServices();
      runtimeConfig.mockRestore();
    }
  });

  it("never overlaps outbound retry drains or admits work between timer firings", async () => {
    vi.useFakeTimers();
    const drain = hold();
    hoisted.drainPendingDeliveries.mockReturnValueOnce(drain.promise);
    activateScheduledServicesForTest();
    await vi.dynamicImportSettled();
    notifyOutboundDeliveryEnqueued(captureDeliveryQueueStateContext().stateDir);

    await vi.advanceTimersByTimeAsync(1_250);
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(3_750);
    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledOnce();
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    for (let i = 0; i < 3; i++) {
      notifyOutboundDeliveryEnqueued(captureDeliveryQueueStateContext().stateDir);
    }

    await vi.advanceTimersByTimeAsync(10_000);
    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledOnce();
    expect(getActiveGatewayRootWorkCount()).toBe(1);

    drain.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledTimes(2);
  });

  it("coalesces late outbound recovery and stops retries with the gateway lifecycle", async () => {
    vi.useFakeTimers();
    hoisted.drainPendingDeliveries.mockImplementation(async (options) => {
      options.onPending?.();
    });
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
    const { services } = activateScheduledServicesForTest({ scheduler });
    try {
      await vi.dynamicImportSettled();
      notifyOutboundDeliveryEnqueued(captureDeliveryQueueStateContext().stateDir);
      await clock.advanceBy(5_000);
      expect(hoisted.drainPendingDeliveries).toHaveBeenCalledOnce();

      await clock.advanceBy(180_000);
      expect(hoisted.drainPendingDeliveries).toHaveBeenCalledTimes(2);
      expect(scheduler.nextWakeAtMs).toBe(clock.clock.now() + 5_000);

      await services.stopScheduledServices();
      await clock.advanceBy(15_000);

      expect(hoisted.drainPendingDeliveries).toHaveBeenCalledTimes(2);
      expect(hoisted.stopSessionUpstreamMonitor).toHaveBeenCalledOnce();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      await services.stopDeliveryRecovery();
      await scheduler.stop();
    }
  });

  it("skips outbound retry ticks while gateway work admission is suspended", async () => {
    vi.useFakeTimers();
    activateScheduledServicesForTest();
    await vi.dynamicImportSettled();
    notifyOutboundDeliveryEnqueued(captureDeliveryQueueStateContext().stateDir);
    await vi.advanceTimersByTimeAsync(1_250);

    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    assert(suspension, "Expected gateway suspension admission to be acquired");
    assert(suspension.commit(), "Expected gateway suspension admission to commit");
    await vi.advanceTimersByTimeAsync(13_750);

    expect(hoisted.drainPendingDeliveries).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    suspension.release();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledOnce();
  });

  it.each(["stopPeriodicTasks", "skillUsageCleanup"] as const)(
    "joins %s before reporting another maintenance owner's cleanup failure",
    async (heldOwner) => {
      vi.useFakeTimers();
      const maintenance = createMaintenanceHandles();
      const held = hold();
      const earlyFailure = new Error("first owner failed");
      const lateFailure = new Error("held owner failed");
      const failingOwner =
        heldOwner === "stopPeriodicTasks" ? "skillUsageCleanup" : "stopPeriodicTasks";
      maintenance[heldOwner].mockReturnValue(held.promise);
      maintenance[failingOwner].mockRejectedValue(earlyFailure);
      const settled = vi.fn();
      const clearing = clearGatewayMaintenanceHandles(maintenance).then(
        settled,
        (error: unknown) => {
          settled();
          return error;
        },
      );
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).not.toHaveBeenCalled();
        held.reject(lateFailure);

        const error = await clearing;
        expect(error).toBeInstanceOf(AggregateError);
        expect(error).toMatchObject({
          errors: expect.arrayContaining([earlyFailure, lateFailure]),
        });
      } finally {
        held.resolve();
        await clearing;
      }
    },
  );

  it("keeps scheduled services disabled for minimal test gateways", async () => {
    activateScheduledServicesForTest({
      minimalTestGateway: true,
    });

    expect(hoisted.recoverPendingDeliveries).not.toHaveBeenCalled();
    expect(hoisted.recoverPendingProducedSessionDeliveries).not.toHaveBeenCalled();

    expect(hoisted.startSessionUpstreamMonitor).not.toHaveBeenCalled();
  });
});

function activateScheduledServicesForTest(
  overrides: Partial<Parameters<typeof activateGatewayScheduledServices>[0]> = {},
) {
  const log = overrides.log ?? createLog();
  const cfgAtStart = overrides.cfgAtStart ?? ({} as never);
  setRuntimeConfigSnapshot(cfgAtStart, cfgAtStart);
  const services = activateGatewayScheduledServices({
    scheduler: createTestGatewayScheduler(vi.isFakeTimers() ? "fake-timers" : undefined),
    minimalTestGateway: false,
    cfgAtStart,
    deps: {} as never,
    sessionDeliveryRecoveryMaxEnqueuedAt: 123,
    ...overrides,
    log,
  });
  serviceLifetimes.push(services);
  return { log, services };
}
