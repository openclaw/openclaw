import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthSummary } from "../../commands/health.js";

const getHealthSnapshotMock = vi.fn();

vi.mock("../../commands/health.js", () => ({
  getHealthSnapshot: getHealthSnapshotMock,
}));

const { __resetHealthStateForTest, getHealthCache, refreshGatewayHealthSnapshot } =
  await import("./health-state.js");

function createHealthSummary(ts: number): HealthSummary {
  return {
    ok: true,
    ts,
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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("refreshGatewayHealthSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetHealthStateForTest();
  });

  afterEach(() => {
    __resetHealthStateForTest();
  });

  it("does not block a fast snapshot behind an in-flight probe refresh", async () => {
    const probeDeferred = createDeferred<HealthSummary>();
    getHealthSnapshotMock.mockImplementation(({ probe }: { probe?: boolean }) =>
      probe ? probeDeferred.promise : Promise.resolve(createHealthSummary(20)),
    );

    let probeResolved = false;
    const probePromise = refreshGatewayHealthSnapshot({ probe: true }).then((result) => {
      probeResolved = true;
      return result;
    });

    const snapshotResult = await refreshGatewayHealthSnapshot({ probe: false });

    expect(snapshotResult.ts).toBe(20);
    expect(probeResolved).toBe(false);
    expect(getHealthCache()?.ts).toBe(20);
    expect(getHealthSnapshotMock).toHaveBeenNthCalledWith(1, { probe: true });
    expect(getHealthSnapshotMock).toHaveBeenNthCalledWith(2, { probe: false });

    probeDeferred.resolve(createHealthSummary(30));
    await expect(probePromise).resolves.toMatchObject({ ts: 30 });
    expect(getHealthCache()?.ts).toBe(30);
  });

  it("deduplicates concurrent refreshes with the same probe mode", async () => {
    const snapshotDeferred = createDeferred<HealthSummary>();
    getHealthSnapshotMock.mockImplementation(({ probe }: { probe?: boolean }) =>
      probe ? Promise.resolve(createHealthSummary(99)) : snapshotDeferred.promise,
    );

    const first = refreshGatewayHealthSnapshot({ probe: false });
    const second = refreshGatewayHealthSnapshot({ probe: false });

    expect(getHealthSnapshotMock).toHaveBeenCalledTimes(1);
    snapshotDeferred.resolve(createHealthSummary(42));

    await expect(first).resolves.toMatchObject({ ts: 42 });
    await expect(second).resolves.toMatchObject({ ts: 42 });
    expect(getHealthCache()?.ts).toBe(42);
  });
});
