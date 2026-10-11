/**
 * Gateway runtime service lifecycle tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
  hasGatewayContextOwner,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import {
  beginGatewayRestartSignalAdmission,
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
  tryBeginGatewayRootWorkAdmission,
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
  createMaintenanceHandles,
  runtimeServiceMocks as hoisted,
  resetRuntimeServiceMocks,
  waitForFast,
} from "./server-runtime-services.test-harness.js";

const {
  activateGatewayScheduledServices,
  scheduleGatewayIdleTask,
  startGatewayChannelHealthMonitor,
  startGatewayCronWithLogging,
} = await import("./server-runtime-services.js");

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

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetGatewayWorkAdmission();
  });

  it("starts channel health without activating scheduled services", () => {
    startGatewayChannelHealthMonitor({
      scheduler: createTestGatewayScheduler(),
      channelManager: {
        getRuntimeSnapshot: vi.fn(),
        isHealthMonitorEnabled: vi.fn(),
        isAccountListed: vi.fn(() => true),
        isManuallyStopped: vi.fn(),
      } as never,
    });

    expect(hoisted.startChannelHealthMonitor).toHaveBeenCalledTimes(1);
    expect(hoisted.startSessionUpstreamMonitor).not.toHaveBeenCalled();
    expect(hoisted.recoverPendingDeliveries).not.toHaveBeenCalled();
  });

  it.each(["OPENCLAW_SKIP_CHANNELS", "OPENCLAW_SKIP_PROVIDERS"])(
    "keeps channel health recovery disabled when %s suppresses startup",
    (envKey) => {
      const monitor = startGatewayChannelHealthMonitor({
        scheduler: createTestGatewayScheduler(),
        channelManager: {} as never,
        env: { [envKey]: "1" },
      });

      expect(monitor).toBeNull();
      expect(hoisted.startChannelHealthMonitor).not.toHaveBeenCalled();
    },
  );

  registerGatewayCronStartupTests(startGatewayCronWithLogging);

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
        hoisted.recoverPendingRestartContinuationDeliveries.mockImplementationOnce(async () =>
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
          if (!runtime) {
            throw new Error("Expected the session delivery runtime to start");
          }
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
        await services.stopDeliveryRecovery();
        vi.useRealTimers();
      }
    },
  );

  it.each(["neither", "legacy", "recovery"] as const)(
    "joins legacy diagnostics and current recovery before stop when %s fails",
    async (failing) => {
      vi.useFakeTimers();
      const legacy = createDeferredCore<number>();
      const recovery = createDeferredCore();
      hoisted.countPendingDeliveryQueueEntries.mockReturnValueOnce(legacy.promise);
      hoisted.recoverPendingDeliveries.mockImplementationOnce(async () => {
        await recovery.promise;
        return { recovered: 0, failed: 0, skippedMaxRetries: 0, deferredBackoff: 0 };
      });
      const { services, log } = activateScheduledServicesForTest();
      let stopPromise: Promise<void> | undefined;
      try {
        await vi.dynamicImportSettled();
        expect(hoisted.recoverPendingDeliveries).toHaveBeenCalledOnce();
        expect(hoisted.drainPendingDeliveries).not.toHaveBeenCalled();
        const failure = new Error(`${failing} failed`);
        if (failing === "legacy") {
          legacy.reject(failure);
        } else if (failing === "recovery") {
          recovery.reject(failure);
        }
        let stopped = false;
        stopPromise = services.stopDeliveryRecovery().then(() => {
          stopped = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(stopped).toBe(false);
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        legacy.resolve(0);
        recovery.resolve();
        await stopPromise;
        expect(stopped).toBe(true);
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        if (failing !== "neither") {
          expect(log.error).toHaveBeenCalledWith(`Delivery recovery failed: ${String(failure)}`);
        }
      } finally {
        legacy.resolve(0);
        recovery.resolve();
        await (stopPromise ?? services.stopDeliveryRecovery());
        await services.stopScheduledServices();
      }
    },
  );

  it("warns but holds shutdown until outbound recovery settles", async () => {
    vi.useFakeTimers();
    let resolveDrain: (() => void) | undefined;
    hoisted.drainPendingDeliveries.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveDrain = resolve;
        }),
    );
    const log = createLog();
    const { services } = activateScheduledServicesForTest({ log });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(hoisted.recoverPendingDeliveries).toHaveBeenCalledOnce();
    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledOnce();

    let firstStopped = false;
    let secondStopped = false;
    const firstStop = services.stopDeliveryRecovery().then(() => {
      firstStopped = true;
    });
    const secondStop = services.stopDeliveryRecovery().then(() => {
      secondStopped = true;
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(firstStopped).toBe(false);
    expect(secondStopped).toBe(false);
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    expect(log.child.mock.results[0]?.value.warn).toHaveBeenCalledOnce();
    expect(log.child.mock.results[0]?.value.warn).toHaveBeenCalledWith(
      "delivery recovery is still pending after 5000ms; waiting before runtime teardown",
    );

    await vi.advanceTimersByTimeAsync(15_000);
    expect(hoisted.recoverPendingDeliveries).toHaveBeenCalledOnce();
    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledOnce();
    expect(firstStopped).toBe(false);
    expect(secondStopped).toBe(false);
    expect(log.child.mock.results[0]?.value.warn).toHaveBeenCalledOnce();

    if (!resolveDrain) {
      throw new Error("Expected outbound retry drain resolver to be initialized");
    }
    resolveDrain();
    await Promise.all([firstStop, secondStop]);
    expect(firstStopped).toBe(true);
    expect(secondStopped).toBe(true);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    await services.stopScheduledServices();
  });

  it("stops unadmitted session recovery without reopening the restart fence", async () => {
    vi.useFakeTimers();
    const fence = beginGatewayRestartSignalAdmission();
    if (!fence) {
      throw new Error("Expected restart signal admission fence");
    }
    const { services, log } = activateScheduledServicesForTest();
    let stopping: Promise<void> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(1_250);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      let stopped = false;
      stopping = services.stopDeliveryRecovery().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(true);
      expect(hoisted.startSessionDeliveryRuntime).not.toHaveBeenCalled();
      expect(hoisted.recoverPendingRestartContinuationDeliveries).not.toHaveBeenCalled();
      expect(log.error).not.toHaveBeenCalled();
    } finally {
      fence.rollback();
      await services.stopScheduledServices();
      await services.stopDeliveryRecovery();
      await stopping;
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it("resumes pending session recovery when the restart fence rolls back", async () => {
    vi.useFakeTimers();
    const fence = beginGatewayRestartSignalAdmission();
    if (!fence) {
      throw new Error("Expected restart signal admission fence");
    }
    const { services } = activateScheduledServicesForTest();
    try {
      await vi.advanceTimersByTimeAsync(1_250);
      expect(hoisted.startSessionDeliveryRuntime).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(fence.rollback()).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      await vi.dynamicImportSettled();
      expect(hoisted.recoverPendingRestartContinuationDeliveries).toHaveBeenCalledOnce();
      expect(hoisted.schedulePendingSessionDeliveries).toHaveBeenCalledOnce();
    } finally {
      fence.rollback();
      await services.stopScheduledServices();
      await services.stopDeliveryRecovery();
      await vi.advanceTimersByTimeAsync(0);
    }
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
      const operation =
        stage === "recovery"
          ? hoisted.recoverPendingRestartContinuationDeliveries
          : hoisted.schedulePendingSessionDeliveries;
      operation.mockReturnValueOnce(pending.promise);
      const { services, log } = activateScheduledServicesForTest();
      let stopPromise: Promise<void> | undefined;
      try {
        await vi.advanceTimersByTimeAsync(1_250);
        await vi.dynamicImportSettled();
        expect(operation).toHaveBeenCalledOnce();
        expect(getActiveGatewayRootWorkCount()).toBe(1);

        let stopped = false;
        stopPromise = services.stopScheduledServices().then(() => {
          stopped = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(stopped).toBe(false);

        if (outcome === "AbortError") {
          const error = new Error(`admitted ${stage} aborted`);
          error.name = "AbortError";
          pending.reject(error);
        } else {
          pending.resolve(undefined);
        }
        await stopPromise;
        expect(stopped).toBe(true);
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        if (outcome === "AbortError") {
          expect(log.error).toHaveBeenCalledWith(
            `Session delivery recovery failed: AbortError: admitted ${stage} aborted`,
          );
        } else {
          expect(log.error).not.toHaveBeenCalled();
        }
      } finally {
        pending.resolve(undefined);
        await services.stopScheduledServices();
        await services.stopDeliveryRecovery();
        await stopPromise;
        await vi.advanceTimersByTimeAsync(0);
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
        recoverPendingRestartContinuationDeliveries:
          hoisted.recoverPendingRestartContinuationDeliveries,
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
        let stopped = false;
        stopPromise = (
          owner === "service" ? services.stopDeliveryRecovery() : scheduler.stop()
        ).then(() => {
          stopped = true;
        });
        await Promise.resolve();
        expect(stopped).toBe(false);

        releaseImport.resolve();
        await stopPromise;
        await services.stopDeliveryRecovery();
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        expect(hoisted.startSessionDeliveryRuntime).not.toHaveBeenCalled();
        expect(hoisted.recoverPendingRestartContinuationDeliveries).not.toHaveBeenCalled();
        expect(log.error).not.toHaveBeenCalled();
      } finally {
        releaseImport.resolve();
        await vi.dynamicImportSettled();
        await services.stopScheduledServices();
        await services.stopDeliveryRecovery();
        await stopPromise;
        await waking;
        await scheduler.stop();
        vi.doMock("./server-restart-sentinel.js", () => exports);
      }
    },
  );

  it("schedules pending session deliveries when startup recovery fails", async () => {
    vi.useFakeTimers();
    hoisted.recoverPendingRestartContinuationDeliveries.mockRejectedValueOnce(
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

  it("diagnoses legacy state once while keeping current delivery recovery running", async () => {
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
    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledTimes(3);
    await services.stopDeliveryRecovery();
    await services.stopScheduledServices();
  });

  it("reconstructs conversation route authorization for a recovered delivery attempt", async () => {
    vi.useFakeTimers();
    const { services } = activateScheduledServicesForTest();
    await vi.dynamicImportSettled();
    const recovery = hoisted.recoverPendingDeliveries.mock.calls[0]?.[0];
    if (!recovery) {
      throw new Error("Expected outbound recovery to start");
    }
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
    await services.stopScheduledServices();
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
    let finishDrain: (() => void) | undefined;
    hoisted.drainPendingDeliveries.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDrain = resolve;
        }),
    );
    const { services } = activateScheduledServicesForTest();

    await vi.advanceTimersByTimeAsync(1_250);
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(3_750);
    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledOnce();
    expect(getActiveGatewayRootWorkCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledOnce();
    expect(getActiveGatewayRootWorkCount()).toBe(1);

    if (!finishDrain) {
      throw new Error("Expected the outbound retry drain to be pending");
    }
    finishDrain();
    await vi.advanceTimersByTimeAsync(0);
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledTimes(2);
    await services.stopScheduledServices();
  });

  it("coalesces late outbound recovery and stops retries with the gateway lifecycle", async () => {
    vi.useFakeTimers();
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
    const { services } = activateScheduledServicesForTest({ scheduler });
    try {
      await vi.dynamicImportSettled();
      await clock.advanceBy(5_000);
      expect(hoisted.drainPendingDeliveries).toHaveBeenCalledOnce();

      await clock.advanceBy(180_000);
      expect(hoisted.drainPendingDeliveries).toHaveBeenCalledTimes(2);
      expect(scheduler.nextWakeAtMs).toBe(clock.clock.now() + 5_000);

      await services.stopScheduledServices();
      await services.stopDeliveryRecovery();
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
    const { services } = activateScheduledServicesForTest();
    await vi.advanceTimersByTimeAsync(1_250);

    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    if (!suspension?.commit()) {
      throw new Error("Expected gateway suspension admission to be acquired");
    }
    await vi.advanceTimersByTimeAsync(13_750);

    expect(hoisted.drainPendingDeliveries).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    suspension.release();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledOnce();
    await services.stopScheduledServices();
  });

  it("retries a scheduled idle task while request work is active", async () => {
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
    const admission = tryBeginGatewayRootWorkAdmission();
    if (!admission) {
      throw new Error("Expected request work admission");
    }
    const activeRootCounts: number[] = [];
    const run = vi.fn(async () => {
      activeRootCounts.push(getActiveGatewayRootWorkCount());
    });

    scheduleGatewayIdleTask({
      id: "test:idle",
      scheduler,
      delayMs: 25,
      retryDelayMs: 50,
      isClosing: () => false,
      isBusy: () => getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0,
      run,
      log: createLog(),
      errorMessage: "idle task failed",
    });

    await clock.advanceBy(25);
    expect(run).not.toHaveBeenCalled();
    admission.release();
    await clock.advanceBy(49);
    expect(run).not.toHaveBeenCalled();
    await clock.advanceBy(1);
    expect(run).toHaveBeenCalledOnce();
    expect(activeRootCounts).toEqual([1]);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it.each(["stopPeriodicTasks", "skillUsageCleanup"] as const)(
    "joins %s before reporting another maintenance owner's cleanup failure",
    async (heldOwner) => {
      vi.useFakeTimers();
      const maintenance = createMaintenanceHandles();
      const held = createDeferredCore();
      const earlyFailure = new Error("first owner failed");
      const lateFailure = new Error("held owner failed");
      const failingOwner =
        heldOwner === "stopPeriodicTasks" ? "skillUsageCleanup" : "stopPeriodicTasks";
      maintenance[heldOwner].mockReturnValue(held.promise);
      maintenance[failingOwner].mockRejectedValue(earlyFailure);
      let settled = false;
      const clearing = clearGatewayMaintenanceHandles(maintenance).then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
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
    const services = activateGatewayScheduledServices({
      scheduler: createTestGatewayScheduler(),
      minimalTestGateway: true,
      cfgAtStart: {} as never,
      deps: {} as never,
      sessionDeliveryRecoveryMaxEnqueuedAt: 123,
      log: createLog(),
    });

    expect(hoisted.recoverPendingDeliveries).not.toHaveBeenCalled();
    expect(hoisted.recoverPendingRestartContinuationDeliveries).not.toHaveBeenCalled();

    await services.stopScheduledServices();
    expect(hoisted.stopSessionUpstreamMonitor).not.toHaveBeenCalled();
  });
});

function activateScheduledServicesForTest(
  overrides: Partial<Parameters<typeof activateGatewayScheduledServices>[0]> = {},
) {
  const log = overrides.log ?? createLog();
  const cfgAtStart = overrides.cfgAtStart ?? ({} as never);
  const services = activateGatewayScheduledServices({
    scheduler: createTestGatewayScheduler(vi.isFakeTimers() ? "fake-timers" : undefined),
    minimalTestGateway: false,
    cfgAtStart,
    deps: {} as never,
    sessionDeliveryRecoveryMaxEnqueuedAt: 123,
    ...overrides,
    log,
  });
  return { log, services };
}
