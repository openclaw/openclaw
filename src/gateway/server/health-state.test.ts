import "../../test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import type { HealthSummary } from "../health/types.js";
import type { GatewayEventLoopHealth } from "./event-loop-health.js";

type CollectHealth = typeof import("../health/collector.js").collectGatewayHealthSnapshot;
const {
  collectGatewayHealthSnapshotMock,
  getRuntimeConfigMock,
  getUpdateAvailableMock,
  getUpdateScheduleMock,
} = vi.hoisted(() => ({
  collectGatewayHealthSnapshotMock: vi.fn<CollectHealth>(),
  getRuntimeConfigMock: vi.fn(),
  getUpdateAvailableMock: vi.fn(),
  getUpdateScheduleMock: vi.fn(),
}));

vi.mock("../health/collector.js", () => ({
  collectGatewayHealthSnapshot: collectGatewayHealthSnapshotMock,
}));

vi.mock("../../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/io.js")>()),
  getRuntimeConfig: getRuntimeConfigMock,
}));

vi.mock("../../config/runtime-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/runtime-snapshot.js")>()),
  getRuntimeConfigAppliedHash: () => "internal-applied-hash",
  getRuntimeConfigSourceSnapshot: () => null,
}));

vi.mock("../../infra/update-status-state.js", () => ({
  getUpdateAvailable: getUpdateAvailableMock,
  getUpdateSchedule: getUpdateScheduleMock,
}));

function healthSnapshotCallArg(index = 0) {
  return collectGatewayHealthSnapshotMock.mock.calls.at(index)?.[0];
}

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

const revisionProjector = {
  projectRawHash: (hash: string) => `raw-token:${hash}`,
  projectResolvedHash: (hash: string) => `resolved-token:${hash}`,
  hashResponseSessionBearer: () => "unused-test-scope",
};

async function loadHealthState() {
  vi.resetModules();
  collectGatewayHealthSnapshotMock.mockReset();
  collectGatewayHealthSnapshotMock.mockResolvedValue(createHealthSummary());
  getUpdateAvailableMock.mockReset();
  getUpdateAvailableMock.mockReturnValue(null);
  getUpdateScheduleMock.mockReset();
  getUpdateScheduleMock.mockReturnValue(null);
  getRuntimeConfigMock.mockReset().mockReturnValue({ agents: { entries: { main: {} } } });
  return await import("./health-state.js");
}

let healthState: Awaited<ReturnType<typeof loadHealthState>>;
let broadcast: ReturnType<typeof vi.fn>;
let version: number;
beforeEach(async () => {
  vi.restoreAllMocks();
  healthState = await loadHealthState();
  broadcast = vi.fn();
  healthState.setBroadcastHealthUpdate(broadcast);
  version = healthState.getHealthVersion();
});

async function startRefresh(opts: Parameters<typeof healthState.refreshGatewayHealthSnapshot>[0]) {
  // Enter collectors separately: Vitest manual mocks cannot resolve concurrent imports.
  const started = createDeferred();
  const pending = createDeferred<HealthSummary>();
  const summary = createHealthSummary();
  collectGatewayHealthSnapshotMock.mockImplementationOnce(() => {
    started.resolve();
    return pending.promise;
  });
  const promise = healthState.refreshGatewayHealthSnapshot(opts);
  await started.promise;
  return { ...pending, summary, promise };
}

function eventLoopHealth(overrides: Partial<GatewayEventLoopHealth> = {}): GatewayEventLoopHealth {
  return {
    degraded: false,
    degradedSinceMs: null,
    reasons: [],
    intervalMs: 1_000,
    delayP99Ms: 10,
    delayMaxMs: 20,
    utilization: 0.1,
    cpuCoreRatio: 0.1,
    ...overrides,
  };
}

