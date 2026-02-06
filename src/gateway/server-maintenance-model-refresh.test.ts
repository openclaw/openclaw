import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthSummary } from "../commands/health.js";
import { startGatewayMaintenanceTimers } from "./server-maintenance.js";

vi.mock("./server/health-state.js", () => ({
  setBroadcastHealthUpdate: vi.fn(),
}));

function clearTimers(timers: {
  tickInterval: ReturnType<typeof setInterval>;
  healthInterval: ReturnType<typeof setInterval>;
  dedupeCleanup: ReturnType<typeof setInterval>;
  modelCatalogRefresh: ReturnType<typeof setInterval> | null;
}) {
  clearInterval(timers.tickInterval);
  clearInterval(timers.healthInterval);
  clearInterval(timers.dedupeCleanup);
  if (timers.modelCatalogRefresh) {
    clearInterval(timers.modelCatalogRefresh);
  }
}

function makeParams(overrides: {
  modelCatalogRefreshIntervalMs?: number;
  refreshModelCatalog?: () => Promise<{ wrote: boolean; count: number }>;
}) {
  return {
    broadcast: vi.fn(),
    nodeSendToAllSubscribed: vi.fn(),
    getPresenceVersion: () => 0,
    getHealthVersion: () => 0,
    refreshGatewayHealthSnapshot: vi.fn().mockResolvedValue({} as HealthSummary),
    logHealth: { error: vi.fn() },
    logModelCatalog: { info: vi.fn(), error: vi.fn() },
    modelCatalogRefreshIntervalMs: overrides.modelCatalogRefreshIntervalMs,
    refreshModelCatalog: overrides.refreshModelCatalog,
    dedupe: new Map(),
    chatAbortControllers: new Map(),
    chatRunState: { abortedRuns: new Map<string, number>() },
    chatRunBuffers: new Map<string, string>(),
    chatDeltaSentAt: new Map<string, number>(),
    removeChatRun: vi.fn(),
    agentRunSeq: new Map<string, number>(),
    nodeSendToSession: vi.fn(),
  };
}

describe("model catalog refresh timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should broadcast models-updated when model count changes", async () => {
    let callCount = 0;
    const params = makeParams({
      modelCatalogRefreshIntervalMs: 1000,
      refreshModelCatalog: async () => {
        callCount++;
        return { wrote: false, count: callCount === 1 ? 5 : 8 };
      },
    });
    const timers = startGatewayMaintenanceTimers(params);

    // First tick: sets baseline (count=5, previousModelCount was -1 → no broadcast)
    await vi.advanceTimersByTimeAsync(1000);

    // Second tick: count changed 5 → 8 → should broadcast
    await vi.advanceTimersByTimeAsync(1000);

    const modelUpdatedCalls = params.broadcast.mock.calls.filter(
      ([event]: [string]) => event === "models-updated",
    );
    expect(modelUpdatedCalls).toHaveLength(1);
    expect(modelUpdatedCalls[0]).toEqual(["models-updated", { count: 8 }]);
    expect(params.logModelCatalog.info).toHaveBeenCalledWith(
      expect.stringContaining("5 → 8 models"),
    );

    clearTimers(timers);
  });

  it("should broadcast when wrote=true even on first tick", async () => {
    const params = makeParams({
      modelCatalogRefreshIntervalMs: 1000,
      refreshModelCatalog: async () => ({ wrote: true, count: 10 }),
    });
    const timers = startGatewayMaintenanceTimers(params);

    await vi.advanceTimersByTimeAsync(1000);

    const modelUpdatedCalls = params.broadcast.mock.calls.filter(
      ([event]: [string]) => event === "models-updated",
    );
    expect(modelUpdatedCalls).toHaveLength(1);
    expect(modelUpdatedCalls[0]).toEqual(["models-updated", { count: 10 }]);

    clearTimers(timers);
  });

  it("should not broadcast when model count stays the same", async () => {
    const params = makeParams({
      modelCatalogRefreshIntervalMs: 1000,
      refreshModelCatalog: async () => ({ wrote: false, count: 5 }),
    });
    const timers = startGatewayMaintenanceTimers(params);

    // First tick: sets baseline
    await vi.advanceTimersByTimeAsync(1000);

    // Second tick: same count → no broadcast
    await vi.advanceTimersByTimeAsync(1000);

    const modelUpdatedCalls = params.broadcast.mock.calls.filter(
      ([event]: [string]) => event === "models-updated",
    );
    expect(modelUpdatedCalls).toHaveLength(0);

    clearTimers(timers);
  });

  it("should log error and not crash when refreshModelCatalog throws", async () => {
    const params = makeParams({
      modelCatalogRefreshIntervalMs: 1000,
      refreshModelCatalog: async () => {
        throw new Error("scan failed");
      },
    });
    const timers = startGatewayMaintenanceTimers(params);

    await vi.advanceTimersByTimeAsync(1000);

    expect(params.logModelCatalog.error).toHaveBeenCalledWith(
      expect.stringContaining("refresh failed"),
    );

    const modelUpdatedCalls = params.broadcast.mock.calls.filter(
      ([event]: [string]) => event === "models-updated",
    );
    expect(modelUpdatedCalls).toHaveLength(0);

    clearTimers(timers);
  });

  it("should return null modelCatalogRefresh when interval is 0", () => {
    const params = makeParams({
      modelCatalogRefreshIntervalMs: 0,
      refreshModelCatalog: async () => ({ wrote: false, count: 0 }),
    });
    const timers = startGatewayMaintenanceTimers(params);

    expect(timers.modelCatalogRefresh).toBeNull();

    clearTimers(timers);
  });

  it("should return null modelCatalogRefresh when no refreshModelCatalog provided", () => {
    const params = makeParams({
      modelCatalogRefreshIntervalMs: 1000,
    });
    const timers = startGatewayMaintenanceTimers(params);

    expect(timers.modelCatalogRefresh).toBeNull();

    clearTimers(timers);
  });

  it("should clear timer on shutdown without errors", () => {
    const params = makeParams({
      modelCatalogRefreshIntervalMs: 1000,
      refreshModelCatalog: async () => ({ wrote: false, count: 5 }),
    });
    const timers = startGatewayMaintenanceTimers(params);

    expect(timers.modelCatalogRefresh).not.toBeNull();

    // Clearing should not throw
    clearTimers(timers);
  });
});
