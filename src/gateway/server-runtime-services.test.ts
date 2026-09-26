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
import { registerGatewayCronStartupTests } from "./server-runtime-services.cron.test-support.js";
import {
  createLog,
  createTestCronState,
  createMaintenanceHandles,
  createPostReadyMaintenanceScheduleParams,
  runtimeServiceMocks as hoisted,
  resetRuntimeServiceMocks,
  waitForFast,
} from "./server-runtime-services.test-harness.js";

const {
  activateGatewayScheduledServices,
  scheduleGatewayIdleTask,
  scheduleGatewayPostReadyMaintenance,
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
    expect(hoisted.startHeartbeatRunner).not.toHaveBeenCalled();
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

  function activateCronOff(
    cfgAtStart: Parameters<typeof activateGatewayScheduledServices>[0]["cfgAtStart"],
  ) {
    vi.useFakeTimers();
    const warn = vi.fn();
    activateGatewayScheduledServices({
      scheduler: createTestGatewayScheduler(),
      minimalTestGateway: false,
      cfgAtStart,
      deps: {} as never,
      sessionDeliveryRecoveryMaxEnqueuedAt: 123,
      cronEnabled: false,
      log: {
        child: vi.fn(() => ({ info: vi.fn(), warn, error: vi.fn() })),
        error: vi.fn(),
      },
    });
    return warn;
  }

  it("warns when cron is disabled but scheduled heartbeats remain enabled", () => {
    const warn = activateCronOff({ skills: { workshop: { autonomous: { mode: "off" } } } });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cron scheduler is disabled"));
  });

  it("does not warn about disabled cron when heartbeat cadence is disabled", () => {
    const warn = activateCronOff({
      agents: { defaults: { heartbeat: { every: "0m" } } },
      skills: { workshop: { autonomous: { mode: "off" } } },
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["auto", true],
    ["off", false],
    ["propose", false],
  ] as const)(
    "reports cron-disabled automatic skill collection reviews for mode %s",
    (mode, shouldWarn) => {
      const warn = activateCronOff({
        agents: { defaults: { heartbeat: { every: "0m" } } },
        skills: { workshop: { autonomous: { mode } } },
      });

      if (shouldWarn) {
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("scheduled skill collection reviews are disabled"),
        );
      } else {
        expect(warn).not.toHaveBeenCalled();
      }
    },
  );

  registerGatewayCronStartupTests(startGatewayCronWithLogging);

  it("activates heartbeat and delivery recovery after sidecars are ready", async () => {
    vi.useFakeTimers();
    const log = createLog();
    const resolveGatewayContext = () => undefined;
    const { services } = activateScheduledServicesForTest({
      log,
      resolveGatewayContext,
    });

    expect(hoisted.startHeartbeatRunner).toHaveBeenCalledTimes(1);
    expect(services.heartbeatRunner.updateConfig).toBe(hoisted.heartbeatRunner.updateConfig);
    await vi.advanceTimersByTimeAsync(1_250);
    await vi.dynamicImportSettled();
    expect(log.child).toHaveBeenNthCalledWith(1, "delivery-recovery");
    expect(log.child).toHaveBeenNthCalledWith(2, "session-delivery-recovery");
    const deliveryLog = log.child.mock.results[0]?.value;
    const sessionDeliveryLog = log.child.mock.results[1]?.value;
    if (!deliveryLog || !sessionDeliveryLog) {
      throw new Error("Expected delivery recovery log children");
    }
    expect(hoisted.recoverPendingDeliveries).toHaveBeenCalledWith(
      {
        deliver: expect.any(Function),
        cfg: {},
        log: deliveryLog,
        shouldContinue: expect.any(Function),
      },
      expect.any(Function),
      expect.any(Object),
    );
    const runtimeParams = hoisted.startSessionDeliveryRuntime.mock.calls[0]?.[0];
    if (!runtimeParams) {
      throw new Error("Expected the session delivery runtime to start");
    }
    expect(hoisted.recoverPendingRestartContinuationDeliveries).toHaveBeenCalledWith({
      deps: {},
      maxEnqueuedAt: 123,
      queueContext: runtimeParams.queueContext,
      log: sessionDeliveryLog,
      resolveGatewayContext,
    });
    expect(runtimeParams?.onSettled).toBe(hoisted.settleQueuedSessionDelivery);
    await runtimeParams?.onSettled?.(
      {
        id: "settled-delivery-1",
        kind: "systemEvent",
        sessionKey: "agent:main:cron:job:run:run-1",
        text: "settled delivery",
        enqueuedAt: 1,
        retryCount: 0,
      },
      "recovered",
      runtimeParams.queueContext,
    );
    expect(hoisted.settleQueuedSessionDelivery).toHaveBeenCalledWith(
      {
        id: "settled-delivery-1",
        kind: "systemEvent",
        sessionKey: "agent:main:cron:job:run:run-1",
        text: "settled delivery",
        enqueuedAt: 1,
        retryCount: 0,
      },
      "recovered",
      runtimeParams.queueContext,
    );
    expect(hoisted.schedulePendingSessionDeliveries).toHaveBeenCalledTimes(1);
  });

  it("gives standalone scheduled heartbeats their owning Gateway context and broker", async () => {
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
    hoisted.runHeartbeatOnce.mockImplementationOnce(async () => {
      const scope = getPluginRuntimeGatewayRequestScope();
      bindGatewayContextResolver(admittedOwner, scope?.resolveGatewayContext);
      observed = scope?.resolveGatewayContext?.();
      observedClient = scope?.client;
      observedBroker = getSpawnBroker();
      return { status: "ran", durationMs: 1 };
    });
    const { services } = runWithSpawnBroker(broker, () =>
      activateScheduledServicesForTest({ resolveGatewayContext }),
    );
    const runnerParams = hoisted.startHeartbeatRunner.mock.calls[0]?.[0] as
      | { runOnce?: (opts: never) => Promise<unknown> }
      | undefined;

    await withPluginRuntimeGatewayRequestScope({ client: { id: "retired-request" } } as never, () =>
      runnerParams?.runOnce?.({} as never),
    );

    expect(observed).toBe(gatewayContext);
    expect(observedClient).toBeUndefined();
    expect(observedBroker).toBe(broker);
    expect(hasGatewayContextOwner(admittedOwner, resolveGatewayContext)).toBe(true);
    expect(hasGatewayContextOwner(admittedOwner, () => gatewayContext)).toBe(false);
    services.heartbeatRunner.stop();
    vi.useRealTimers();
  });

  it("waits for active startup recovery before its stop handle settles", async () => {
    vi.useFakeTimers();
    let resolveRecovery: (() => void) | undefined;
    hoisted.recoverPendingDeliveries.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        resolveRecovery = resolve;
      });
      return {
        recovered: 0,
        failed: 0,
        skippedMaxRetries: 0,
        deferredBackoff: 0,
      };
    });

    const { services } = activateScheduledServicesForTest();
    await vi.dynamicImportSettled();
    expect(hoisted.recoverPendingDeliveries).toHaveBeenCalledOnce();
    expect(hoisted.drainPendingDeliveries).not.toHaveBeenCalled();

    let stopped = false;
    const stopPromise = services.stopDeliveryRecovery().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(getActiveGatewayRootWorkCount()).toBe(1);

    if (!resolveRecovery) {
      throw new Error("Expected outbound startup recovery resolver to be initialized");
    }
    resolveRecovery();
    await stopPromise;
    expect(stopped).toBe(true);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    services.heartbeatRunner.stop();
  });

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
    services.heartbeatRunner.stop();
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
      services.heartbeatRunner.stop();
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
      services.heartbeatRunner.stop();
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
        services.heartbeatRunner.stop();
        stopPromise = services.stopDeliveryRecovery().then(() => {
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
        services.heartbeatRunner.stop();
        await services.stopDeliveryRecovery();
        await stopPromise;
        await vi.advanceTimersByTimeAsync(0);
      }
    },
  );

  it("joins a pending session import without installing a runtime after shutdown", async () => {
    vi.useFakeTimers();
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
    const { services, log } = activateScheduledServicesForTest();
    let stopPromise: Promise<void> | undefined;
    try {
      vi.advanceTimersByTime(1_250);
      await importStarted.promise;
      let stopped = false;
      services.heartbeatRunner.stop();
      stopPromise = services.stopDeliveryRecovery().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);

      releaseImport.resolve();
      await stopPromise;
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
      await vi.advanceTimersByTimeAsync(0);
      vi.doMock("./server-restart-sentinel.js", () => exports);
    }
  });

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

  it.each(["clean", "legacy rows", "legacy files"])(
    "keeps current delivery recovery running with %s while diagnosing legacy state once",
    async (condition) => {
      vi.useFakeTimers();
      const log = createLog();
      const recoveryLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      log.child.mockReturnValue(recoveryLog);
      hoisted.countPendingDeliveryQueueEntries.mockReturnValue(condition === "legacy rows" ? 2 : 0);
      hoisted.listLegacyDeliveryQueueArtifacts.mockReturnValue(
        condition === "legacy files" ? ["legacy.json"] : [],
      );
      const { services } = activateScheduledServicesForTest({ log });
      await vi.dynamicImportSettled();
      expect(hoisted.recoverPendingDeliveries).toHaveBeenCalledOnce();
      if (condition === "clean") {
        expect(recoveryLog.warn).not.toHaveBeenCalled();
      } else {
        expect(recoveryLog.warn).toHaveBeenCalledWith(
          expect.stringContaining("openclaw doctor --fix"),
        );
      }
      await vi.advanceTimersByTimeAsync(15_000);
      expect(hoisted.countPendingDeliveryQueueEntries).toHaveBeenCalledOnce();
      expect(hoisted.listLegacyDeliveryQueueArtifacts).toHaveBeenCalledOnce();
      expect(hoisted.recoverPendingDeliveries).toHaveBeenCalledOnce();
      expect(hoisted.drainPendingDeliveries).toHaveBeenCalledTimes(3);
      await services.stopDeliveryRecovery();
      services.heartbeatRunner.stop();
    },
  );

  it("runs initial recovery again for the next scheduled-service lifecycle", async () => {
    vi.useFakeTimers();
    const first = activateScheduledServicesForTest();
    await vi.dynamicImportSettled();
    expect(hoisted.recoverPendingDeliveries).toHaveBeenCalledOnce();
    await first.services.stopDeliveryRecovery();
    const second = activateScheduledServicesForTest();
    await vi.dynamicImportSettled();
    expect(hoisted.recoverPendingDeliveries).toHaveBeenCalledTimes(2);
    await second.services.stopDeliveryRecovery();
    second.services.heartbeatRunner.stop();
  });

  it.each([
    {
      name: "startup recovery deferred an existing delivery for backoff",
      deferredBackoff: 1,
    },
    {
      name: "a new delivery failed after an empty startup scan",
      deferredBackoff: 0,
    },
  ])("retries outbound deliveries when $name", async ({ deferredBackoff }) => {
    vi.useFakeTimers();
    hoisted.recoverPendingDeliveries.mockResolvedValueOnce({
      recovered: 0,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff,
    });
    const { services } = activateScheduledServicesForTest();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(hoisted.recoverPendingDeliveries).toHaveBeenCalledOnce();
    expect(hoisted.drainPendingDeliveries).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledOnce();
    const [drain] = hoisted.drainPendingDeliveries.mock.calls[0] ?? [];
    expect(drain).toMatchObject({
      drainKey: "gateway:outbound",
      deliver: expect.any(Function),
    });
    expect(drain?.selectEntry({ channel: "discord" } as never, Date.now())).toEqual({
      match: true,
      bypassBackoff: false,
    });
    services.heartbeatRunner.stop();
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
      await params.onDeliveryAttempt?.();
      return [];
    });
    const denial = new Error("conversation route reassigned");
    hoisted.assertQueuedConversationDeliveryAttemptAuthorized.mockImplementationOnce(() => {
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

    expect(hoisted.assertQueuedConversationDeliveryAttemptAuthorized).toHaveBeenCalledWith(
      expect.objectContaining({
        readCurrentConfig: expect.any(Function),
        operationId: "operation-recovery",
        routeFingerprint: "route-recovery",
      }),
      expect.objectContaining({ agentId: "main", storePath: "/tmp/agent.sqlite" }),
    );
    services.heartbeatRunner.stop();
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
      expect(runtimeConfig).toHaveBeenCalledOnce();
    } finally {
      services.heartbeatRunner.stop();
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
    services.heartbeatRunner.stop();
  });

  it("stops outbound delivery retry timers with the gateway lifecycle", async () => {
    vi.useFakeTimers();
    const { services } = activateScheduledServicesForTest();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledOnce();

    services.heartbeatRunner.stop();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(hoisted.drainPendingDeliveries).toHaveBeenCalledOnce();
    expect(hoisted.heartbeatRunner.stop).toHaveBeenCalledOnce();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
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
    services.heartbeatRunner.stop();
  });

  it("starts cron and records memory when post-ready maintenance fails", async () => {
    vi.useFakeTimers();
    const cron = { start: vi.fn(async () => undefined) };
    const log = createLog();
    const recordPostReadyMemory = vi.fn();

    scheduleGatewayPostReadyMaintenance(
      createPostReadyMaintenanceScheduleParams({
        startMaintenance: vi.fn(async () => {
          throw new Error("timers unavailable");
        }),
        cronState: createTestCronState(cron),
        log,
        recordPostReadyMemory,
      }),
    );
    await vi.advanceTimersByTimeAsync(1);

    expect(log.warn).toHaveBeenCalledWith(
      "gateway post-ready maintenance startup failed: Error: timers unavailable",
    );
    expect(cron.start).toHaveBeenCalledTimes(1);
    expect(recordPostReadyMemory).toHaveBeenCalledTimes(1);
  });

  it("returns a cancellable post-ready maintenance timer", async () => {
    vi.useFakeTimers();
    const startMaintenance = vi.fn(async () => null);
    const onStarted = vi.fn();
    const handle = scheduleGatewayPostReadyMaintenance(
      createPostReadyMaintenanceScheduleParams({
        delayMs: 25,
        onStarted,
        startMaintenance,
      }),
    );

    clearTimeout(handle);
    await vi.advanceTimersByTimeAsync(25);

    expect(onStarted).not.toHaveBeenCalled();
    expect(startMaintenance).not.toHaveBeenCalled();
  });

  it("runs a scheduled idle task in an independent admitted root", async () => {
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
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
    expect(run).toHaveBeenCalledOnce();
    expect(activeRootCounts).toEqual([1]);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("retries a scheduled idle task while request work is active", async () => {
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
    const admission = tryBeginGatewayRootWorkAdmission();
    if (!admission) {
      throw new Error("Expected request work admission");
    }
    const run = vi.fn(async () => undefined);

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
  });

  it("rechecks request work after joining the admitted root set", async () => {
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
    const run = vi.fn(async () => undefined);
    const isBusy = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    scheduleGatewayIdleTask({
      id: "test:idle",
      scheduler,
      delayMs: 25,
      retryDelayMs: 50,
      isClosing: () => false,
      isBusy,
      run,
      log: createLog(),
      errorMessage: "idle task failed",
    });

    await clock.advanceBy(25);
    expect(run).not.toHaveBeenCalled();
    await clock.advanceBy(49);
    expect(run).not.toHaveBeenCalled();
    await clock.advanceBy(1);
    expect(run).toHaveBeenCalledOnce();
    expect(isBusy).toHaveBeenCalledTimes(4);
  });

  it("cancels a scheduled idle task before its delay elapses", async () => {
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
    const run = vi.fn(async () => undefined);
    const handle = scheduleGatewayIdleTask({
      id: "test:idle",
      scheduler,
      delayMs: 25,
      retryDelayMs: 50,
      isClosing: () => false,
      isBusy: () => false,
      run,
      log: createLog(),
      errorMessage: "idle task failed",
    });

    await handle.stop();
    await clock.advanceBy(25);

    expect(run).not.toHaveBeenCalled();
  });

  it("clears delayed maintenance handles when close starts during maintenance startup", async () => {
    vi.useFakeTimers();
    let closing = false;
    let resolveMaintenance:
      | ((maintenance: ReturnType<typeof createMaintenanceHandles>) => void)
      | undefined;
    const startMaintenance = vi.fn(
      () =>
        new Promise<ReturnType<typeof createMaintenanceHandles>>((resolve) => {
          resolveMaintenance = resolve;
        }),
    );
    const applyMaintenance = vi.fn();
    const cron = { start: vi.fn(async () => undefined) };
    const recordPostReadyMemory = vi.fn();

    scheduleGatewayPostReadyMaintenance(
      createPostReadyMaintenanceScheduleParams({
        delayMs: 25,
        isClosing: () => closing,
        startMaintenance,
        applyMaintenance,
        cronState: createTestCronState(cron),
        recordPostReadyMemory,
      }),
    );

    await vi.advanceTimersByTimeAsync(25);
    expect(startMaintenance).toHaveBeenCalledTimes(1);

    closing = true;
    if (!resolveMaintenance) {
      throw new Error("Expected gateway maintenance resolver to be initialized");
    }
    const maintenance = createMaintenanceHandles();
    resolveMaintenance(maintenance);
    await Promise.resolve();
    await Promise.resolve();

    expect(applyMaintenance).not.toHaveBeenCalled();
    expect(maintenance.startMediaCleanup).not.toHaveBeenCalled();
    expect(maintenance.stopPeriodicTasks).toHaveBeenCalledTimes(1);
    expect(cron.start).not.toHaveBeenCalled();
    expect(recordPostReadyMemory).not.toHaveBeenCalled();
  });

  it("keeps scheduled services disabled for minimal test gateways", () => {
    const services = activateGatewayScheduledServices({
      scheduler: createTestGatewayScheduler(),
      minimalTestGateway: true,
      cfgAtStart: {} as never,
      deps: {} as never,
      sessionDeliveryRecoveryMaxEnqueuedAt: 123,
      cronEnabled: true,
      log: createLog(),
    });

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
  const log = overrides.log ?? createLog();
  const cfgAtStart = overrides.cfgAtStart ?? ({} as never);
  const services = activateGatewayScheduledServices({
    scheduler: createTestGatewayScheduler(),
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
