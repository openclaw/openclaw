import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelId } from "../../channels/plugins/index.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import {
  createAgentDatabaseInspectionRefusal,
  type AgentDatabaseAdmissionRefusal,
} from "../../state/agent-database-admission.js";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import type { ChannelManager } from "../server-channels.js";
import type { GatewayPluginReloadStatus } from "../server-plugin-reload-status.types.js";
import type { GatewayEventLoopHealth } from "./event-loop-health.js";
import { createReadinessChecker } from "./readiness.js";

const FIVE_MIN_MS = 5 * 60_000;
const THIRTY_ONE_MIN_MS = 31 * 60_000;

function snapshotWith(
  accounts: Record<string, Partial<ChannelAccountSnapshot>>,
): ChannelRuntimeSnapshot {
  const channels: ChannelRuntimeSnapshot["channels"] = {};
  const channelAccounts: ChannelRuntimeSnapshot["channelAccounts"] = {};

  for (const [channelId, accountSnapshot] of Object.entries(accounts)) {
    const resolved = { accountId: "default", ...accountSnapshot } as ChannelAccountSnapshot;
    channels[channelId as ChannelId] = resolved;
    channelAccounts[channelId as ChannelId] = { default: resolved };
  }

  return { channels, channelAccounts };
}

function createManager(snapshot: ChannelRuntimeSnapshot) {
  return {
    getRuntimeSnapshot: vi.fn(() => snapshot),
    getAutostartSuppression: vi.fn<ChannelManager["getAutostartSuppression"]>(() => null),
    isAmbientAutostartSuppressed: vi.fn<ChannelManager["isAmbientAutostartSuppressed"]>(
      () => false,
    ),
  };
}

type ReadinessOptions = Omit<
  Parameters<typeof createReadinessChecker>[0],
  "channelManager" | "startedAt"
>;
function createReadinessHarness({
  startedAgoMs = FIVE_MIN_MS,
  accounts = {},
  ...options
}: ReadinessOptions & {
  startedAgoMs?: number;
  accounts?: Record<string, Partial<ChannelAccountSnapshot>>;
}) {
  const manager = createManager(snapshotWith(accounts));
  return {
    manager,
    readiness: createReadinessChecker({
      channelManager: manager,
      startedAt: Date.now() - startedAgoMs,
      ...options,
    }),
  };
}

function managedAccount(
  overrides: Partial<ChannelAccountSnapshot> = {},
): Partial<ChannelAccountSnapshot> {
  return {
    running: true,
    connected: true,
    enabled: true,
    configured: true,
    lastStartAt: Date.now() - FIVE_MIN_MS,
    ...overrides,
  };
}

const stoppedAccount = (overrides: Partial<ChannelAccountSnapshot> = {}) =>
  managedAccount({ running: false, ...overrides });

function discordHarness(
  account: Partial<ChannelAccountSnapshot>,
  options: ReadinessOptions & { startedAgoMs?: number } = {},
) {
  return createReadinessHarness({ accounts: { discord: managedAccount(account) }, ...options });
}

function readySnapshot(
  uptimeMs = FIVE_MIN_MS,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ready: true, failing: [], uptimeMs, ...extra };
}

function failingSnapshot(failing: string[], uptimeMs = FIVE_MIN_MS): Record<string, unknown> {
  return { ready: false, failing, uptimeMs };
}

