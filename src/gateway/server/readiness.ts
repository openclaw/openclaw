import { isFutureDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import type { AgentDatabaseAdmissionRefusal } from "../../state/agent-database-admission.js";
import {
  DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  evaluateChannelHealth,
  type ChannelHealthPolicy,
  type ChannelHealthEvaluation,
} from "../channel-health-policy.js";
import type { ChannelManager } from "../server-channels.js";
import type { GatewayPluginReloadStatus } from "../server-plugin-runtime-generation.js";
import type { GatewayEventLoopHealth } from "./event-loop-health.js";

type ReadinessResult = {
  ready: boolean;
  failing: string[];
  suppressed?: string[];
  uptimeMs: number;
  eventLoop?: GatewayEventLoopHealth;
  pluginReload?: GatewayPluginReloadStatus;
  agentDatabases?: readonly AgentDatabaseAdmissionRefusal[];
  stateDatabase?: { reason: string };
};

export type ReadinessChecker = () => ReadinessResult;

export type StartupResult =
  | { ok: true; status: "started"; uptimeMs: number }
  | { ok: false; status: "starting"; uptimeMs: number; pendingReason: string }
  | { ok: false; status: "draining"; uptimeMs: number };

export type StartupChecker = () => StartupResult;

type GatewayStartupStateDeps = {
  startedAt: number;
  getStartupPending?: () => boolean;
  getStartupPendingReason?: () => string | undefined;
  getGatewayDraining?: () => boolean;
};

const DEFAULT_READINESS_CACHE_TTL_MS = 1_000;

/** Startup waits for admission settlement; readiness retains its own agent policy. */
export function createStartupChecker(
  deps: GatewayStartupStateDeps,
  getAgentDatabaseAdmissionRefusals?: () => readonly AgentDatabaseAdmissionRefusal[],
): StartupChecker {
  return (): StartupResult => {
    const uptimeMs = Date.now() - deps.startedAt;
    if (deps.getGatewayDraining?.()) {
      return { ok: false, status: "draining", uptimeMs };
    }
    const pendingReason = deps.getStartupPending?.()
      ? (deps.getStartupPendingReason?.() ?? "startup-sidecars")
      : getAgentDatabaseAdmissionRefusals?.().some(
            (refusal) => refusal.code === "agent-database-inspection-pending",
          )
        ? "agent-database-inspection"
        : undefined;
    if (pendingReason !== undefined) {
      return {
        ok: false,
        status: "starting",
        uptimeMs,
        pendingReason,
      };
    }
    return { ok: true, status: "started", uptimeMs };
  };
}

function shouldIgnoreReadinessFailure(
  accountSnapshot: ChannelAccountSnapshot,
  health: ChannelHealthEvaluation,
): boolean {
  if (health.reason === "unmanaged" || health.reason === "stale-socket") {
    return true;
  }
  // Channel restarts spend time in backoff with running=false before the next
  // lifecycle re-enters startup grace. Keep readiness green during that handoff
  // window, but still surface hard failures once restart attempts are exhausted.
  // A failed ingress start lands in the same backoff window, so it gets the same
  // grace: the next start re-proves ingress, and once the ladder stops setting
  // restartPending the account stays red instead of hiding dead inbound.
  const restartableReason =
    health.reason === "not-running" || health.reason === "ingress-unavailable";
  const inRestartHandoff =
    accountSnapshot.restartPending === true && accountSnapshot.running !== true;
  return restartableReason && inRestartHandoff;
}

export function createReadinessChecker(
  deps: GatewayStartupStateDeps & {
    channelManager: Pick<
      ChannelManager,
      "getRuntimeSnapshot" | "getAutostartSuppression" | "isAmbientAutostartSuppressed"
    >;
    getEventLoopHealth?: () => GatewayEventLoopHealth | undefined;
    getStateDatabaseFailure?: () => Error | undefined;
    getAgentDatabaseAdmissionRefusals?: () => readonly AgentDatabaseAdmissionRefusal[];
    allowPendingAgentDatabases?: boolean;
    getPluginReloadStatus?: () => GatewayPluginReloadStatus | undefined;
    shouldSkipChannelReadiness?: () => boolean;
    cacheTtlMs?: number;
  },
): ReadinessChecker {
  const { channelManager, startedAt } = deps;
  const getStartup = createStartupChecker(deps);
  const cacheTtlMs = Math.max(0, deps.cacheTtlMs ?? DEFAULT_READINESS_CACHE_TTL_MS);
  let cachedAt = 0;
  let cachedState: Omit<ReadinessResult, "uptimeMs"> | null = null;

  const readReadiness = (
    agentDatabases: readonly AgentDatabaseAdmissionRefusal[] | undefined,
  ): ReadinessResult => {
    const startup = getStartup();
    const uptimeMs = startup.uptimeMs;
    const now = startedAt + uptimeMs;
    if (startup.status === "starting") {
      return { ready: false, failing: [startup.pendingReason], uptimeMs };
    }
    if (startup.status === "draining") {
      return { ready: false, failing: ["gateway-draining"], uptimeMs };
    }
    const stateDatabaseFailure = deps.getStateDatabaseFailure?.();
    if (stateDatabaseFailure) {
      cachedState = null;
      return {
        ready: false,
        failing: ["state-database"],
        stateDatabase: { reason: stateDatabaseFailure.message },
        uptimeMs,
      };
    }
    const failedAgents = agentDatabases?.filter(
      (refusal) =>
        deps.allowPendingAgentDatabases === false ||
        refusal.code !== "agent-database-inspection-pending",
    );
    if (failedAgents?.length) {
      cachedState = null;
      return {
        ready: false,
        failing: failedAgents.map(({ agentId }) => `agent-database:${agentId}`),
        uptimeMs,
      };
    }
    const pluginReload = deps.getPluginReloadStatus?.();
    if (pluginReload) {
      cachedState = null;
      return { ready: false, failing: ["plugin-reload"], pluginReload, uptimeMs };
    }
    if (
      cachedState &&
      !isFutureDateTimestampMs(cachedAt, { nowMs: now }) &&
      now - cachedAt < cacheTtlMs
    ) {
      return { ...cachedState, uptimeMs };
    }
    if (deps.shouldSkipChannelReadiness?.()) {
      return { ready: true, failing: [], uptimeMs };
    }

    const snapshot = channelManager.getRuntimeSnapshot();
    const globallyAutostartSuppressed = channelManager.getAutostartSuppression() !== null;
    const failing: string[] = [];
    const suppressed: string[] = [];

    for (const [channelId, accounts] of Object.entries(snapshot.channelAccounts)) {
      if (!accounts) {
        continue;
      }
      const autostartSuppressed =
        globallyAutostartSuppressed || channelManager.isAmbientAutostartSuppressed(channelId);
      for (const accountSnapshot of Object.values(accounts)) {
        if (!accountSnapshot) {
          continue;
        }
        const policy: ChannelHealthPolicy = {
          now,
          staleEventThresholdMs: DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
          channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS,
          channelId,
        };
        const health = evaluateChannelHealth(accountSnapshot, policy);
        if (!health.healthy && autostartSuppressed && health.reason === "not-running") {
          if (!suppressed.includes(channelId)) {
            suppressed.push(channelId);
          }
          continue;
        }
        if (!health.healthy && !shouldIgnoreReadinessFailure(accountSnapshot, health)) {
          failing.push(channelId);
          break;
        }
      }
    }

    cachedAt = now;
    cachedState = {
      ready: failing.length === 0,
      failing,
      ...(suppressed.length > 0 ? { suppressed } : {}),
    };
    return { ...cachedState, uptimeMs };
  };
  return () => {
    const agentDatabases = deps.getAgentDatabaseAdmissionRefusals?.();
    const result = readReadiness(agentDatabases);
    const getEventLoopHealth = deps.getEventLoopHealth;
    const eventLoop = getEventLoopHealth?.();
    return {
      ...result,
      ...(agentDatabases?.length ? { agentDatabases } : {}),
      ...(eventLoop ? { eventLoop } : {}),
    };
  };
}
