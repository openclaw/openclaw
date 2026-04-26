import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthSummary } from "../../commands/health.js";

const getHealthSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("../../commands/health.js", () => ({
  getHealthSnapshot: getHealthSnapshotMock,
}));

function createHealthSummary(): HealthSummary {
  return {
    ok: true,
    ts: Date.now(),
    durationMs: 1,
    channels: {},
    channelOrder: [],
    channelLabels: {},
    heartbeatSeconds: 0,
    defaultAgentId: "main",
    agents: [],
    sessions: {
      path: "/tmp/sessions.json",
      count: 0,
      recent: [],
    },
  };
}

async function loadHealthState() {
  vi.resetModules();
  getHealthSnapshotMock.mockReset();
  getHealthSnapshotMock.mockResolvedValue(createHealthSummary());
  return await import("./health-state.js");
}

describe("refreshGatewayHealthSnapshot", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps refreshes coalesced while preserving the first probe intent", async () => {
    const healthState = await loadHealthState();
    let resolveSnapshot: ((summary: HealthSummary) => void) | undefined;
    getHealthSnapshotMock.mockImplementation(
      () =>
        new Promise<HealthSummary>((resolve) => {
          resolveSnapshot = resolve;
        }),
    );

    const first = healthState.refreshGatewayHealthSnapshot({ probe: false });
    const second = healthState.refreshGatewayHealthSnapshot({ probe: true });

    expect(getHealthSnapshotMock).toHaveBeenCalledTimes(1);
    expect(getHealthSnapshotMock).toHaveBeenCalledWith({
      probe: false,
      runtimeSnapshot: undefined,
    });
    resolveSnapshot?.(createHealthSummary());
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("captures runtime snapshots for completed refreshes and guards snapshot failures", async () => {
    const healthState = await loadHealthState();
    const runtimeSnapshot = {
      channels: { discord: { accountId: "default", connected: true } },
      channelAccounts: {},
    };

    await healthState.refreshGatewayHealthSnapshot({
      probe: false,
      getRuntimeSnapshot: () => runtimeSnapshot,
    });
    await healthState.refreshGatewayHealthSnapshot({
      probe: true,
      getRuntimeSnapshot: () => {
        throw new Error("bad channel config");
      },
    });

    expect(getHealthSnapshotMock).toHaveBeenCalledTimes(2);
    expect(
      getHealthSnapshotMock.mock.calls
        .map((call) => call[0]?.probe)
        .toSorted((a, b) => Number(a) - Number(b)),
    ).toEqual([false, true]);
    expect(getHealthSnapshotMock.mock.calls[0]?.[0]?.runtimeSnapshot).toBe(runtimeSnapshot);
    expect(getHealthSnapshotMock.mock.calls[1]?.[0]?.runtimeSnapshot).toBeUndefined();
  });
});
