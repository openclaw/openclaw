import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthSummary } from "../../commands/health.js";

const getHealthSnapshotMock = vi.fn<(opts?: { probe?: boolean }) => Promise<HealthSummary>>();

vi.mock("../../commands/health.js", () => ({
  getHealthSnapshot: getHealthSnapshotMock,
}));

function createHealthSummary(label: string): HealthSummary {
  return {
    ok: true,
    checkedAt: label,
  } as HealthSummary;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("gateway health runtime state", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("clears cached health and broadcast callback on shutdown", async () => {
    const state = await import("./health-state.js");
    const broadcast = vi.fn();
    state.setBroadcastHealthUpdate(broadcast);

    getHealthSnapshotMock.mockResolvedValueOnce(createHealthSummary("first"));
    await state.refreshGatewayHealthSnapshot({ probe: true });
    expect(state.getHealthCache()).toEqual(createHealthSummary("first"));
    expect(broadcast).toHaveBeenCalledTimes(1);

    state.clearGatewayHealthRuntimeState();
    expect(state.getHealthCache()).toBeNull();

    getHealthSnapshotMock.mockResolvedValueOnce(createHealthSummary("second"));
    await state.refreshGatewayHealthSnapshot({ probe: true });
    expect(state.getHealthCache()).toEqual(createHealthSummary("second"));
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("ignores stale in-flight refresh after runtime state reset", async () => {
    const state = await import("./health-state.js");
    const firstDeferred = createDeferred<HealthSummary>();
    const currentBroadcast = vi.fn();

    getHealthSnapshotMock.mockReturnValueOnce(firstDeferred.promise);
    state.setBroadcastHealthUpdate(currentBroadcast);
    const staleRefresh = state.refreshGatewayHealthSnapshot({ probe: true });

    state.clearGatewayHealthRuntimeState();
    state.setBroadcastHealthUpdate(currentBroadcast);

    getHealthSnapshotMock.mockResolvedValueOnce(createHealthSummary("current"));
    const currentRefresh = state.refreshGatewayHealthSnapshot({ probe: true });

    firstDeferred.resolve(createHealthSummary("stale"));
    await staleRefresh;
    await currentRefresh;

    expect(state.getHealthCache()).toEqual(createHealthSummary("current"));
    expect(currentBroadcast).toHaveBeenCalledTimes(1);
    expect(currentBroadcast).toHaveBeenCalledWith(createHealthSummary("current"));
  });
});
