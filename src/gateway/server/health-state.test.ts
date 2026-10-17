// Health-state tests cover probe coalescing, sensitive snapshots, and broadcast version behavior.
import "../../test-utils/prepare-compiled-subprocesses.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import type { HealthSummary } from "../health/types.js";
import type { GatewayEventLoopHealth } from "./event-loop-health.js";

/**
 * Health-state cache tests covering coalescing, sensitive probes, and broadcasts.
 */
const {
  collectGatewayHealthSnapshotMock,
  getRuntimeConfigMock,
  getUpdateAvailableMock,
  getUpdateScheduleMock,
} = vi.hoisted(() => ({
  collectGatewayHealthSnapshotMock: vi.fn(),
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
  return collectGatewayHealthSnapshotMock.mock.calls.at(index)?.at(0) as
    | {
        audience?: "public" | "admin";
        eventLoop?: unknown;
        probe?: boolean;
        runtimeSnapshot?: unknown;
        configReloadHotReloadStatus?: unknown;
      }
    | undefined;
}

// Vitest manual mocks cannot resolve concurrent imports from one module. Enter
// each collector separately while keeping its result pending to test overlap.
function createPendingHealthSnapshot() {
  const started = createDeferred();
  const result = createDeferred<HealthSummary>();
  return {
    ...result,
    started: started.promise,
    collect: () => {
      started.resolve();
      return result.promise;
    },
  };
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

describe("buildGatewaySnapshot update metadata", () => {
  it("reads suspension synchronously without waiting for health collection", async () => {
    const healthState = await loadHealthState();
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
    const healthState = await loadHealthState();
    getUpdateAvailableMock.mockReturnValue({
      currentVersion: "2026.8.7",
      latestVersion: "2026.8.8",
      channel: "dev",
      currentSha: "1111111111111111111111111111111111111111",
      upstreamRef: "origin/main",
      upstreamSha: "2222222222222222222222222222222222222222",
      commitsBehind: 1,
      commits: [{ sha: "2222222", subject: "Detailed commit subject" }],
    });
    getUpdateScheduleMock.mockReturnValue({
      channel: "dev",
      autoEnabled: true,
      install: { kind: "git" },
    });

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
    const healthState = await loadHealthState();
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
    const updateSchedule = {
      channel: "dev",
      autoEnabled: true,
      install: { kind: "git" as const },
    };
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
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("refreshes diagnostics without rebroadcasting clock and activity changes", async () => {
    const healthState = await loadHealthState();
    const broadcast = vi.fn();
    healthState.setBroadcastHealthUpdate(broadcast);
    const version = healthState.getHealthVersion();
    const snapshot = (time: number): HealthSummary => ({
      ...createHealthSummary(),
      ts: time,
      durationMs: time,
      eventLoop: {
        degraded: false,
        degradedSinceMs: null,
        reasons: [],
        intervalMs: time,
        delayP99Ms: time,
        delayMaxMs: time,
        utilization: time / 1000,
        cpuCoreRatio: time / 1000,
      },
      channels: {
        example: {
          accountId: "default",
          connected: true,
          accounts: {
            default: {
              accountId: "default",
              connected: true,
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
      sessions: {
        path: "/synthetic/sessions",
        count: time,
        recent: [{ key: `agent:main:session-${time}`, age: time, updatedAt: time }],
      },
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
          sessions: {
            path: "/synthetic/sessions",
            count: time,
            recent: [{ key: `agent:main:session-${time}`, age: time, updatedAt: time }],
          },
        },
      ],
    });
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
    const healthState = await loadHealthState();
    const broadcast = vi.fn();
    healthState.setBroadcastHealthUpdate(broadcast);
    const initial = createHealthSummary();
    const eventLoop = {
      degraded: false,
      reasons: [],
      intervalMs: 1_000,
      delayP99Ms: 10,
      delayMaxMs: 20,
      utilization: 0.1,
      cpuCoreRatio: 0.1,
    } satisfies HealthSummary["eventLoop"];
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
      { ...initial, eventLoop: { ...eventLoop, degraded: true, reasons: ["event_loop_delay"] } },
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

  it("does not let a post-connect passive refresh absorb an explicit probe", async () => {
    const healthState = await loadHealthState();
    const passiveDeferred = createPendingHealthSnapshot();
    const probeDeferred = createPendingHealthSnapshot();
    const passiveSummary = createHealthSummary();
    const probeSummary = createHealthSummary();
    probeSummary.channels = {
      example: { accountId: "default", probe: { ok: false, error: "offline" } },
    };
    const broadcast = vi.fn();
    collectGatewayHealthSnapshotMock
      .mockImplementationOnce(passiveDeferred.collect)
      .mockImplementationOnce(probeDeferred.collect);
    healthState.setBroadcastHealthUpdate(broadcast);
    const version = healthState.getHealthVersion();

    const postConnectRefresh = healthState.refreshGatewayHealthSnapshot({ probe: false });
    await passiveDeferred.started;
    const explicitProbe = healthState.refreshGatewayHealthSnapshot({ probe: true });
    await probeDeferred.started;

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

    probeDeferred.resolve(probeSummary);
    await expect(explicitProbe).resolves.toBe(probeSummary);
    expect(healthState.getHealthCache()).toBe(probeSummary);
    expect(healthState.getHealthVersion()).toBe(version + 1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenLastCalledWith(probeSummary);

    passiveDeferred.resolve(passiveSummary);
    await expect(postConnectRefresh).resolves.toBe(passiveSummary);
    expect(healthState.getHealthCache()).toBe(passiveSummary);
    expect(healthState.getHealthVersion()).toBe(version + 2);
    expect(broadcast.mock.calls.map(([summary]) => summary)).toEqual([
      probeSummary,
      passiveSummary,
    ]);
  });

  it("coalesces concurrent explicit probe waiters", async () => {
    const healthState = await loadHealthState();
    const probeDeferred = createPendingHealthSnapshot();
    const probeSummary = createHealthSummary();
    collectGatewayHealthSnapshotMock.mockImplementationOnce(probeDeferred.collect);

    const first = healthState.refreshGatewayHealthSnapshot({ probe: true });
    const second = healthState.refreshGatewayHealthSnapshot({ probe: true });

    await probeDeferred.started;
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(1);
    probeDeferred.resolve(probeSummary);
    await expect(Promise.all([first, second])).resolves.toEqual([probeSummary, probeSummary]);
  });

  it("retains a displaced passive refresh after a faster probe settles", async () => {
    const healthState = await loadHealthState();
    const passiveDeferred = createPendingHealthSnapshot();
    const probeDeferred = createPendingHealthSnapshot();
    const passiveSummary = createHealthSummary();
    collectGatewayHealthSnapshotMock
      .mockImplementationOnce(passiveDeferred.collect)
      .mockImplementationOnce(probeDeferred.collect);

    const firstPassive = healthState.refreshGatewayHealthSnapshot({ probe: false });
    await passiveDeferred.started;
    const probe = healthState.refreshGatewayHealthSnapshot({ probe: true });
    await probeDeferred.started;
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
    probeDeferred.reject(new Error("probe failed"));
    await expect(probe).rejects.toThrow("probe failed");

    const secondPassive = healthState.refreshGatewayHealthSnapshot({ probe: false });
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
    passiveDeferred.resolve(passiveSummary);
    await expect(Promise.all([firstPassive, secondPassive])).resolves.toEqual([
      passiveSummary,
      passiveSummary,
    ]);
  });

  it.each([
    { includeSensitive: false, reset: false },
    { includeSensitive: false, reset: true },
    { includeSensitive: true, reset: false },
    { includeSensitive: true, reset: true },
  ])(
    "publishes current event-loop health after collection ($includeSensitive, $reset)",
    async ({ includeSensitive, reset }) => {
      const healthState = await loadHealthState();
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
      const started = createDeferred();
      const release = createDeferred();
      const broadcast = vi.fn();
      healthState.setBroadcastHealthUpdate(broadcast);
      collectGatewayHealthSnapshotMock.mockImplementationOnce(
        async (params: { eventLoop?: HealthSummary["eventLoop"] }) => {
          started.resolve();
          await release.promise;
          return {
            ...createHealthSummary(),
            ...(params.eventLoop ? { eventLoop: params.eventLoop } : {}),
          };
        },
      );
      const pending = healthState.refreshGatewayHealthSnapshot({
        probe: true,
        includeSensitive,
        getEventLoopHealth: () => current,
      });
      await started.promise;
      current = reset
        ? undefined
        : { ...initial, delayP99Ms: 20, delayMaxMs: 25, cpuCoreRatio: 1.2 };
      release.resolve();
      const result = await pending;
      expect(result.eventLoop).toBe(current);
      if (includeSensitive) {
        expect(broadcast).not.toHaveBeenCalled();
      } else {
        expect(healthState.getHealthCache()).toBe(result);
        expect(broadcast).toHaveBeenCalledExactlyOnceWith(result);
      }
    },
  );

  it("passes the config reloader hot-reload status only when the hook returns one", async () => {
    const healthState = await loadHealthState();

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

  it("does not cache or broadcast sensitive health refreshes", async () => {
    const healthState = await loadHealthState();
    const sensitiveSummary = createHealthSummary();
    const safeSummary = createHealthSummary();
    const broadcast = vi.fn();
    collectGatewayHealthSnapshotMock
      .mockResolvedValueOnce(sensitiveSummary)
      .mockResolvedValueOnce(safeSummary);
    healthState.setBroadcastHealthUpdate(broadcast);
    const version = healthState.getHealthVersion();

    await healthState.refreshGatewayHealthSnapshot({ probe: true, includeSensitive: true });

    expect(healthState.getHealthCache()).toBeNull();
    expect(healthState.getHealthVersion()).toBe(version);
    expect(broadcast).not.toHaveBeenCalled();

    await healthState.refreshGatewayHealthSnapshot({ probe: false });

    expect(healthState.getHealthCache()).toBe(safeSummary);
    expect(healthState.getHealthVersion()).toBe(version + 1);
    expect(broadcast).toHaveBeenCalledWith(safeSummary);
  });

  it("keeps strength-aware admin and public refresh lanes isolated", async () => {
    const healthState = await loadHealthState();
    const adminPassiveDeferred = createPendingHealthSnapshot();
    const publicProbeDeferred = createPendingHealthSnapshot();
    const adminProbeDeferred = createPendingHealthSnapshot();
    const adminPassiveSummary = createHealthSummary();
    const publicProbeSummary = createHealthSummary();
    const adminProbeSummary = createHealthSummary();
    collectGatewayHealthSnapshotMock
      .mockImplementationOnce(adminPassiveDeferred.collect)
      .mockImplementationOnce(publicProbeDeferred.collect)
      .mockImplementationOnce(adminProbeDeferred.collect);

    const adminPassive = healthState.refreshGatewayHealthSnapshot({
      probe: false,
      includeSensitive: true,
    });
    await adminPassiveDeferred.started;
    const publicProbe = healthState.refreshGatewayHealthSnapshot({ probe: true });
    await publicProbeDeferred.started;
    const publicPassive = healthState.refreshGatewayHealthSnapshot({ probe: false });
    const adminProbe = healthState.refreshGatewayHealthSnapshot({
      probe: true,
      includeSensitive: true,
    });
    await adminProbeDeferred.started;

    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(3);
    expect(healthSnapshotCallArg()?.audience).toBe("admin");
    expect(healthSnapshotCallArg(1)?.audience).toBe("public");
    expect(healthSnapshotCallArg(2)?.audience).toBe("admin");
    expect(healthSnapshotCallArg()?.probe).toBe(false);
    expect(healthSnapshotCallArg(1)?.probe).toBe(true);
    expect(healthSnapshotCallArg(2)?.probe).toBe(true);

    adminProbeDeferred.resolve(adminProbeSummary);
    publicProbeDeferred.resolve(publicProbeSummary);
    adminPassiveDeferred.resolve(adminPassiveSummary);

    await expect(adminProbe).resolves.toBe(adminProbeSummary);
    await expect(Promise.all([publicProbe, publicPassive])).resolves.toEqual([
      publicProbeSummary,
      publicProbeSummary,
    ]);
    await expect(adminPassive).resolves.toBe(adminPassiveSummary);
    expect(healthState.getHealthCache()).toBe(publicProbeSummary);
  });

  it("recovers each strength lane after rejection without discarding an older success", async () => {
    const healthState = await loadHealthState();
    const passiveDeferred = createPendingHealthSnapshot();
    const probeDeferred = createPendingHealthSnapshot();
    const passiveSummary = createHealthSummary();
    const recoveredProbeSummary = createHealthSummary();
    collectGatewayHealthSnapshotMock
      .mockImplementationOnce(passiveDeferred.collect)
      .mockImplementationOnce(probeDeferred.collect)
      .mockResolvedValueOnce(recoveredProbeSummary);

    const passive = healthState.refreshGatewayHealthSnapshot({ probe: false });
    await passiveDeferred.started;
    const probe = healthState.refreshGatewayHealthSnapshot({ probe: true });
    await probeDeferred.started;
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
    probeDeferred.reject(new Error("probe failed"));
    await expect(probe).rejects.toThrow("probe failed");

    passiveDeferred.resolve(passiveSummary);
    await expect(passive).resolves.toBe(passiveSummary);
    expect(healthState.getHealthCache()).toBe(passiveSummary);

    await expect(healthState.refreshGatewayHealthSnapshot({ probe: true })).resolves.toBe(
      recoveredProbeSummary,
    );
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(3);
    expect(healthState.getHealthCache()).toBe(recoveredProbeSummary);
  });
});
