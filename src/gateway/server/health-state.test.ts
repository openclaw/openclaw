// Health-state tests cover probe coalescing, sensitive snapshots, and broadcast version behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import type { ConfigReloadObservation } from "../config-reload-observed.js";
import type { HealthSummary } from "../health/types.js";
import type { GatewayEventLoopHealth } from "./event-loop-health.js";

/**
 * Health-state cache tests covering coalescing, sensitive probes, and broadcasts.
 */
const {
  buildRuntimeConfigHealthMock,
  collectGatewayHealthSnapshotMock,
  getConfigReloadObservationMock,
  getRuntimeConfigSourceSnapshotMock,
  getRuntimeConfigSnapshotMetadataMock,
  getRuntimeConfigMock,
  getUpdateAvailableMock,
  getUpdateScheduleMock,
} = vi.hoisted(() => ({
  buildRuntimeConfigHealthMock: vi.fn(),
  collectGatewayHealthSnapshotMock: vi.fn(),
  getConfigReloadObservationMock: vi.fn((): ConfigReloadObservation => ({
    generation: 0,
    sourceConfig: null,
  })),
  getRuntimeConfigSourceSnapshotMock: vi.fn((): OpenClawConfig | null => null),
  getRuntimeConfigSnapshotMetadataMock: vi.fn(() => ({ revision: 0 })),
  getRuntimeConfigMock: vi.fn(),
  getUpdateAvailableMock: vi.fn(),
  getUpdateScheduleMock: vi.fn(),
}));

vi.mock("../../commands/health-runtime-config.js", () => ({
  buildRuntimeConfigHealth: buildRuntimeConfigHealthMock,
}));

vi.mock("../config-reload-observed.js", () => ({
  getConfigReloadObservation: getConfigReloadObservationMock,
}));

vi.mock("../../config/runtime-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/runtime-snapshot.js")>()),
  getRuntimeConfigAppliedHash: () => "internal-applied-hash",
  getRuntimeConfigSourceSnapshot: getRuntimeConfigSourceSnapshotMock,
  getRuntimeConfigSnapshotMetadata: getRuntimeConfigSnapshotMetadataMock,
}));

vi.mock("../health/collector.js", () => ({
  collectGatewayHealthSnapshot: collectGatewayHealthSnapshotMock,
}));

vi.mock("../../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/io.js")>()),
  getRuntimeConfig: getRuntimeConfigMock,
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
        sessionRowProjection?: unknown;
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
};

