/**
 * Gateway runtime service lifecycle tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const heartbeatRunner = {
    stop: vi.fn(),
    updateConfig: vi.fn(),
  };
  const stopModelPricingRefresh = vi.fn();
  return {
    heartbeatRunner,
    startHeartbeatRunner: vi.fn(() => heartbeatRunner),
    startChannelHealthMonitor: vi.fn(() => ({ stop: vi.fn() })),
    stopModelPricingRefresh,
    startGatewayModelPricingRefresh: vi.fn(() => stopModelPricingRefresh),
    loadModelPricingCacheModule: vi.fn(),
    isVitestRuntimeEnv: vi.fn(() => false),
    recoverPendingDeliveries: vi.fn(async () => undefined),
    recoverPendingRestartContinuationDeliveries: vi.fn<
      (args: { deps: unknown; maxEnqueuedAt: number; log: unknown }) => Promise<undefined>
    >(async () => undefined),
    deliverOutboundPayloads: vi.fn(),
  };
});

vi.mock("../infra/heartbeat-runner.js", () => ({
  startHeartbeatRunner: hoisted.startHeartbeatRunner,
}));

vi.mock("../infra/env.js", () => ({
  isVitestRuntimeEnv: hoisted.isVitestRuntimeEnv,
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: hoisted.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: hoisted.deliverOutboundPayloads,
}));

vi.mock("../infra/outbound/delivery-queue.js", () => ({
  recoverPendingDeliveries: hoisted.recoverPendingDeliveries,
}));

vi.mock("./server-restart-sentinel.js", () => ({
  recoverPendingRestartContinuationDeliveries: hoisted.recoverPendingRestartContinuationDeliveries,
}));

vi.mock("./channel-health-monitor.js", () => ({
  startChannelHealthMonitor: hoisted.startChannelHealthMonitor,
}));

vi.mock("./model-pricing-cache.js", () => ({
  ...(() => {
    hoisted.loadModelPricingCacheModule();
    return {};
  })(),
  startGatewayModelPricingRefresh: hoisted.startGatewayModelPricingRefresh,
}));

const {
  activateGatewayScheduledServices,
  runGatewayPostReadyMaintenance,
  scheduleGatewayPostReadyMaintenance,
  startGatewayRuntimeServices,
} = await import("./server-runtime-services.js");

describe("server-runtime-services", () => {
  beforeEach(() => {
    vi.useRealTimers();
    hoisted.heartbeatRunner.stop.mockClear();
    hoisted.heartbeatRunner.updateConfig.mockClear();
    hoisted.startHeartbeatRunner.mockClear();
    hoisted.startChannelHealthMonitor.mockClear();
    hoisted.startGatewayModelPricingRefresh.mockClear();
    hoisted.stopModelPricingRefresh.mockClear();
    hoisted.loadModelPricingCacheModule.mockClear();
    hoisted.isVitestRuntimeEnv.mockReset().mockReturnValue(false);
    hoisted.recoverPendingDeliveries.mockClear();
    hoisted.recoverPendingRestartContinuationDeliveries.mockClear();
    hoisted.deliverOutboundPayloads.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips model pricing bootstrap import when pricing is disabled", async () => {
    activateGatewayScheduledServices({
      minimalTestGateway: false,
      cfgAtStart: { models: { pricing: { enabled: false } } } as never,
      deps: {} as never,
      sessionDeliveryRecoveryMaxEnqueuedAt: 123,
      cron: { start: vi.fn(async () => undefined) },
      logCron: { error: vi.fn() },
      log: createLog(),
    });

    await vi.dynamicImportSettled();

    expect(hoisted.loadModelPricingCacheModule).not.toHaveBeenCalled();
    expect(hoisted.startGatewayModelPricingRefresh).not.toHaveBeenCalled();
  });

  it("keeps scheduled services and pricing refresh inert during initial runtime setup", async () => {
    const services = startGatewayRuntimeServices({
      minimalTestGateway: false,
      cfgAtStart: {} as never,
      channelManager: {
        getRuntimeSnapshot: vi.fn(),
        isHealthMonitorEnabled: vi.fn(),
        isManuallyStopped: vi.fn(),
      } as never,
      log: createLog(),
    });

    expect(hoisted.startChannelHealthMonitor).toHaveBeenCalledTimes(1);
    expect(hoisted.loadModelPricingCacheModule).not.toHaveBeenCalled();
    expect(hoisted.startGatewayModelPricingRefresh).not.toHaveBeenCalled();
    expect(hoisted.startHeartbeatRunner).not.toHaveBeenCalled();
    expect(hoisted.recoverPendingDeliveries).not.toHaveBeenCalled();

    services.heartbeatRunner.stop();
    expect(hoisted.heartbeatRunner.stop).not.toHaveBeenCalled();
  });

  it("starts model pricing refresh after scheduled services activate", async () => {
    const pluginLookUpTable = {
      index: { plugins: [] },
      manifestRegistry: { plugins: [], diagnostics: [] },
    };
    const { cron, services } = activateScheduledServicesForTest({
      pluginLookUpTable: pluginLookUpTable as never,
    });

    expect(hoisted.startHeartbeatRunner).toHaveBeenCalledTimes(1);
    expect(cron.start).toHaveBeenCalledTimes(1);
    await vi.dynamicImportSettled();
    expect(hoisted.startGatewayModelPricingRefresh).toHaveBeenCalledWith({
      config: {},
      pluginLookUpTable,
    });
    services.stopModelPricingRefresh();
    expect(hoisted.stopModelPricingRefresh).toHaveBeenCalledTimes(1);
  });

  it("does not start model pricing refresh after scheduled services stop before import settles", async () => {
    const { services } = activateScheduledServicesForTest();

    services.stopModelPricingRefresh();
    await vi.dynamicImportSettled();

    expect(hoisted.startGatewayModelPricingRefresh).not.toHaveBeenCalled();
    expect(hoisted.stopModelPricingRefresh).not.toHaveBeenCalled();
  });

  it("activates heartbeat, cron, and delivery recovery after sidecars are ready", async () => {
    vi.useFakeTimers();
    const log = createLog();
    const { cron, services } = activateScheduledServicesForTest({ log });

    expect(hoisted.startHeartbeatRunner).toHaveBeenCalledTimes(1);
    expect(cron.start).toHaveBeenCalledTimes(1);
    expect(services.heartbeatRunner).toBe(hoisted.heartbeatRunner);
    await vi.advanceTimersByTimeAsync(1_250);
    await vi.dynamicImportSettled();
    expect(log.child).toHaveBeenNthCalledWith(1, "delivery-recovery");
    expect(log.child).toHaveBeenNthCalledWith(2, "session-delivery-recovery");
    const deliveryLog = log.child.mock.results[0]?.value;
    const sessionDeliveryLog = log.child.mock.results[1]?.value;
    if (!deliveryLog || !sessionDeliveryLog) {
      throw new Error("Expected delivery recovery log children");
    }
    expect(hoisted.recoverPendingDeliveries).toHaveBeenCalledWith({
      deliver: hoisted.deliverOutboundPayloads,
      cfg: {},
      log: deliveryLog,
    });
    expect(hoisted.recoverPendingRestartContinuationDeliveries).toHaveBeenCalledWith({
      deps: {},
      maxEnqueuedAt: 123,
      log: sessionDeliveryLog,
    });
  });

  it("periodically retries pending restart continuation deliveries every 60 seconds", async () => {
    vi.useFakeTimers();
    const log = createLog();
    activateScheduledServicesForTest({ log });

    // Advance past the initial 1_250ms delay to trigger the first recovery call
    await vi.advanceTimersByTimeAsync(1_250);
    await vi.dynamicImportSettled();
    expect(hoisted.recoverPendingRestartContinuationDeliveries).toHaveBeenCalledTimes(1);

    hoisted.recoverPendingRestartContinuationDeliveries.mockClear();

    // Advance by 60_000ms — the periodic retry should fire again with a fresh cutoff
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.dynamicImportSettled();
    expect(hoisted.recoverPendingRestartContinuationDeliveries).toHaveBeenCalledTimes(1);
    let call = hoisted.recoverPendingRestartContinuationDeliveries.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    // Periodic retry uses Date.now() — known to be >= 1_250 + 60_000 = 61_250
    expect(call.maxEnqueuedAt).toBeGreaterThanOrEqual(61_250);
    expect(call.log).toBe(log.child.mock.results[2]?.value);

    hoisted.recoverPendingRestartContinuationDeliveries.mockClear();

    // Advance another 60_000ms — the periodic retry should fire a third time
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.dynamicImportSettled();
    expect(hoisted.recoverPendingRestartContinuationDeliveries).toHaveBeenCalledTimes(1);
    // Each periodic retry uses a new Date.now() cutoff
    call = hoisted.recoverPendingRestartContinuationDeliveries.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.maxEnqueuedAt).toBeGreaterThanOrEqual(61_250 + 60_000);
    expect(call.log).toBe(log.child.mock.results[3]?.value);
  });

  it("recovers delivery entries enqueued after startup maxEnqueuedAt via periodic retry", async () => {
    vi.useFakeTimers();
    const log = createLog();
    activateScheduledServicesForTest({ log });

    // Advance past the initial 1_250ms delay — first recovery uses startup cutoff (123)
    await vi.advanceTimersByTimeAsync(1_250);
    await vi.dynamicImportSettled();
    expect(hoisted.recoverPendingRestartContinuationDeliveries).toHaveBeenCalledTimes(1);
    // First call uses the startup maxEnqueuedAt
    expect(hoisted.recoverPendingRestartContinuationDeliveries).toHaveBeenCalledWith({
      deps: {},
      maxEnqueuedAt: 123,
      log: expect.anything(),
    });

    hoisted.recoverPendingRestartContinuationDeliveries.mockClear();

    // Simulate a delivery entry being enqueued at time 5_000 (after the startup cutoff of 123)
    // Advance to time 5_000
    await vi.advanceTimersByTimeAsync(3_750);

    // Advance to the first periodic retry at 1_250 + 60_000 = 61_250
    await vi.advanceTimersByTimeAsync(56_250);
    await vi.dynamicImportSettled();
    expect(hoisted.recoverPendingRestartContinuationDeliveries).toHaveBeenCalledTimes(1);
    // The periodic retry uses Date.now() which is >= 61_250, so the entry enqueued at 5_000
    // is eligible
    const periodicCall = hoisted.recoverPendingRestartContinuationDeliveries.mock.calls[0]?.[0];
    expect(periodicCall).toBeDefined();
    expect(periodicCall.maxEnqueuedAt).toBeGreaterThanOrEqual(61_250);
  });

  it("stops session delivery periodic retry after close — no retry fires after stop handle is called", async () => {
    vi.useFakeTimers();
    const log = createLog();
    const { services } = activateScheduledServicesForTest({ log });

    // Advance past the initial 1_250ms delay to trigger the first recovery call
    await vi.advanceTimersByTimeAsync(1_250);
    await vi.dynamicImportSettled();
    expect(hoisted.recoverPendingRestartContinuationDeliveries).toHaveBeenCalledTimes(1);

    hoisted.recoverPendingRestartContinuationDeliveries.mockClear();

    // Stop the session delivery recovery — simulates gateway close/restart
    services.stopSessionDeliveryRecovery();

    // Advance well past the 60_000ms interval — no retry should fire
    await vi.advanceTimersByTimeAsync(120_000);
    await vi.dynamicImportSettled();
    expect(hoisted.recoverPendingRestartContinuationDeliveries).not.toHaveBeenCalled();
  });

  it("can defer cron startup while activating other scheduled services", async () => {
    vi.useFakeTimers();
    const cron = { start: vi.fn(async () => undefined) };
    const log = createLog();

    activateGatewayScheduledServices({
      minimalTestGateway: false,
      cfgAtStart: {} as never,
      deps: {} as never,
      sessionDeliveryRecoveryMaxEnqueuedAt: 123,
      cron,
      startCron: false,
      logCron: { error: vi.fn() },
      log,
    });

    expect(hoisted.startHeartbeatRunner).toHaveBeenCalledTimes(1);
    expect(cron.start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_250);
    await vi.dynamicImportSettled();
    expect(hoisted.recoverPendingDeliveries).toHaveBeenCalledTimes(1);
  });

  it("starts cron and records memory when post-ready maintenance fails", async () => {
    const cron = { start: vi.fn(async () => undefined) };
    const log = createLog();
    const recordPostReadyMemory = vi.fn();

    await runGatewayPostReadyMaintenance({
      startMaintenance: vi.fn(async () => {
        throw new Error("timers unavailable");
      }),
      applyMaintenance: vi.fn(),
      shouldStartCron: () => true,
      markCronStartHandled: vi.fn(),
      cron,
      logCron: { error: vi.fn() },
      log,
      recordPostReadyMemory,
    });

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
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    scheduleGatewayPostReadyMaintenance(
      createPostReadyMaintenanceScheduleParams({
        delayMs: 25,
        isClosing: () => closing,
        startMaintenance,
        applyMaintenance,
        cron,
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
    expect(cron.start).not.toHaveBeenCalled();
    expect(recordPostReadyMemory).not.toHaveBeenCalled();
    expect(clearIntervalSpy).toHaveBeenCalledWith(maintenance.tickInterval);
    expect(clearIntervalSpy).toHaveBeenCalledWith(maintenance.healthInterval);
    expect(clearIntervalSpy).toHaveBeenCalledWith(maintenance.dedupeCleanup);
    expect(clearIntervalSpy).toHaveBeenCalledWith(maintenance.mediaCleanup);
  });

  it("keeps scheduled services disabled for minimal test gateways", () => {
    const cron = { start: vi.fn(async () => undefined) };

    const services = activateGatewayScheduledServices({
      minimalTestGateway: true,
      cfgAtStart: {} as never,
      deps: {} as never,
      sessionDeliveryRecoveryMaxEnqueuedAt: 123,
      cron,
      logCron: { error: vi.fn() },
      log: createLog(),
    });

    expect(hoisted.startHeartbeatRunner).not.toHaveBeenCalled();
    expect(cron.start).not.toHaveBeenCalled();
    expect(hoisted.recoverPendingDeliveries).not.toHaveBeenCalled();
    expect(hoisted.recoverPendingRestartContinuationDeliveries).not.toHaveBeenCalled();

    services.heartbeatRunner.stop();
    expect(hoisted.heartbeatRunner.stop).not.toHaveBeenCalled();
  });
});

function createLog() {
  return {
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createTestCron() {
  return { start: vi.fn(async () => undefined) };
}

function activateScheduledServicesForTest(
  overrides: Partial<Parameters<typeof activateGatewayScheduledServices>[0]> = {},
) {
  const cron = overrides.cron ?? createTestCron();
  const log = overrides.log ?? createLog();
  const services = activateGatewayScheduledServices({
    minimalTestGateway: false,
    cfgAtStart: {} as never,
    deps: {} as never,
    sessionDeliveryRecoveryMaxEnqueuedAt: 123,
    logCron: { error: vi.fn() },
    ...overrides,
    cron,
    log,
  });
  return { cron, log, services };
}

function createPostReadyMaintenanceScheduleParams(
  overrides: Partial<Parameters<typeof scheduleGatewayPostReadyMaintenance>[0]> = {},
): Parameters<typeof scheduleGatewayPostReadyMaintenance>[0] {
  return {
    delayMs: 1,
    isClosing: () => false,
    startMaintenance: vi.fn(async () => null),
    applyMaintenance: vi.fn(),
    shouldStartCron: () => true,
    markCronStartHandled: vi.fn(),
    cron: { start: vi.fn(async () => undefined) },
    logCron: { error: vi.fn() },
    log: createLog(),
    recordPostReadyMemory: vi.fn(),
    ...overrides,
  };
}

function createMaintenanceHandles() {
  return {
    tickInterval: setInterval(() => undefined, 60_000),
    healthInterval: setInterval(() => undefined, 60_000),
    dedupeCleanup: setInterval(() => undefined, 60_000),
    mediaCleanup: setInterval(() => undefined, 60_000),
  };
}