describe("createReadinessChecker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());
  it.each([
    ["startup-sidecars", "getStartupPending"],
    ["gateway-draining", "getGatewayDraining"],
  ] as const)("does not cache %s readiness", (reason, getter) => {
    let pending = true;
    const { manager, readiness } = createReadinessHarness({
      [getter]: () => pending,
      cacheTtlMs: 1_000,
    });
    expect(readiness()).toEqual(failingSnapshot([reason]));
    expect(manager.getRuntimeSnapshot).not.toHaveBeenCalled();
    pending = false;
    expect(readiness()).toEqual(readySnapshot());
    expect(manager.getRuntimeSnapshot).toHaveBeenCalledTimes(1);
  });

  it("reports a terminal state database failure immediately and discards cached channel health", () => {
    let failure: Error | undefined;
    const { manager, readiness } = createReadinessHarness({
      getStateDatabaseFailure: () => failure,
      cacheTtlMs: 1_000,
    });
    expect(readiness()).toEqual(readySnapshot());

    failure = new Error("newer shared-state schema");
    expect(readiness()).toEqual({
      ...failingSnapshot(["state-database"]),
      stateDatabase: { reason: "newer shared-state schema" },
    });
    expect(manager.getRuntimeSnapshot).toHaveBeenCalledTimes(1);

    failure = undefined;
    expect(readiness()).toEqual(readySnapshot());
    expect(manager.getRuntimeSnapshot).toHaveBeenCalledTimes(2);
  });

  it("reports plugin replacement recovery immediately and resumes channel readiness after settlement", () => {
    let pluginReload: GatewayPluginReloadStatus | undefined;
    const { manager, readiness } = discordHarness(
      { lastTransportActivityAt: Date.now() },
      { getPluginReloadStatus: () => pluginReload },
    );
    expect(readiness()).toEqual(readySnapshot());

    manager.getRuntimeSnapshot.mockReturnValue(
      snapshotWith({ discord: stoppedAccount({ connected: false }) }),
    );

    pluginReload = {
      phase: "recovering",
      pluginIds: ["discord"],
      deadlineAtMs: Date.now() + 5_000,
      reason: "Waiting for admitted work before restoring the previous plugin runtime.",
    };
    expect(readiness()).toEqual({
      ...failingSnapshot(["plugin-reload"]),
      pluginReload,
    });
    pluginReload = {
      phase: "failed",
      pluginIds: ["discord"],
      reason: "Plugin recovery failed; inspect discord and restart the Gateway.",
    };
    expect(readiness()).toEqual({
      ...failingSnapshot(["plugin-reload"]),
      pluginReload,
    });

    pluginReload = undefined;
    expect(readiness()).toEqual(failingSnapshot(["discord"]));
  });

  it.each([
    { skipChannels: false, channelFailed: false },
    { skipChannels: true, channelFailed: false },
    { skipChannels: false, channelFailed: true },
  ])(
    "reports warming, failed, and recovered core agents (skip channels: $skipChannels, channel failed: $channelFailed)",
    ({ skipChannels, channelFailed }) => {
      const pending = createAgentDatabaseInspectionRefusal({
        agentId: "main",
        paths: ["/isolated/agents/main/openclaw-agent.sqlite"],
        reason: "Startup inspection and preparation are still running.",
        pending: true,
      });
      const refusal = createAgentDatabaseInspectionRefusal({
        agentId: "main",
        paths: ["/isolated/agents/main/openclaw-agent.sqlite"],
        reason: "Session identities require migration before this agent can run.",
      });
      let refusals: AgentDatabaseAdmissionRefusal[] = [];
      const { readiness } = createReadinessHarness({
        accounts: channelFailed ? { discord: stoppedAccount({ connected: false }) } : {},
        cacheTtlMs: 1_000,
        shouldSkipChannelReadiness: () => skipChannels,
        getAgentDatabaseAdmissionRefusals: () => refusals,
      });
      const channelReadiness = channelFailed ? failingSnapshot(["discord"]) : readySnapshot();
      expect(readiness()).toEqual(channelReadiness);

      refusals = [pending];
      expect(readiness()).toEqual({
        ...failingSnapshot(["agent-database:main"]),
        agentDatabases: [pending],
      });

      refusals = [refusal];
      expect(readiness()).toEqual({
        ...failingSnapshot(["agent-database:main"]),
        agentDatabases: [refusal],
      });

      refusals = [];
      expect(readiness()).toEqual(channelReadiness);
    },
  );

  it.each([undefined, "ready"] as const)(
    "applies startup grace only before lifecycle readiness (%s)",
    (lifecycle) => {
      const { readiness } = discordHarness(
        {
          connected: false,
          lifecycle,
          lastStartAt: Date.now() - 30_000,
        },
        { startedAgoMs: 30_000 },
      );
      expect(readiness()).toEqual(
        lifecycle ? failingSnapshot(["discord"], 30_000) : readySnapshot(30_000),
      );
    },
  );

  it.each(["crash-loop", "ambient"] as const)(
    "reports %s suppressed stopped channels without failing readiness",
    (suppression) => {
      const { manager, readiness } = discordHarness({
        running: false,
        restartPending: false,
        lastError: suppression === "crash-loop" ? "safe mode" : "ambient credentials suppressed",
      });
      if (suppression === "crash-loop") {
        manager.getAutostartSuppression.mockReturnValue({
          reason: "crash-loop-breaker",
          message: "safe mode",
        });
      } else {
        manager.isAmbientAutostartSuppressed.mockImplementation(
          (channelId) => channelId === "discord",
        );
      }
      expect(readiness()).toEqual(readySnapshot(FIVE_MIN_MS, { suppressed: ["discord"] }));
    },
  );

  it("keeps a dead-ingress channel ready while its restart backoff is still pending", () => {
    const startedAt = Date.now() - FIVE_MIN_MS;
    const { readiness } = discordHarness({
      running: false,
      restartPending: true,
      ingressUnavailable: true,
      reconnectAttempts: 3,
      lastStartAt: startedAt - 30_000,
      lastStopAt: Date.now() - 5_000,
    });
    expect(readiness()).toEqual(readySnapshot());
  });

  it("fails readiness for a running channel whose transport is up but ingress is dead", () => {
    const { readiness } = discordHarness({
      running: true,
      connected: true,
      restartPending: true,
      ingressUnavailable: true,
      lastStartAt: Date.now() - THIRTY_ONE_MIN_MS,
    });
    expect(readiness()).toEqual(failingSnapshot(["discord"]));
  });

  it("treats stale-socket channels as ready to avoid pulling healthy idle pods", () => {
    const { readiness } = discordHarness(
      {
        lastStartAt: Date.now() - THIRTY_ONE_MIN_MS,
        lastTransportActivityAt: Date.now() - THIRTY_ONE_MIN_MS,
      },
      { startedAgoMs: THIRTY_ONE_MIN_MS },
    );
    expect(readiness()).toEqual(readySnapshot(THIRTY_ONE_MIN_MS));
  });

  it("caches readiness snapshots briefly to keep repeated probes cheap", () => {
    const { manager, readiness } = discordHarness(
      {
        lastTransportActivityAt: Date.now() - 1_000,
      },
      { cacheTtlMs: 1_000 },
    );
    expect(readiness()).toEqual(readySnapshot());
    vi.advanceTimersByTime(500);
    expect(readiness()).toEqual(readySnapshot(300_500));
    expect(manager.getRuntimeSnapshot).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(600);
    expect(readiness()).toEqual(readySnapshot(301_100));
    expect(manager.getRuntimeSnapshot).toHaveBeenCalledTimes(2);
  });

  it("refreshes stopped channels when the clock moves behind cached readiness", () => {
    const { manager, readiness } = createReadinessHarness({
      accounts: { discord: managedAccount({ lifecycle: "ready" }) },
      cacheTtlMs: 1_000,
    });

    expect(readiness()).toEqual(readySnapshot());
    manager.getRuntimeSnapshot.mockReturnValue(
      snapshotWith({ discord: stoppedAccount({ connected: false, lifecycle: "stopped" }) }),
    );
    vi.setSystemTime(Date.now() - 60_000);

    expect(readiness()).toEqual(failingSnapshot(["discord"], FIVE_MIN_MS - 60_000));
    expect(manager.getRuntimeSnapshot).toHaveBeenCalledTimes(2);
  });

  it("adds event-loop health to detailed readiness without changing readiness state", () => {
    const eventLoop: GatewayEventLoopHealth = {
      degraded: true,
      degradedSinceMs: 61_000,
      reasons: ["cpu", "event_loop_utilization"],
      intervalMs: 2_000,
      delayP99Ms: 42.1,
      delayMaxMs: 88.7,
      utilization: 0.991,
      cpuCoreRatio: 0.973,
    };
    const { readiness } = createReadinessHarness({
      getEventLoopHealth: () => structuredClone(eventLoop),
    });
    expect(readiness()).toEqual(readySnapshot(FIVE_MIN_MS, { eventLoop }));
  });
});
