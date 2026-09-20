import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";

const { checkTelemetryUpdateMock, generateSecureIntMock } = vi.hoisted(() => ({
  checkTelemetryUpdateMock: vi.fn<typeof import("../infra/telemetry.js").checkTelemetryUpdate>(),
  generateSecureIntMock: vi.fn<typeof import("../infra/secure-random.js").generateSecureInt>(),
}));

vi.mock("../infra/secure-random.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/secure-random.js")>()),
  generateSecureInt: generateSecureIntMock,
}));

vi.mock("../infra/device-bootstrap.js", () => ({
  pruneExpiredDevicePairSetupCompletions: vi.fn(async () => 0),
}));

vi.mock("../infra/telemetry.js", () => ({
  checkTelemetryUpdate: checkTelemetryUpdateMock,
}));

async function stopMaintenanceTimers(
  timers: ReturnType<typeof import("./server-maintenance.js").startGatewayMaintenanceTimers>,
): Promise<void> {
  clearInterval(timers.tickInterval);
  clearInterval(timers.healthInterval);
  clearInterval(timers.dedupeCleanup);
  clearInterval(timers.worktreeCleanup);
  await timers.stopTelemetryChecks();
  await timers.stopMediaCleanup();
  await timers.stopSessionColdStorageMaintenance();
}

describe("gateway telemetry maintenance", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    checkTelemetryUpdateMock.mockReset();
    generateSecureIntMock.mockReset();
  });

  it("uses one jittered maintenance schedule and silently retries failed checks", async () => {
    vi.useFakeTimers();
    generateSecureIntMock.mockReturnValue(150_000);
    checkTelemetryUpdateMock.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(null);
    const logHealth = { info: vi.fn(), error: vi.fn() };
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const maintenanceState = createGatewayMaintenanceStateForTest();
    const timers = startGatewayMaintenanceTimers({
      ...maintenanceState,
      logHealth,
      runWorktreeGc: async () => undefined,
      runDeliveryQueueMediaGc: async () => undefined,
      runManagedOutgoingMediaGc: async () => undefined,
    });

    expect(generateSecureIntMock).toHaveBeenNthCalledWith(1, 5 * 60_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(checkTelemetryUpdateMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(checkTelemetryUpdateMock).toHaveBeenCalledWith(maintenanceState.getRuntimeConfig, {
      surface: "gateway",
    });
    expect(checkTelemetryUpdateMock.mock.lastCall?.[0]()).toEqual({});
    expect(logHealth.error).not.toHaveBeenCalled();
    expect(generateSecureIntMock).toHaveBeenNthCalledWith(2, 5 * 60_000);

    await vi.advanceTimersByTimeAsync(420_000);
    expect(checkTelemetryUpdateMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(checkTelemetryUpdateMock).toHaveBeenCalledTimes(2);

    await stopMaintenanceTimers(timers);
  });

  it("coalesces pending checks and joins them before stopping future telemetry admission", async () => {
    vi.useFakeTimers();
    generateSecureIntMock.mockReturnValue(0);
    const check = createDeferredCore<null>();
    checkTelemetryUpdateMock.mockReturnValue(check.promise);
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const timers = startGatewayMaintenanceTimers({
      ...createGatewayMaintenanceStateForTest(),
      runWorktreeGc: async () => undefined,
      runDeliveryQueueMediaGc: async () => undefined,
      runManagedOutgoingMediaGc: async () => undefined,
    });

    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(checkTelemetryUpdateMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(checkTelemetryUpdateMock).toHaveBeenCalledTimes(1);

      let stopped = false;
      const stopping = timers.stopTelemetryChecks().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(stopped).toBe(false);
      expect(checkTelemetryUpdateMock).toHaveBeenCalledTimes(1);

      check.resolve(null);
      await stopping;
      expect(stopped).toBe(true);
      await timers.stopTelemetryChecks();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(checkTelemetryUpdateMock).toHaveBeenCalledTimes(1);
    } finally {
      check.resolve(null);
      await stopMaintenanceTimers(timers);
    }
  });

  it("never checks telemetry for Nix-managed gateways", async () => {
    vi.useFakeTimers();
    generateSecureIntMock.mockReturnValue(0);
    const broadcast = vi.fn();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const timers = startGatewayMaintenanceTimers({
      ...createGatewayMaintenanceStateForTest(),
      broadcast,
      isNixMode: true,
      runWorktreeGc: async () => undefined,
      runDeliveryQueueMediaGc: async () => undefined,
      runManagedOutgoingMediaGc: async () => undefined,
    });

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(checkTelemetryUpdateMock).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith("tick", { ts: expect.any(Number) });
    await stopMaintenanceTimers(timers);
  });
});
