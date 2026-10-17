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

function enqueueOutbound() {
  notifyOutboundDeliveryEnqueued(captureDeliveryQueueStateContext().stateDir);
}

async function advanceOutbound(ms: number, drains: number, activeRoots?: number) {
  await vi.advanceTimersByTimeAsync(ms);
  expect(hoisted.drainPendingDeliveries).toHaveBeenCalledTimes(drains);
  if (activeRoots !== undefined) {
    expect(getActiveGatewayRootWorkCount()).toBe(activeRoots);
  }
}

async function enqueueAndAdvanceOutbound(ms: number, drains: number) {
  enqueueOutbound();
  await advanceOutbound(ms, drains);
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

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetGatewayWorkAdmission();
    clearRuntimeConfigSnapshot();
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

  it.each([
    { warns: true, cfgAtStart: { skills: { workshop: { autonomous: { mode: "off" } } } } },
    {
      warns: false,
      cfgAtStart: {
        agents: { defaults: { heartbeat: { every: "0m" } } },
        skills: { workshop: { autonomous: { mode: "auto" } } },
      },
    },
  ] as const)("reports disabled-cron heartbeat warning: $warns", ({ warns, cfgAtStart }) => {
    const log = createLog();
    log.child.mockReturnValue(log);
    activateScheduledServicesForTest({ cfgAtStart, cronEnabled: false, log });
    if (warns) {
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("cron scheduler is disabled"));
    } else {
      expect(log.warn).not.toHaveBeenCalled();
    }
  });

  registerGatewayCronStartupTests(startGatewayCronWithLogging);

  it.each(["heartbeat", "session recovery", "session retry"] as const)(
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
      if (kind === "heartbeat") {
        hoisted.runHeartbeatOnce.mockImplementationOnce(async () => {
          observe();
          return { status: "ran", durationMs: 1 };
        });
      } else if (kind === "session recovery") {
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
        if (kind === "heartbeat") {
          const runnerParams = hoisted.startHeartbeatRunner.mock.calls[0]?.[0];
          await runnerParams?.runOnce?.({} as never);
        } else {
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
        }
        expect(observed).toBe(gatewayContext);
        expect(observedClient).toBeUndefined();
        expect(observedBroker).toBe(broker);
        expect(hasGatewayContextOwner(admittedOwner, resolveGatewayContext)).toBe(true);
        expect(hasGatewayContextOwner(admittedOwner, () => gatewayContext)).toBe(false);
      } finally {
        services.heartbeatRunner.stop();
        await services.stopDeliveryRecovery();
        vi.useRealTimers();
      }
    },
  );

  it.each(["neither", "legacy", "recovery"] as const)(
    "joins legacy diagnostics and current recovery before stop when %s fails",
    async (failing) => {
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
        const stopped = vi.fn<() => void>();
        stopPromise = services.stopDeliveryRecovery().then(stopped);
        await vi.advanceTimersByTimeAsync(0);
        expect(stopped).not.toHaveBeenCalled();
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        legacy.resolve(0);
        recovery.resolve();
        await stopPromise;
        expect(stopped).toHaveBeenCalledOnce();
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        if (failing !== "neither") {
          expect(log.error).toHaveBeenCalledWith(`Delivery recovery failed: ${String(failure)}`);
        }
      } finally {
        legacy.resolve(0);
        recovery.resolve();
        await (stopPromise ?? services.stopDeliveryRecovery());
        services.heartbeatRunner.stop();
      }
    },
  );

  it("warns but holds shutdown until outbound recovery settles", async () => {
    const drain = createDeferredCore();
    hoisted.drainPendingDeliveries.mockReturnValueOnce(drain.promise);
    const log = createLog();
    const { services } = activateScheduledServicesForTest({ log });
    await vi.dynamicImportSettled();
    enqueueOutbound();
    await vi.advanceTimersByTimeAsync(5_000);

    const firstStopped = vi.fn<() => void>();
    const secondStopped = vi.fn<() => void>();
    const firstStop = services.stopDeliveryRecovery().then(firstStopped);
    const secondStop = services.stopDeliveryRecovery().then(secondStopped);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(getActiveGatewayRootWorkCount()).toBe(1);
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
    services.heartbeatRunner.stop();
  });

  it.each(["stop", "resume"] as const)(
    "%s pending session recovery at the restart fence",
    async (action) => {
      const fence = beginGatewayRestartSignalAdmission();
      if (!fence) {
        throw new Error("Expected restart signal admission fence");
      }
      const { services, log } = activateScheduledServicesForTest();
      let stopping: Promise<void> | undefined;
      try {
        await vi.advanceTimersByTimeAsync(1_250);
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        if (action === "stop") {
          const stopped = vi.fn<() => void>();
          stopping = services.stopDeliveryRecovery().then(stopped);
          await vi.advanceTimersByTimeAsync(0);
          expect(stopped).toHaveBeenCalledOnce();
          expect(hoisted.startSessionDeliveryRuntime).not.toHaveBeenCalled();
          expect(hoisted.recoverPendingRestartContinuationDeliveries).not.toHaveBeenCalled();
          expect(log.error).not.toHaveBeenCalled();
        } else {
          expect(hoisted.startSessionDeliveryRuntime).not.toHaveBeenCalled();
          expect(fence.rollback()).toBe(true);
          await vi.advanceTimersByTimeAsync(0);
          await vi.dynamicImportSettled();
          expect(hoisted.recoverPendingRestartContinuationDeliveries).toHaveBeenCalledOnce();
          expect(hoisted.schedulePendingSessionDeliveries).toHaveBeenCalledOnce();
        }
      } finally {
        fence.rollback();
        services.heartbeatRunner.stop();
        await services.stopDeliveryRecovery();
        await stopping;
        await vi.advanceTimersByTimeAsync(0);
      }
    },
  );

  it.each(
    (["recovery", "scheduling"] as const).flatMap((stage) =>
      (["completion", "AbortError"] as const).map((outcome) => ({ stage, outcome })),
    ),
  )(
    "joins pending session $stage $outcome before scheduled-service shutdown finishes",
    async ({ stage, outcome }) => {
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

        const stopped = vi.fn<() => void>();
        services.heartbeatRunner.stop();
        stopPromise = services.stopDeliveryRecovery().then(stopped);
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
      } finally {
        pending.resolve(undefined);
        services.heartbeatRunner.stop();
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
        const stopped = vi.fn<() => void>();
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
        expect(hoisted.recoverPendingRestartContinuationDeliveries).not.toHaveBeenCalled();
        expect(log.error).not.toHaveBeenCalled();
      } finally {
        releaseImport.resolve();
        await vi.dynamicImportSettled();
        services.heartbeatRunner.stop();
        await services.stopDeliveryRecovery();
        await stopPromise;
        await waking;
        await scheduler.stop();
        vi.doMock("./server-restart-sentinel.js", () => exports);
      }
    },
  );

  it("schedules pending session deliveries when startup recovery fails", async () => {
    hoisted.recoverPendingRestartContinuationDeliveries.mockRejectedValueOnce(
      new Error("database busy"),
    );
    const log = createLog();
    const { services } = activateScheduledServicesForTest({ log });

    await vi.advanceTimersByTimeAsync(1_250);
    await vi.dynamicImportSettled();

    expect(hoisted.schedulePendingSessionDeliveries).toHaveBeenCalledTimes(1);
    await waitForFast(() =>
      expect(log.error).toHaveBeenCalledWith(
        "Session delivery recovery failed: Error: database busy",
      ),
    );
    services.heartbeatRunner.stop();
  });

  it("diagnoses legacy state once and leaves an empty outbound queue idle until enqueue", async () => {
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
    await advanceOutbound(5_000, 0);
    await enqueueAndAdvanceOutbound(5_000, 1);
    await advanceOutbound(15_000, 1);
    await services.stopDeliveryRecovery();
    await enqueueAndAdvanceOutbound(5_000, 1);
    services.heartbeatRunner.stop();
  });

  it("reconstructs conversation route authorization for a recovered delivery attempt", async () => {
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
    services.heartbeatRunner.stop();
  });

  it("uses the current runtime config when retrying queued outbound deliveries", async () => {
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
      enqueueOutbound();
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
      services.heartbeatRunner.stop();
      runtimeConfig.mockRestore();
    }
  });

  it("never overlaps outbound retry drains or admits work between timer firings", async () => {
    const drain = createDeferredCore();
    hoisted.drainPendingDeliveries.mockReturnValueOnce(drain.promise);
    const { services } = activateScheduledServicesForTest();
    await vi.dynamicImportSettled();
    enqueueOutbound();

    await vi.advanceTimersByTimeAsync(1_250);
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    await advanceOutbound(3_750, 1, 1);
    for (let i = 0; i < 3; i++) {
      enqueueOutbound();
    }

    await advanceOutbound(10_000, 1, 1);

    drain.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    await advanceOutbound(5_000, 2);
    await advanceOutbound(10_000, 2);
    await services.stopDeliveryRecovery();
    services.heartbeatRunner.stop();
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
      enqueueOutbound();
      await clock.advanceBy(5_000);
      expect(hoisted.drainPendingDeliveries).toHaveBeenCalledOnce();

      await clock.advanceBy(180_000);
      expect(hoisted.drainPendingDeliveries).toHaveBeenCalledTimes(2);
      expect(scheduler.nextWakeAtMs).toBe(clock.clock.now() + 5_000);

      services.heartbeatRunner.stop();
      await services.stopDeliveryRecovery();
      await clock.advanceBy(15_000);

      expect(hoisted.drainPendingDeliveries).toHaveBeenCalledTimes(2);
      expect(hoisted.heartbeatRunner.stop).toHaveBeenCalledOnce();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      await services.stopDeliveryRecovery();
      await scheduler.stop();
    }
  });

  it("skips outbound retry ticks while gateway work admission is suspended", async () => {
    const { services } = activateScheduledServicesForTest();
    await vi.dynamicImportSettled();
    enqueueOutbound();
    await vi.advanceTimersByTimeAsync(1_250);

    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    if (!suspension?.commit()) {
      throw new Error("Expected gateway suspension admission to be acquired");
    }
    await advanceOutbound(13_750, 0, 0);

    suspension.release();
    await advanceOutbound(5_000, 1);
    services.heartbeatRunner.stop();
  });

  it("joins all maintenance owners before reporting cleanup failures", async () => {
    vi.useFakeTimers();
    const maintenance = createMaintenanceHandles();
    const held = createDeferredCore();
    const earlyFailure = new Error("first owner failed");
    const lateFailure = new Error("held owner failed");
    maintenance.stopPeriodicTasks.mockReturnValue(held.promise);
    maintenance.skillUsageCleanup.mockRejectedValue(earlyFailure);
    const settled = vi.fn<() => void>();
    const clearing = clearGatewayMaintenanceHandles(maintenance)
      .catch((error: unknown) => error)
      .finally(settled);
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
  });

  it("keeps scheduled services disabled for minimal test gateways", () => {
    const { services } = activateScheduledServicesForTest({ minimalTestGateway: true });

    expect(hoisted.startHeartbeatRunner).not.toHaveBeenCalled();
    expect(hoisted.recoverPendingDeliveries).not.toHaveBeenCalled();
    expect(hoisted.recoverPendingRestartContinuationDeliveries).not.toHaveBeenCalled();

    services.heartbeatRunner.stop();
    expect(hoisted.heartbeatRunner.stop).not.toHaveBeenCalled();
  });
});

function activateScheduledServicesForTest(
  overrides: Partial<Parameters<typeof activateGatewayScheduledServices>[0]> = {},
) {
  if (!overrides.scheduler && !overrides.minimalTestGateway) {
    vi.useFakeTimers();
  }
  const log = overrides.log ?? createLog();
  const cfgAtStart = overrides.cfgAtStart ?? ({} as never);
  setRuntimeConfigSnapshot(cfgAtStart, cfgAtStart);
  const services = activateGatewayScheduledServices({
    scheduler: createTestGatewayScheduler(vi.isFakeTimers() ? "fake-timers" : undefined),
    minimalTestGateway: false,
    cfgAtStart,
    deps: {} as never,
    sessionDeliveryRecoveryMaxEnqueuedAt: 123,
    cronEnabled: true,
    ...overrides,
    log,
  });
  return { log, services };
}