const updateAvailable = {
  currentVersion: "2026.8.7",
  latestVersion: "2026.8.8",
  channel: "dev",
  currentSha: "1111111111111111111111111111111111111111",
  upstreamRef: "origin/main",
  upstreamSha: "2222222222222222222222222222222222222222",
  commitsBehind: 1,
  commits: [{ sha: "2222222", subject: "Detailed commit subject" }],
};
const updateSchedule = { channel: "dev", autoEnabled: true, install: { kind: "git" as const } };

describe("buildGatewaySnapshot update metadata", () => {
  it("presents the pinned config and state paths together after runtime selection", async () => {
    const paths = await import("../../config/paths.js");
    const original = { configPath: paths.CONFIG_PATH, stateDir: paths.STATE_DIR };
    try {
      for (const selection of ["first", "second"]) {
        const stateDir = path.join(original.stateDir, selection);
        const configPath = path.join(stateDir, "gateway.json");
        paths.pinRuntimePaths({
          ...process.env,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: stateDir,
        });
        const snapshot = healthState.buildGatewaySnapshot({
          client: null,
          includeSensitive: true,
          revisionProjector,
        });
        expect(snapshot).toMatchObject({ configPath, stateDir });
        expect(
          healthState.buildGatewaySnapshot({ client: null, revisionProjector }),
        ).not.toHaveProperty("configPath");
      }
    } finally {
      paths.pinRuntimePaths({
        ...process.env,
        OPENCLAW_CONFIG_PATH: original.configPath,
        OPENCLAW_STATE_DIR: original.stateDir,
      });
    }
  });

  it("reads suspension synchronously without waiting for health collection", async () => {
    resetGatewayWorkAdmission();
    const read = () =>
      healthState.buildGatewaySnapshot({ client: null, revisionProjector }).suspension;
    try {
      expect(read()).toEqual({ phase: "accepting" });
      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(read()).toEqual({ phase: "preparing" });
      suspension?.drain();
      expect(read()).toEqual({ phase: "draining" });
      suspension?.commit();
      expect(read()).toEqual({ phase: "prepared" });
      suspension?.release();
      expect(read()).toEqual({ phase: "accepting" });
      expect(collectGatewayHealthSnapshotMock).not.toHaveBeenCalled();
    } finally {
      resetGatewayWorkAdmission();
    }
  });

  it("omits the schedule and projects legacy availability without update detail access", async () => {
    getUpdateAvailableMock.mockReturnValue(updateAvailable);
    getUpdateScheduleMock.mockReturnValue(updateSchedule);

    const snapshot = healthState.buildGatewaySnapshot({
      client: null,
      includeUpdateDetails: false,
      revisionProjector,
    });

    expect(snapshot.updateAvailable).toEqual({
      currentVersion: "2026.8.7",
      latestVersion: "2026.8.8",
      channel: "dev",
    });
    expect(snapshot.updateSchedule).toBeUndefined();
    expect(snapshot.sessionDefaults).toMatchObject({ ownership: "sole", selectionRequired: false });
    expect(snapshot.appliedConfigHash).toBe("resolved-token:internal-applied-hash");
    expect(getUpdateScheduleMock).not.toHaveBeenCalled();
  });

  it("includes the full update availability and schedule with update detail access", async () => {
    getUpdateAvailableMock.mockReturnValue(updateAvailable);
    getUpdateScheduleMock.mockReturnValue(updateSchedule);

    const snapshot = healthState.buildGatewaySnapshot({
      client: null,
      includeUpdateDetails: true,
      revisionProjector,
    });

    expect(snapshot.updateAvailable).toBe(updateAvailable);
    expect(snapshot.updateSchedule).toBe(updateSchedule);
  });
});