async function loadHealthState() {
  vi.resetModules();
  collectGatewayHealthSnapshotMock.mockReset();
  collectGatewayHealthSnapshotMock.mockResolvedValue(createHealthSummary());
  buildRuntimeConfigHealthMock.mockReset();
  buildRuntimeConfigHealthMock.mockReturnValue(undefined);
  getConfigReloadObservationMock.mockReset();
  getConfigReloadObservationMock.mockReturnValue({ generation: 0, sourceConfig: null });
  getRuntimeConfigSourceSnapshotMock.mockReset();
  getRuntimeConfigSourceSnapshotMock.mockReturnValue(null);
  getRuntimeConfigSnapshotMetadataMock.mockReset();
  getRuntimeConfigSnapshotMetadataMock.mockReturnValue({ revision: 0 });
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

  it.each([
    { agent: { model: "openai/gpt-5.6-luna" }, expected: true },
    { agent: {}, expected: false },
  ])("advertises modelConfigured=$expected for the default agent", async ({ agent, expected }) => {
    const healthState = await loadHealthState();
    getRuntimeConfigMock.mockReturnValue({
      agents: { entries: { main: agent } },
    });

    const snapshot = healthState.buildGatewaySnapshot({ client: null, revisionProjector });

    expect(snapshot.sessionDefaults?.modelConfigured).toBe(expected);
  });

  it.each([
    { role: "operator", scopes: ["operator.pairing"], allowed: false },
    { role: "node", scopes: ["operator.read", "operator.admin"], allowed: false },
    { role: "operator", scopes: ["operator.read"], allowed: true },
    { role: "operator", scopes: ["operator.write"], allowed: true },
    { role: "operator", scopes: ["operator.admin"], allowed: true },
  ])("resolves $role $scopes read access as $allowed", async ({ role, scopes, allowed }) => {
    const { canReadDetailedUpdateMetadata } = await import("../events.js");

    expect(canReadDetailedUpdateMetadata(role, scopes)).toBe(allowed);
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

  it("publishes one redacted runtime-config diagnostic to cache and broadcasts", async () => {
    const healthState = await loadHealthState();
    const broadcast = vi.fn();
    buildRuntimeConfigHealthMock.mockReturnValue({
      state: "drift",
      driftPaths: ["agents.defaults.model"],
      liveDefaultModel: "openai/gpt-5.6-sol",
      observedDefaultModel: "openai/gpt-5.6-terra",
    });
    healthState.setBroadcastHealthUpdate(broadcast);

    const published = await healthState.refreshGatewayHealthSnapshot({ probe: false });

    expect(buildRuntimeConfigHealthMock).toHaveBeenCalledOnce();
    expect(buildRuntimeConfigHealthMock).toHaveBeenCalledWith({
      liveSourceConfig: null,
      hasLiveSnapshot: true,
      observedSourceConfig: null,
    });
    expect(published.runtimeConfig).toEqual({
      state: "drift",
      driftPaths: ["agents.defaults.model"],
      liveDefaultModel: "openai/gpt-5.6-sol",
      observedDefaultModel: "openai/gpt-5.6-terra",
    });
    expect(healthState.getHealthCache()).toBe(published);
    expect(broadcast).toHaveBeenCalledWith(published);
    expect(JSON.stringify(published)).not.toContain("Fingerprint");
  });

  it("builds config health from the reloader's completed source observation", async () => {
    const healthState = await loadHealthState();
    const liveSourceConfig = { agents: { defaults: { model: "openai/gpt-5.6-sol" } } };
    const observedSourceConfig = { agents: { defaults: { model: "openai/gpt-5.6-terra" } } };
    getRuntimeConfigSourceSnapshotMock.mockReturnValue(liveSourceConfig);
    getConfigReloadObservationMock.mockReturnValue({
      generation: 7,
      sourceConfig: observedSourceConfig,
    });
    buildRuntimeConfigHealthMock.mockReturnValue({ state: "drift" });

    await healthState.refreshGatewayHealthSnapshot({ probe: false });

    expect(buildRuntimeConfigHealthMock).toHaveBeenCalledWith({
      liveSourceConfig,
      hasLiveSnapshot: true,
      observedSourceConfig,
    });
  });

  it("projects current config for hello while RPC and broadcast await full recollection", async () => {
    const healthState = await loadHealthState();
    const broadcast = vi.fn();
    const firstSourceConfig = { agents: { defaults: { model: "openai/gpt-5.6-sol" } } };
    const latestSourceConfig = { agents: { defaults: { model: "openai/gpt-5.6-terra" } } };
    let observation = { generation: 7, sourceConfig: firstSourceConfig };
    collectGatewayHealthSnapshotMock
      .mockResolvedValueOnce(createHealthSummary())
      .mockResolvedValueOnce(createHealthSummary());
    getRuntimeConfigSourceSnapshotMock.mockReturnValue(firstSourceConfig);
    getConfigReloadObservationMock.mockImplementation(() => observation);
    buildRuntimeConfigHealthMock
      .mockReturnValueOnce({ state: "ok" })
      .mockReturnValueOnce({ state: "drift", driftPaths: ["agents.defaults.model"] })
      .mockReturnValueOnce({ state: "drift", driftPaths: ["agents.defaults.model"] });
    healthState.setBroadcastHealthUpdate(broadcast);

    const first = await healthState.refreshGatewayHealthSnapshot({ probe: false });
    expect(first.runtimeConfig).toEqual({ state: "ok" });
    expect(healthState.getHealthCache()).toBe(first);
    const firstVersion = healthState.getHealthVersion();

    observation = { generation: 8, sourceConfig: latestSourceConfig };
    expect(healthState.getHealthCache()).toBeNull();
    expect(healthState.readCurrentRuntimeConfigHealth()).toEqual({
      state: "drift",
      driftPaths: ["agents.defaults.model"],
    });
    expect(healthState.getHealthCache()).toBeNull();
    expect(healthState.getHealthVersion()).toBe(firstVersion);
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledOnce();
    expect(broadcast.mock.calls.map(([snapshot]) => snapshot.runtimeConfig)).toEqual([
      { state: "ok" },
    ]);

    const current = await healthState.refreshGatewayHealthSnapshot({ probe: false });
    expect(current.runtimeConfig).toEqual({
      state: "drift",
      driftPaths: ["agents.defaults.model"],
    });
    expect(healthState.getHealthCache()).toBe(current);
    expect(healthState.getHealthVersion()).toBe(firstVersion + 1);
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
    expect(buildRuntimeConfigHealthMock).toHaveBeenCalledTimes(3);
    expect(buildRuntimeConfigHealthMock).toHaveBeenLastCalledWith({
      liveSourceConfig: firstSourceConfig,
      hasLiveSnapshot: true,
      observedSourceConfig: latestSourceConfig,
    });
    expect(broadcast.mock.calls.map(([snapshot]) => snapshot.runtimeConfig)).toEqual([
      { state: "ok" },
      { state: "drift", driftPaths: ["agents.defaults.model"] },
    ]);
  });

  it("retries publication when the observed generation advances during computation", async () => {
    const healthState = await loadHealthState();
    const firstSourceConfig = { agents: { defaults: { model: "openai/gpt-5.6-sol" } } };
    const latestSourceConfig = { agents: { defaults: { model: "openai/gpt-5.6-terra" } } };
    let observation = { generation: 11, sourceConfig: firstSourceConfig };
    getConfigReloadObservationMock.mockImplementation(() => observation);
    buildRuntimeConfigHealthMock
      .mockImplementationOnce(() => {
        observation = { generation: 12, sourceConfig: latestSourceConfig };
        return { state: "ok" };
      })
      .mockReturnValueOnce({ state: "drift", driftPaths: ["models"] });

    const published = await healthState.refreshGatewayHealthSnapshot({ probe: true });

    expect(published.runtimeConfig).toEqual({ state: "drift", driftPaths: ["models"] });
    expect(buildRuntimeConfigHealthMock).toHaveBeenCalledTimes(2);
    expect(
      buildRuntimeConfigHealthMock.mock.calls.map(([input]) => input.observedSourceConfig),
    ).toEqual([firstSourceConfig, latestSourceConfig]);
    expect(healthState.getHealthCache()).toBe(published);
  });

  it("retries publication when the live runtime revision advances before commit", async () => {
    const healthState = await loadHealthState();
    let revision = 11;
    getRuntimeConfigSnapshotMetadataMock.mockImplementation(() => ({ revision }));
    buildRuntimeConfigHealthMock
      .mockImplementationOnce(() => {
        revision += 1;
        return { state: "drift", driftPaths: ["models"] };
      })
      .mockReturnValueOnce({ state: "ok" });

    const published = await healthState.refreshGatewayHealthSnapshot({ probe: true });

    expect(published.runtimeConfig).toEqual({ state: "ok" });
    expect(buildRuntimeConfigHealthMock).toHaveBeenCalledTimes(2);
    expect(healthState.getHealthCache()).toBe(published);
  });

  it("recollects the whole snapshot when the runtime revision advances", async () => {
    const healthState = await loadHealthState();
    const firstCollection = createDeferred<HealthSummary>();
    const staleSummary = createHealthSummary();
    const currentSummary = createHealthSummary();
    const staleRuntime = { channels: {}, channelAccounts: { stale: {} } };
    const currentRuntime = { channels: {}, channelAccounts: { current: {} } };
    let revision = 21;
    getRuntimeConfigSnapshotMetadataMock.mockImplementation(() => ({ revision }));
    // Advance the revision once collection has started: refresh first awaits the
    // lazy collector import, so a synchronous bump would precede the first read.
    collectGatewayHealthSnapshotMock
      .mockImplementationOnce(() => {
        revision += 1;
        return firstCollection.promise;
      })
      .mockResolvedValueOnce(currentSummary);
    const getRuntimeSnapshot = vi
      .fn()
      .mockReturnValueOnce(staleRuntime)
      .mockReturnValueOnce(currentRuntime);

    const refresh = healthState.refreshGatewayHealthSnapshot({
      probe: false,
      getRuntimeSnapshot,
    });
    firstCollection.resolve(staleSummary);

    await expect(refresh).resolves.toBe(currentSummary);
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
    expect(healthSnapshotCallArg()?.runtimeSnapshot).toBe(staleRuntime);
    expect(healthSnapshotCallArg(1)?.runtimeSnapshot).toBe(currentRuntime);
    expect(buildRuntimeConfigHealthMock).toHaveBeenCalledOnce();
    expect(healthState.getHealthCache()).toBe(currentSummary);
  });

  it("does not let a post-connect passive refresh absorb an explicit probe", async () => {
    const healthState = await loadHealthState();
    const passiveDeferred = createPendingHealthSnapshot();
    const probeDeferred = createPendingHealthSnapshot();
    const passiveSummary = createHealthSummary();
    const probeSummary = createHealthSummary();
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
    expect(healthState.getHealthCache()).toBe(probeSummary);
    expect(healthState.getHealthVersion()).toBe(version + 1);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("publishes both generations in order when the passive refresh finishes first", async () => {
    const healthState = await loadHealthState();
    const passiveDeferred = createPendingHealthSnapshot();
    const probeDeferred = createPendingHealthSnapshot();
    const passiveSummary = createHealthSummary();
    const probeSummary = createHealthSummary();
    const broadcast = vi.fn();
    collectGatewayHealthSnapshotMock
      .mockImplementationOnce(passiveDeferred.collect)
      .mockImplementationOnce(probeDeferred.collect);
    healthState.setBroadcastHealthUpdate(broadcast);
    const version = healthState.getHealthVersion();

    const passive = healthState.refreshGatewayHealthSnapshot({ probe: false });
    await passiveDeferred.started;
    const probe = healthState.refreshGatewayHealthSnapshot({ probe: true });
    await probeDeferred.started;

    passiveDeferred.resolve(passiveSummary);
    await expect(passive).resolves.toBe(passiveSummary);
    expect(healthState.getHealthCache()).toBe(passiveSummary);
    expect(healthState.getHealthVersion()).toBe(version + 1);

    probeDeferred.resolve(probeSummary);
    await expect(probe).resolves.toBe(probeSummary);
    expect(healthState.getHealthCache()).toBe(probeSummary);
    expect(healthState.getHealthVersion()).toBe(version + 2);
    expect(broadcast.mock.calls.map(([summary]) => summary)).toEqual([
      passiveSummary,
      probeSummary,
    ]);
  });

  it("lets a passive refresh join an in-flight explicit probe", async () => {
    const healthState = await loadHealthState();
    const probeDeferred = createPendingHealthSnapshot();
    const probeSummary = createHealthSummary();
    collectGatewayHealthSnapshotMock.mockImplementationOnce(probeDeferred.collect);

    const probe = healthState.refreshGatewayHealthSnapshot({ probe: true });
    const passive = healthState.refreshGatewayHealthSnapshot({ probe: false });

    await probeDeferred.started;
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(1);
    expect(healthSnapshotCallArg()?.probe).toBe(true);
    probeDeferred.resolve(probeSummary);
    await expect(Promise.all([probe, passive])).resolves.toEqual([probeSummary, probeSummary]);
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

  it("detaches an older passive refresh after a newer probe succeeds", async () => {
    const healthState = await loadHealthState();
    const firstPassiveDeferred = createPendingHealthSnapshot();
    const probeDeferred = createPendingHealthSnapshot();
    const secondPassiveDeferred = createPendingHealthSnapshot();
    const firstPassiveSummary = createHealthSummary();
    const probeSummary = createHealthSummary();
    const secondPassiveSummary = createHealthSummary();
    collectGatewayHealthSnapshotMock
      .mockImplementationOnce(firstPassiveDeferred.collect)
      .mockImplementationOnce(probeDeferred.collect)
      .mockImplementationOnce(secondPassiveDeferred.collect);

    const firstPassive = healthState.refreshGatewayHealthSnapshot({ probe: false });
    await firstPassiveDeferred.started;
    const probe = healthState.refreshGatewayHealthSnapshot({ probe: true });
    await probeDeferred.started;
    probeDeferred.resolve(probeSummary);
    await expect(probe).resolves.toBe(probeSummary);

    const secondPassive = healthState.refreshGatewayHealthSnapshot({ probe: false });
    await secondPassiveDeferred.started;
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(3);
    secondPassiveDeferred.resolve(secondPassiveSummary);
    await expect(secondPassive).resolves.toBe(secondPassiveSummary);
    expect(healthState.getHealthCache()).toBe(secondPassiveSummary);

    firstPassiveDeferred.resolve(firstPassiveSummary);
    await expect(firstPassive).resolves.toBe(firstPassiveSummary);
    expect(healthState.getHealthCache()).toBe(secondPassiveSummary);
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

  it("passes the current resident session-row projection to health collection", async () => {
    const healthState = await loadHealthState();
    const projection = {};

    await healthState.refreshGatewayHealthSnapshot({
      probe: false,
      getSessionRowProjection: () => projection as never,
    });

    expect(healthSnapshotCallArg()?.sessionRowProjection).toBe(projection);
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

  it.each([
    { includeSensitive: false, label: "public" },
    { includeSensitive: true, label: "sensitive" },
  ])("releases the $label refresh lane after rejection", async ({ includeSensitive }) => {
    const healthState = await loadHealthState();
    const recovered = createHealthSummary();
    collectGatewayHealthSnapshotMock
      .mockRejectedValueOnce(new Error("snapshot failed"))
      .mockResolvedValueOnce(recovered);

    await expect(
      healthState.refreshGatewayHealthSnapshot({ probe: false, includeSensitive }),
    ).rejects.toThrow("snapshot failed");
    await expect(
      healthState.refreshGatewayHealthSnapshot({ probe: false, includeSensitive }),
    ).resolves.toBe(recovered);

    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
  });
});
