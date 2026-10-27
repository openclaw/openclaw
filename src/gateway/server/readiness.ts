import { isFutureDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import { readChildRuntimeViability } from "../../infra/child-runtime-viability.js";
import type { AgentDatabaseAdmissionRefusal } from "../../state/agent-database-admission.js";
import type { AgentDatabaseCleanupFailure } from "../../state/openclaw-agent-execution.js";
import {
  DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  evaluateChannelHealth,
  type ChannelHealthPolicy,
} from "../channel-health-policy.js";
import type { ChannelManager } from "../server-channels.js";
import type { GatewayPluginReloadStatus } from "../server-plugin-reload-status.types.js";
import type { GatewayEventLoopHealth } from "./event-loop-health.js";

type ReadinessResult = {
  ready: boolean;
  coreReady: boolean;
  failing: string[];
  suppressed?: string[];
  uptimeMs: number;
  eventLoop?: GatewayEventLoopHealth;
  pluginReload?: GatewayPluginReloadStatus;
  agentDatabases?: readonly AgentDatabaseAdmissionRefusal[];
  agentCleanup?: readonly AgentDatabaseCleanupFailure[];
  agentRecovery?: readonly string[];
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
  health: ReturnType<typeof evaluateChannelHealth>,
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
    getAgentDatabaseCleanupFailures?: () => readonly AgentDatabaseCleanupFailure[];
    getPluginReloadStatus?: () => GatewayPluginReloadStatus | undefined;
    isChatSendAvailable?: () => boolean;
    getPendingAgentInputRecovery?: () => readonly string[];
    isRequiredAgent?: (agentId: string) => boolean;
    shouldSkipChannelReadiness?: () => boolean;
  },
): ReadinessChecker {
  const { channelManager, startedAt } = deps;
  const getStartup = createStartupChecker(deps);
  let cachedAt = 0;
  let cachedState: Omit<ReadinessResult, "uptimeMs"> | null = null;

  const readReadiness = (
    agentDatabases: readonly AgentDatabaseAdmissionRefusal[] | undefined,
    pendingRecovery: readonly string[],
  ): ReadinessResult => {
    const startup = getStartup();
    const uptimeMs = startup.uptimeMs;
    const now = startedAt + uptimeMs;
    if (startup.status === "starting") {
      return { ready: false, coreReady: false, failing: [startup.pendingReason], uptimeMs };
    }
    if (startup.status === "draining") {
      return { ready: false, coreReady: false, failing: ["gateway-draining"], uptimeMs };
    }
    if (!readChildRuntimeViability().available) {
      return { ready: false, coreReady: false, failing: ["child-runtime"], uptimeMs };
    }
    const stateDatabaseFailure = deps.getStateDatabaseFailure?.();
    if (stateDatabaseFailure) {
      cachedState = null;
      return {
        ready: false,
        coreReady: false,
        failing: ["state-database"],
        stateDatabase: { reason: stateDatabaseFailure.message },
        uptimeMs,
      };
    }
    if (agentDatabases?.length) {
      cachedState = null;
      return {
        ready: false,
        coreReady: false,
        failing: agentDatabases.map(({ agentId }) => `agent-database:${agentId}`),
        uptimeMs,
      };
    }
    const pluginReload = deps.getPluginReloadStatus?.();
    if (pluginReload) {
      cachedState = null;
      return { ready: false, coreReady: false, failing: ["plugin-reload"], pluginReload, uptimeMs };
    }
    if (deps.isChatSendAvailable?.() === false) {
      cachedState = null;
      return { ready: false, coreReady: false, failing: ["chat-recovery"], uptimeMs };
    }
    const requiredRecovery = pendingRecovery.filter(
      (agentId) => deps.isRequiredAgent?.(agentId) ?? true,
    );
    if (requiredRecovery.length) {
      cachedState = null;
      return {
        ready: false,
        coreReady: false,
        failing: requiredRecovery.map((agentId) => `chat-recovery:${agentId}`),
        uptimeMs,
      };
    }
    if (
      cachedState &&
      !isFutureDateTimestampMs(cachedAt, { nowMs: now }) &&
      now - cachedAt < DEFAULT_READINESS_CACHE_TTL_MS
    ) {
      return { ...cachedState, uptimeMs };
    }
    if (deps.shouldSkipChannelReadiness?.()) {
      return { ready: true, coreReady: true, failing: [], uptimeMs };
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
      coreReady: true,
      failing,
      ...(suppressed.length > 0 ? { suppressed } : {}),
    };
    return { ...cachedState, uptimeMs };
  };
  return () => {
    const agentDatabases = deps.getAgentDatabaseAdmissionRefusals?.();
    const agentCleanup = deps.getAgentDatabaseCleanupFailures?.();
    const agentRecovery = deps.getPendingAgentInputRecovery?.();
    const result = readReadiness(agentDatabases, agentRecovery ?? []);
    const getEventLoopHealth = deps.getEventLoopHealth;
    const eventLoop = getEventLoopHealth?.();
    return {
      ...result,
      ...(agentDatabases?.length ? { agentDatabases } : {}),
      ...(agentCleanup?.length ? { agentCleanup } : {}),
      ...(agentRecovery?.length ? { agentRecovery } : {}),
      ...(eventLoop ? { eventLoop } : {}),
    };
  };
}