describe("refreshGatewayHealthSnapshot", () => {
  it("refreshes diagnostics without rebroadcasting clock and activity changes", async () => {
    const snapshot = (time: number): HealthSummary => {
      const activity = {
        accountId: "default",
        connected: true,
        busy: time % 2 === 0,
        activeRuns: time,
        activeRunStartedAt: time,
      };
      const sessions = {
        path: "/synthetic/sessions",
        count: time,
        recent: [{ key: `agent:main:session-${time}`, age: time, updatedAt: time }],
      };
      return {
        ...createHealthSummary(),
        ts: time,
        durationMs: time,
        eventLoop: eventLoopHealth({
          intervalMs: time,
          delayP99Ms: time,
          delayMaxMs: time,
          utilization: time / 1000,
          cpuCoreRatio: time / 1000,
        }),
        channels: {
          example: {
            ...activity,
            accounts: {
              default: {
                ...activity,
                authAgeMs: time,
                lastProbeAt: time,
                lastInboundAt: time,
                lastOutboundAt: time,
                lastTransportActivityAt: time,
                lastEventAt: time,
                lastMessageAt: time,
                lastRunActivityAt: time,
              },
            },
          },
        },
        sessions,
        agents: [
          {
            agentId: "main",
            isDefault: true,
            heartbeat: {
              enabled: false,
              every: "0m",
              everyMs: null,
              prompt: "",
              target: "none",
              ackMaxChars: 0,
            },
            sessions,
          },
        ],
      };
    };
    const first = snapshot(1);
    const next = snapshot(2);
    collectGatewayHealthSnapshotMock.mockResolvedValueOnce(first).mockResolvedValueOnce(next);
    await healthState.refreshGatewayHealthSnapshot({ probe: false });
    await expect(healthState.refreshGatewayHealthSnapshot({ probe: false })).resolves.toBe(next);
    expect(healthState.getHealthCache()).toBe(next);
    expect(broadcast).toHaveBeenCalledExactlyOnceWith(first);
    expect(healthState.getHealthVersion()).toBe(version + 1);

    // An explicit check still returns fresh diagnostic readings, without an unchanged event.
    const probe = snapshot(3);
    collectGatewayHealthSnapshotMock.mockResolvedValueOnce(probe);
    await expect(healthState.refreshGatewayHealthSnapshot({ probe: true })).resolves.toBe(probe);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("publishes channel failures, recovery, and other material changes on the next refresh", async () => {
    const initial = createHealthSummary();
    const eventLoop = eventLoopHealth();
    const disconnected = {
      ...initial,
      channels: {
        example: {
          accountId: "default",
          accounts: {
            secondary: { accountId: "secondary", connected: false, lastError: "offline" },
          },
        },
      },
    };
    const snapshots: HealthSummary[] = [
      initial,
      disconnected,
      initial,
      {
        ...initial,
        plugins: {
          loaded: [],
          errors: [{ id: "provider", origin: "bundled", activated: true, error: "unavailable" }],
        },
      },
      { ...initial, configReload: { hotReloadStatus: "disabled" } },
      { ...initial, eventLoop },
      {
        ...initial,
        channels: { example: { accountId: "default", lastStartAt: 1, lastStopAt: 2 } },
      },
      {
        ...initial,
        channels: { example: { accountId: "default", lastStartAt: 3, lastStopAt: 2 } },
      },
    ];
    for (const summary of snapshots) {
      collectGatewayHealthSnapshotMock.mockResolvedValueOnce(summary);
      await healthState.refreshGatewayHealthSnapshot({ probe: false });
    }
    expect(broadcast.mock.calls.map(([summary]) => summary)).toEqual(snapshots);
  });

  it("publishes sustained event-loop degradation without broadcasting transient sample flaps", async () => {
    const snapshot = (degradedSinceMs: number | null): HealthSummary => ({
      ...createHealthSummary(),
      eventLoop: eventLoopHealth({
        degraded: degradedSinceMs !== null,
        degradedSinceMs,
        reasons: degradedSinceMs === null ? [] : ["event_loop_delay"],
        delayP99Ms: degradedSinceMs === null ? 10 : 1_500,
        delayMaxMs: degradedSinceMs === null ? 20 : 1_700,
        utilization: 0.2,
      }),
    });
    const healthy = snapshot(null);
    const sustained = snapshot(60_000);
    const recovered = snapshot(null);
    for (const summary of [
      healthy,
      snapshot(0),
      snapshot(59_999),
      snapshot(null),
      sustained,
      recovered,
    ]) {
      collectGatewayHealthSnapshotMock.mockResolvedValueOnce(summary);
      await expect(healthState.refreshGatewayHealthSnapshot({ probe: false })).resolves.toBe(
        summary,
      );
      expect(healthState.getHealthCache()).toBe(summary);
    }
    expect(broadcast.mock.calls.map(([summary]) => summary)).toEqual([
      healthy,
      sustained,
      recovered,
    ]);
  });

  it("does not let a post-connect passive refresh absorb an explicit probe", async () => {
    const passive = await startRefresh({ probe: false });
    const probe = await startRefresh({ probe: true });
    probe.summary.channels = {
      example: { accountId: "default", probe: { ok: false, error: "offline" } },
    };

    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
    expect(healthSnapshotCallArg()).toMatchObject({
      audience: "public",
      probe: false,
      runtimeSnapshot: undefined,
    });
    expect(healthSnapshotCallArg(1)).toMatchObject({
      audience: "public",
      probe: true,
      runtimeSnapshot: undefined,
    });

    probe.resolve(probe.summary);
    await expect(probe.promise).resolves.toBe(probe.summary);
    expect(healthState.getHealthCache()).toBe(probe.summary);
    expect(healthState.getHealthVersion()).toBe(version + 1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenLastCalledWith(probe.summary);

    passive.resolve(passive.summary);
    await expect(passive.promise).resolves.toBe(passive.summary);
    expect(healthState.getHealthCache()).toBe(passive.summary);
    expect(healthState.getHealthVersion()).toBe(version + 2);
    expect(broadcast.mock.calls.map(([summary]) => summary)).toEqual([
      probe.summary,
      passive.summary,
    ]);
  });

  it("coalesces concurrent explicit probe waiters", async () => {
    const started = createDeferred();
    const pending = createDeferred<HealthSummary>();
    const summary = createHealthSummary();
    collectGatewayHealthSnapshotMock.mockImplementationOnce(() => {
      started.resolve();
      return pending.promise;
    });
    const first = healthState.refreshGatewayHealthSnapshot({ probe: true });
    const second = healthState.refreshGatewayHealthSnapshot({ probe: true });
    await started.promise;
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(1);
    pending.resolve(summary);
    await expect(Promise.all([first, second])).resolves.toEqual([summary, summary]);
  });

  it.each([
    { includeSensitive: false, reset: false },
    { includeSensitive: false, reset: true },
    { includeSensitive: true, reset: false },
    { includeSensitive: true, reset: true },
  ])(
    "publishes current event-loop health after collection ($includeSensitive, $reset)",
    async ({ includeSensitive, reset }) => {
      const initial = {
        degraded: true,
        degradedSinceMs: 61_000,
        reasons: ["event_loop_delay" as const],
        intervalMs: 2_000,
        delayP99Ms: 1_500,
        delayMaxMs: 1_700,
        utilization: 0.2,
        cpuCoreRatio: 0.1,
      };
      let current: GatewayEventLoopHealth | undefined = initial;
      const pending = await startRefresh({
        probe: true,
        includeSensitive,
        getEventLoopHealth: () => current,
      });
      pending.summary.eventLoop = initial;
      current = reset
        ? undefined
        : { ...initial, delayP99Ms: 20, delayMaxMs: 25, cpuCoreRatio: 1.2 };
      pending.resolve(pending.summary);
      const result = await pending.promise;
      expect(result.eventLoop).toBe(current);
      if (includeSensitive) {
        expect(healthState.getHealthCache()).toBeNull();
        expect(healthState.getHealthVersion()).toBe(version);
        expect(broadcast).not.toHaveBeenCalled();
        const safe = await healthState.refreshGatewayHealthSnapshot({ probe: false });
        expect(healthState.getHealthCache()).toBe(safe);
        expect(healthState.getHealthVersion()).toBe(version + 1);
        expect(broadcast).toHaveBeenCalledExactlyOnceWith(safe);
      } else {
        expect(healthState.getHealthCache()).toBe(result);
        expect(broadcast).toHaveBeenCalledExactlyOnceWith(result);
      }
    },
  );

  it("passes the config reloader hot-reload status only when the hook returns one", async () => {
    await healthState.refreshGatewayHealthSnapshot({
      probe: false,
      getConfigReloaderHotReloadStatus: () => "disabled",
    });
    await healthState.refreshGatewayHealthSnapshot({
      probe: true,
      getConfigReloaderHotReloadStatus: () => undefined,
    });

    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
    expect(healthSnapshotCallArg()?.configReloadHotReloadStatus).toBe("disabled");
    expect(Object.hasOwn(healthSnapshotCallArg(1) ?? {}, "configReloadHotReloadStatus")).toBe(
      false,
    );
  });

  it("captures runtime snapshots for completed refreshes and guards snapshot failures", async () => {
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

    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
    expect(
      collectGatewayHealthSnapshotMock.mock.calls
        .map((_call, index) => healthSnapshotCallArg(index)?.probe)
        .toSorted((a, b) => Number(a) - Number(b)),
    ).toEqual([false, true]);
    expect(
      collectGatewayHealthSnapshotMock.mock.calls.map(
        (_call, index) => healthSnapshotCallArg(index)?.audience,
      ),
    ).toEqual(["public", "public"]);
    expect(healthSnapshotCallArg()?.runtimeSnapshot).toBe(runtimeSnapshot);
    expect(healthSnapshotCallArg(1)?.runtimeSnapshot).toBeUndefined();
  });

  it("keeps strength-aware admin and public refresh lanes isolated", async () => {
    const adminPassive = await startRefresh({ probe: false, includeSensitive: true });
    const publicProbe = await startRefresh({ probe: true });
    const publicPassive = healthState.refreshGatewayHealthSnapshot({ probe: false });
    const adminProbe = await startRefresh({ probe: true, includeSensitive: true });

    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(3);
    expect([0, 1, 2].map((index) => healthSnapshotCallArg(index))).toMatchObject([
      { audience: "admin", probe: false },
      { audience: "public", probe: true },
      { audience: "admin", probe: true },
    ]);

    adminProbe.resolve(adminProbe.summary);
    publicProbe.resolve(publicProbe.summary);
    adminPassive.resolve(adminPassive.summary);
    await expect(adminProbe.promise).resolves.toBe(adminProbe.summary);
    await expect(Promise.all([publicProbe.promise, publicPassive])).resolves.toEqual([
      publicProbe.summary,
      publicProbe.summary,
    ]);
    await expect(adminPassive.promise).resolves.toBe(adminPassive.summary);
    expect(healthState.getHealthCache()).toBe(publicProbe.summary);
  });

  it("retains displaced passive waiters after probe rejection and recovers the probe lane", async () => {
    const passive = await startRefresh({ probe: false });
    const probe = await startRefresh({ probe: true });
    const recoveredProbeSummary = createHealthSummary();
    collectGatewayHealthSnapshotMock.mockResolvedValueOnce(recoveredProbeSummary);
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
    probe.reject(new Error("probe failed"));
    await expect(probe.promise).rejects.toThrow("probe failed");

    const secondPassive = healthState.refreshGatewayHealthSnapshot({ probe: false });
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
    passive.resolve(passive.summary);
    await expect(Promise.all([passive.promise, secondPassive])).resolves.toEqual([
      passive.summary,
      passive.summary,
    ]);
    expect(healthState.getHealthCache()).toBe(passive.summary);

    await expect(healthState.refreshGatewayHealthSnapshot({ probe: true })).resolves.toBe(
      recoveredProbeSummary,
    );
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(3);
    expect(healthState.getHealthCache()).toBe(recoveredProbeSummary);
  });
});
