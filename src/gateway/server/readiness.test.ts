import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import {
  createAgentDatabaseInspectionRefusal,
  type AgentDatabaseAdmissionRefusal,
} from "../../state/agent-database-admission.js";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import type { ChannelManager } from "../server-channels.js";
import type { GatewayPluginReloadStatus } from "../server-plugin-reload-status.types.js";
import type { GatewayEventLoopHealth } from "./event-loop-health.js";
import { createReadinessChecker, createStartupChecker } from "./readiness.js";

const FIVE_MIN_MS = 5 * 60_000;
const THIRTY_ONE_MIN_MS = 31 * 60_000;

function snapshotWith(account?: Partial<ChannelAccountSnapshot>): ChannelRuntimeSnapshot {
  if (!account) {
    return { channels: {}, channelAccounts: {} };
  }
  const resolved = {
    accountId: "default",
    running: true,
    connected: true,
    enabled: true,
    configured: true,
    lastStartAt: Date.now() - FIVE_MIN_MS,
    ...account,
  };
  return { channels: { discord: resolved }, channelAccounts: { discord: { default: resolved } } };
}

type ReadinessOptions = Omit<
  Parameters<typeof createReadinessChecker>[0],
  "channelManager" | "startedAt"
>;
function setup(
  account?: Partial<ChannelAccountSnapshot>,
  { startedAgoMs = FIVE_MIN_MS, ...options }: ReadinessOptions & { startedAgoMs?: number } = {},
) {
  const snapshot = snapshotWith(account);
  const manager = {
    getRuntimeSnapshot: vi.fn(() => snapshot),
    getAutostartSuppression: vi.fn<ChannelManager["getAutostartSuppression"]>(() => null),
    isAmbientAutostartSuppressed: vi.fn<ChannelManager["isAmbientAutostartSuppressed"]>(
      () => false,
    ),
  };
  return {
    manager,
    readiness: createReadinessChecker({
      channelManager: manager,
      startedAt: Date.now() - startedAgoMs,
      ...options,
    }),
  };
}

function readySnapshot(
  uptimeMs = FIVE_MIN_MS,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ready: true, coreReady: true, failing: [], uptimeMs, ...extra };
}

function failingSnapshot(
  failing: string[],
  uptimeMs = FIVE_MIN_MS,
  coreReady = false,
): Record<string, unknown> {
  return { ready: false, coreReady, failing, uptimeMs };
}

