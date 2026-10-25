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
    let available = false;
    const deps = {
      startedAt: Date.now() - FIVE_MIN_MS,
      isChatSendAvailable: () => available,
    };
    const { readiness } = setup(undefined, deps);

    // Startup completion releases recovery's background-work barrier; it cannot await recovery.
    expect(createStartupChecker(deps)()).toEqual({
      ok: true,
      status: "started",
      uptimeMs: FIVE_MIN_MS,
    });
    expect(readiness()).toEqual(failingSnapshot(["chat-recovery"]));
    available = true;
    expect(readiness()).toEqual(readySnapshot());
    available = false;
    expect(readiness()).toEqual(failingSnapshot(["chat-recovery"]));
  });

  it("does not cache startup readiness", () => {
    let pending = true;
    const { readiness } = setup(undefined, { getStartupPending: () => pending });
    expect(readiness()).toEqual(failingSnapshot(["startup-sidecars"]));
    pending = false;
    expect(readiness()).toEqual(readySnapshot());
  });

  it("reports a terminal state database failure immediately and discards cached channel health", () => {
    let failure: Error | undefined;
    const { readiness, manager } = setup(undefined, {
      getStateDatabaseFailure: () => failure,
    });
    expect(readiness()).toEqual(readySnapshot());

    failure = new Error("newer shared-state schema");
    expect(readiness()).toEqual({
      ...failingSnapshot(["state-database"]),
      stateDatabase: { reason: "newer shared-state schema" },
    });

    failure = undefined;
    manager.getRuntimeSnapshot.mockReturnValue(snapshotWith({ running: false }));
    expect(readiness()).toEqual(failingSnapshot(["discord"], FIVE_MIN_MS, true));
  });

  it("reports plugin replacement recovery immediately and resumes channel readiness after settlement", () => {
    let pluginReload: GatewayPluginReloadStatus | undefined;
    const { manager, readiness } = setup({}, { getPluginReloadStatus: () => pluginReload });
    expect(readiness()).toEqual(readySnapshot());

    manager.getRuntimeSnapshot.mockReturnValue(snapshotWith({ running: false, connected: false }));

    pluginReload = {
      phase: "recovering",
      pluginIds: ["discord"],
      deadlineAtMs: Date.now() + 5_000,
      reason: "waiting",
    };
    expect(readiness()).toEqual({
      ...failingSnapshot(["plugin-reload"]),
      pluginReload,
    });

    pluginReload = undefined;
    expect(readiness()).toEqual(failingSnapshot(["discord"], FIVE_MIN_MS, true));
  });

  it.each([false, true])(
    "reports warming, failed, and recovered agents before channel checks (skip: %s)",
    (skipChannels) => {
      let refusals: AgentDatabaseAdmissionRefusal[] = [];
      const { readiness } = setup(
        { running: false, connected: false },
        {
          shouldSkipChannelReadiness: () => skipChannels,
          getAgentDatabaseAdmissionRefusals: () => refusals,
        },
      );
      const channelReadiness = skipChannels
        ? readySnapshot()
        : failingSnapshot(["discord"], FIVE_MIN_MS, true);
      expect(readiness()).toEqual(channelReadiness);

      for (const pending of [true, false]) {
        refusals = [
          createAgentDatabaseInspectionRefusal({
            agentId: "main",
            paths: ["/isolated/agents/main/openclaw-agent.sqlite"],
            reason: "unavailable",
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

  const deadIngress = { restartPending: true, ingressUnavailable: true };
  it.each<[string, () => Partial<ChannelAccountSnapshot>, number, boolean]>([
    ["startup grace", () => ({ connected: false }), 30_000, true],
    ["ready skips grace", () => ({ connected: false, lifecycle: "ready" }), 30_000, false],
    ["ingress backoff", () => ({ ...deadIngress, running: false }), THIRTY_ONE_MIN_MS, true],
    ["dead ingress", () => deadIngress, THIRTY_ONE_MIN_MS, false],
    [
      "idle socket",
      () => ({ lastTransportActivityAt: Date.now() - THIRTY_ONE_MIN_MS }),
      THIRTY_ONE_MIN_MS,
      true,
    ],
  ])("handles %s", (_name, account, age, ready) => {
    const { readiness } = setup(
      { lastStartAt: Date.now() - age, ...account() },
      { startedAgoMs: age },
    );
    expect(readiness()).toEqual(
      ready ? readySnapshot(age) : failingSnapshot(["discord"], age, true),
    );
  });

  it.each(["crash-loop", "ambient"] as const)(
    "reports %s suppressed stopped channels without failing readiness",
    (suppression) => {
      const { manager, readiness } = setup({ running: false });
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
