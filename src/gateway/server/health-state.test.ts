import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthSummary } from "../../commands/health.js";
import type { ChannelRuntimeSnapshot } from "../server-channels.js";

const mockGetHealthSnapshot =
  vi.fn<
    (params?: {
      probe?: boolean;
      runtimeSnapshot?: ChannelRuntimeSnapshot;
    }) => Promise<HealthSummary>
  >();

vi.mock("../../commands/health.js", () => ({
  getHealthSnapshot: mockGetHealthSnapshot,
}));

vi.mock("../../config/config.js", () => ({
  STATE_DIR: "/tmp/state",
  createConfigIO: () => ({ configPath: "/tmp/config.json" }),
  loadConfig: () => ({}),
}));

vi.mock("../../config/sessions.js", () => ({
  resolveMainSessionKey: () => "main",
}));

vi.mock("../../infra/system-presence.js", () => ({
  listSystemPresence: () => [],
}));

vi.mock("../../infra/update-startup.js", () => ({
  getUpdateAvailable: () => undefined,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: () => "main",
}));

vi.mock("../../routing/session-key.js", () => ({
  normalizeMainKey: () => "main",
}));

vi.mock("../auth.js", () => ({
  resolveGatewayAuth: () => ({ mode: "none" }),
}));

function makeHealthSummary(overrides?: Partial<HealthSummary>): HealthSummary {
  return {
    ok: true,
    ts: Date.now(),
    durationMs: 0,
    channels: {},
    channelOrder: [],
    channelLabels: {},
    heartbeatSeconds: 0,
    defaultAgentId: "main",
    agents: [],
    sessions: { path: "/tmp/sessions.json", count: 0, recent: [] },
    ...overrides,
  };
}

function makeRuntimeSnapshot(connected: boolean): ChannelRuntimeSnapshot {
  return {
    channels: { telegram: { accountId: "default", connected } },
    channelAccounts: {
      telegram: { default: { accountId: "default", connected } },
    },
  } as ChannelRuntimeSnapshot;
}

describe("refreshGatewayHealthSnapshot", () => {
  let refreshGatewayHealthSnapshot: typeof import("./health-state.js").refreshGatewayHealthSnapshot;
  let resetForTest: typeof import("./health-state.js").__resetHealthStateForTest;

  beforeEach(async () => {
    mockGetHealthSnapshot.mockReset();
    // Import fresh references; state is reset via __resetHealthStateForTest
    ({ refreshGatewayHealthSnapshot, __resetHealthStateForTest: resetForTest } =
      await import("./health-state.js"));
    resetForTest();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("deduplicates concurrent refresh calls — getHealthSnapshot is invoked only once while in-flight", async () => {
    let resolveFirst!: (v: HealthSummary) => void;
    const firstDone = new Promise<HealthSummary>((r) => {
      resolveFirst = r;
    });
    // First call blocks until we resolve it manually.
    mockGetHealthSnapshot.mockImplementationOnce(() => firstDone);

    // Fire two calls without a runtimeSnapshot so no follow-up is queued.
    const p1 = refreshGatewayHealthSnapshot();
    const p2 = refreshGatewayHealthSnapshot();

    // getHealthSnapshot should have been called exactly once (not twice).
    expect(mockGetHealthSnapshot).toHaveBeenCalledTimes(1);

    resolveFirst(makeHealthSummary());
    const [r1, r2] = await Promise.all([p1, p2]);

    // Both callers receive the same result.
    expect(r1).toEqual(r2);
    // Still only one call — no pending snapshot, no follow-up triggered.
    expect(mockGetHealthSnapshot).toHaveBeenCalledTimes(1);
  });

  it("queues a follow-up refresh with the latest runtimeSnapshot when a newer one arrives during flight", async () => {
    const snap1 = makeRuntimeSnapshot(false);
    const snap2 = makeRuntimeSnapshot(true);

    // First call returns a deferred promise so we can control when it completes.
    let resolveFirst!: (s: HealthSummary) => void;
    const firstDone = new Promise<HealthSummary>((r) => {
      resolveFirst = r;
    });

    mockGetHealthSnapshot
      .mockImplementationOnce(async () => firstDone)
      .mockResolvedValue(makeHealthSummary());

    // Start first refresh (in-flight).
    const p1 = refreshGatewayHealthSnapshot({ runtimeSnapshot: snap1 });

    // Second call arrives while first is still in-flight with a newer snapshot.
    void refreshGatewayHealthSnapshot({ runtimeSnapshot: snap2 });

    // Complete the first refresh.
    resolveFirst(makeHealthSummary());
    await p1;

    // Wait a microtask tick for the follow-up refresh to be triggered and settled.
    await new Promise<void>((r) => setTimeout(r, 0));

    // getHealthSnapshot must have been called a second time with snap2.
    expect(mockGetHealthSnapshot).toHaveBeenCalledTimes(2);
    const secondCall = mockGetHealthSnapshot.mock.calls[1];
    expect(secondCall[0]?.runtimeSnapshot).toBe(snap2);
  });

  it("does not trigger a follow-up when no newer runtimeSnapshot arrived during flight", async () => {
    mockGetHealthSnapshot.mockResolvedValue(makeHealthSummary());

    await refreshGatewayHealthSnapshot({ runtimeSnapshot: makeRuntimeSnapshot(false) });

    // Only one call; no pending snapshot.
    expect(mockGetHealthSnapshot).toHaveBeenCalledTimes(1);
  });

  it("returns the follow-up result (not stale) when runtimeSnapshot is provided during flight", async () => {
    const snap1 = makeRuntimeSnapshot(false);
    const snap2 = makeRuntimeSnapshot(true);

    const staleResult = makeHealthSummary({ ts: 1 });
    const freshResult = makeHealthSummary({ ts: 2 });

    let resolveFirst!: (v: HealthSummary) => void;
    const firstDone = new Promise<HealthSummary>((r) => {
      resolveFirst = r;
    });

    mockGetHealthSnapshot
      .mockImplementationOnce(() => firstDone)
      .mockResolvedValueOnce(freshResult);

    // Start first refresh (in-flight).
    const p1 = refreshGatewayHealthSnapshot({ runtimeSnapshot: snap1 });

    // Second call arrives with a fresher snapshot while first is in-flight.
    const p2 = refreshGatewayHealthSnapshot({ runtimeSnapshot: snap2 });

    // Complete the first (stale) refresh.
    resolveFirst(staleResult);

    const [r1, r2] = await Promise.all([p1, p2]);

    // First caller gets the stale result (it started the refresh).
    expect(r1.ts).toBe(1);
    // Second caller must get the fresh follow-up result, not the stale one.
    expect(r2.ts).toBe(2);
  });
});