describe("createReadinessChecker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());
  it("reports deferred recovery per agent using required-agent readiness policy", () => {
    let pending = ["owner"];
    const { readiness } = setup(undefined, {
      getPendingAgentInputRecovery: () => pending,
      isRequiredAgent: (agentId) => agentId === "main",
    });
    expect(readiness()).toEqual(readySnapshot(FIVE_MIN_MS, { agentRecovery: ["owner"] }));
    pending = ["owner", "main"];
    expect(readiness()).toEqual({
      ...failingSnapshot(["chat-recovery:main"]),
      agentRecovery: ["owner", "main"],
    });
    pending = [];
    expect(readiness()).toEqual(readySnapshot());
  });
  it("keeps traffic unready until saved input recovery releases chat admission", () => {
    const unavailableMethods = new Set(["chat.send"]);
    const deps = {
      startedAt: Date.now() - FIVE_MIN_MS,
      isChatSendAvailable: () => !unavailableMethods.has("chat.send"),
    };
    const { readiness, manager } = setup(undefined, deps);

    // Startup completion releases recovery's background-work barrier; it cannot await recovery.
    expect(createStartupChecker(deps)()).toEqual({
      ok: true,
      status: "started",
      uptimeMs: FIVE_MIN_MS,
    });
    expect(readiness()).toEqual(failingSnapshot(["chat-recovery"]));
    expect(manager.getRuntimeSnapshot).not.toHaveBeenCalled();

    unavailableMethods.clear();
    expect(readiness()).toEqual(readySnapshot());
    unavailableMethods.add("chat.send");
    expect(readiness()).toEqual(failingSnapshot(["chat-recovery"]));
  });

  it.each([
    ["startup-sidecars", "getStartupPending"],
    ["gateway-draining", "getGatewayDraining"],
  ] as const)("does not cache %s readiness", (reason, getter) => {
    let pending = true;
    const { manager, readiness } = setup(undefined, {
      [getter]: () => pending,
    });
    expect(readiness()).toEqual(failingSnapshot([reason]));
    expect(manager.getRuntimeSnapshot).not.toHaveBeenCalled();
    pending = false;
    expect(readiness()).toEqual(readySnapshot());
    expect(manager.getRuntimeSnapshot).toHaveBeenCalledTimes(1);
  });

  it("reports a terminal state database failure immediately and discards cached channel health", () => {
    let failure: Error | undefined;
    const { manager, readiness } = setup(undefined, {
      getStateDatabaseFailure: () => failure,
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
    const { manager, readiness } = setup(
      { lastTransportActivityAt: Date.now() },
      { getPluginReloadStatus: () => pluginReload },
    );
    expect(readiness()).toEqual(readySnapshot());

    manager.getRuntimeSnapshot.mockReturnValue(snapshotWith({ running: false, connected: false }));

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
    expect(readiness()).toEqual(failingSnapshot(["discord"], FIVE_MIN_MS, true));
  });

  it.each([
    { skipChannels: false, channelFailed: false },
    { skipChannels: true, channelFailed: false },
    { skipChannels: false, channelFailed: true },
  ])(
    "reports warming, failed, and recovered core agents (skip channels: $skipChannels, channel failed: $channelFailed)",
    ({ skipChannels, channelFailed }) => {
      let refusals: AgentDatabaseAdmissionRefusal[] = [];
      const { readiness } = setup(
        channelFailed ? { running: false, connected: false } : undefined,
        {
          shouldSkipChannelReadiness: () => skipChannels,
          getAgentDatabaseAdmissionRefusals: () => refusals,
        },
      );
      const channelReadiness = channelFailed
        ? failingSnapshot(["discord"], FIVE_MIN_MS, true)
        : readySnapshot();
      expect(readiness()).toEqual(channelReadiness);

      for (const pending of [true, false]) {
        refusals = [
          createAgentDatabaseInspectionRefusal({
            agentId: "main",
            paths: ["/isolated/agents/main/openclaw-agent.sqlite"],
            reason: pending
              ? "Startup inspection and preparation are still running."
              : "Session identities require migration before this agent can run.",
            ...(pending ? { pending } : {}),
          }),
        ];
        expect(readiness()).toEqual({
          ...failingSnapshot(["agent-database:main"]),
          agentDatabases: refusals,
        });
      }

      refusals = [];
      expect(readiness()).toEqual(channelReadiness);
    },
  );

  it.each([undefined, "ready"] as const)(
    "applies startup grace only before lifecycle readiness (%s)",
    (lifecycle) => {
      const { readiness } = setup(
        {
          connected: false,
          lifecycle,
          lastStartAt: Date.now() - 30_000,
        },
        { startedAgoMs: 30_000 },
      );
      expect(readiness()).toEqual(
        lifecycle ? failingSnapshot(["discord"], 30_000, true) : readySnapshot(30_000),
      );
    },
  );

  it.each(["crash-loop", "ambient"] as const)(
    "reports %s suppressed stopped channels without failing readiness",
    (suppression) => {
      const { manager, readiness } = setup({
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

  it.each([
    { name: "dead ingress in restart backoff", running: false, ready: true },
    { name: "dead ingress while running", running: true, ready: false },
  ])("checks $name independently of transport connectivity", ({ running, ready }) => {
    const { readiness } = setup({
      running,
      restartPending: true,
      ingressUnavailable: true,
      reconnectAttempts: 3,
      lastStartAt: Date.now() - THIRTY_ONE_MIN_MS,
      lastStopAt: Date.now() - 5_000,
    });
    expect(readiness()).toEqual(
      ready ? readySnapshot() : failingSnapshot(["discord"], FIVE_MIN_MS, true),
    );
  });

  it("treats stale-socket channels as ready to avoid pulling healthy idle pods", () => {
    const { readiness } = setup(
      {
        lastStartAt: Date.now() - THIRTY_ONE_MIN_MS,
        lastTransportActivityAt: Date.now() - THIRTY_ONE_MIN_MS,
      },
      { startedAgoMs: THIRTY_ONE_MIN_MS },
    );
    expect(readiness()).toEqual(readySnapshot(THIRTY_ONE_MIN_MS));
  });

  it("caches readiness snapshots briefly to keep repeated probes cheap", () => {
    const { manager, readiness } = setup({
      lastTransportActivityAt: Date.now() - 1_000,
    });
    expect(readiness()).toEqual(readySnapshot());
    vi.advanceTimersByTime(500);
    expect(readiness()).toEqual(readySnapshot(300_500));
    expect(manager.getRuntimeSnapshot).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(600);
    expect(readiness()).toEqual(readySnapshot(301_100));
    expect(manager.getRuntimeSnapshot).toHaveBeenCalledTimes(2);
  });

  it("refreshes stopped channels when the clock moves behind cached readiness", () => {
    const { manager, readiness } = setup({ lifecycle: "ready" });

    expect(readiness()).toEqual(readySnapshot());
    manager.getRuntimeSnapshot.mockReturnValue(
      snapshotWith({ running: false, connected: false, lifecycle: "stopped" }),
    );
    vi.setSystemTime(Date.now() - 60_000);

    expect(readiness()).toEqual(failingSnapshot(["discord"], FIVE_MIN_MS - 60_000, true));
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
    const { readiness } = setup(undefined, {
      getEventLoopHealth: () => structuredClone(eventLoop),
    });
    expect(readiness()).toEqual(readySnapshot(FIVE_MIN_MS, { eventLoop }));
  });
});
