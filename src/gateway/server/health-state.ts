import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import type { Snapshot } from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentEffectiveModelPrimary } from "../../agents/agent-scope.js";
import { getRuntimeConfig } from "../../config/io.js";
import { CONFIG_PATH, STATE_DIR } from "../../config/paths.js";
import { getRuntimeConfigAppliedHash } from "../../config/runtime-snapshot.js";
import { resolveAgentMainSessionKey } from "../../config/sessions.js";
import { listSystemPresence } from "../../infra/system-presence.js";
import { getUpdateAvailable, getUpdateSchedule } from "../../infra/update-status-state.js";
import { getGatewaySuspendAdmissionPhase } from "../../process/gateway-work-admission.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import { resolveGatewayAgentSelectionState } from "../agent-list.js";
import { resolveGatewayAuth } from "../auth.js";
import type { GatewayHotReloadStatus } from "../config-reload-status.types.js";
import type { GatewayConfigRevisionProjector } from "../config-revision-token.js";
import { projectUpdateAvailable } from "../events.js";
import type { ChannelHealthSummary, HealthSummary } from "../health/types.js";
import { createPresenceRecipientProjection } from "../presence-projection.js";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import { HEALTH_REFRESH_INTERVAL_MS } from "../server-constants.js";
import type { GatewayClient } from "../server-methods/types.js";
import type { SessionRowProjection } from "../session-row-projection.js";
import type { GatewayEventLoopHealth } from "./event-loop-health.js";

let presenceVersion = 1;
let healthVersion = 1;
let healthCache: HealthSummary | null = null;
let healthDigest: string | undefined;
let broadcastHealthUpdate: ((snap: HealthSummary) => void) | null = null;

type HealthAudience = "public" | "admin";
type HealthRefreshStrength = "passive" | "probe";
const healthRefreshStates: Record<
  HealthAudience,
  Record<HealthRefreshStrength, Promise<HealthSummary> | null>
> = {
  public: { passive: null, probe: null },
  admin: { passive: null, probe: null },
};

export function buildGatewaySnapshot(opts: {
  client: GatewayClient | null;
  includeSensitive?: boolean;
  includeUpdateDetails?: boolean;
  revisionProjector: GatewayConfigRevisionProjector;
  sessionRowProjection?: SessionRowProjection;
}): Snapshot {
  const cfg = getRuntimeConfig();
  const selection = resolveGatewayAgentSelectionState(cfg);
  const defaultAgentId = selection.defaultId;
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  const scope = cfg.session?.scope ?? "per-sender";
  const mainSessionKey =
    scope === "global" ? "global" : resolveAgentMainSessionKey({ cfg, agentId: defaultAgentId });
  const presence = createPresenceRecipientProjection({
    cfg,
    presence: listSystemPresence({ includeConnectionId: opts.client?.connId }),
    projection: opts.sessionRowProjection,
  })(opts.client);
  const uptimeMs = Math.round(process.uptime() * 1000);
  const includeUpdateDetails = opts.includeUpdateDetails === true;
  const updateAvailable =
    projectUpdateAvailable(getUpdateAvailable(), includeUpdateDetails) ?? undefined;
  const updateSchedule = includeUpdateDetails ? (getUpdateSchedule() ?? undefined) : undefined;
  const appliedConfigHash = getRuntimeConfigAppliedHash();
  const snapshot: Snapshot = {
    suspension: { phase: getGatewaySuspendAdmissionPhase() },
    presence,
    // Health is async; the caller replaces this with the collected snapshot.
    health: {},
    stateVersion: { presence: presenceVersion, health: healthVersion },
    uptimeMs,
    appliedConfigHash: appliedConfigHash
      ? opts.revisionProjector.projectResolvedHash(appliedConfigHash)
      : null,
    sessionDefaults: {
      defaultAgentId,
      modelConfigured: Boolean(resolveAgentEffectiveModelPrimary(cfg, defaultAgentId)),
      ownership: selection.ownership,
      selectionRequired: selection.selectionRequired,
      mainKey,
      mainSessionKey,
      scope,
    },
    updateAvailable,
    updateSchedule,
  };
  if (opts.includeSensitive === true) {
    const auth = resolveGatewayAuth({ authConfig: cfg.gateway?.auth, env: process.env });
    // Surface resolved paths only to admin callers that already have broader gateway access.
    snapshot.configPath = CONFIG_PATH;
    snapshot.stateDir = STATE_DIR;
    snapshot.authMode = auth.mode;
  }
  return snapshot;
}

export function getHealthCache(): HealthSummary | null {
  return healthCache;
}

export function getHealthVersion(): number {
  return healthVersion;
}

export function incrementPresenceVersion(): number {
  presenceVersion += 1;
  return presenceVersion;
}

export function getPresenceVersion(): number {
  return presenceVersion;
}

export function setBroadcastHealthUpdate(fn: ((snap: HealthSummary) => void) | null) {
  broadcastHealthUpdate = fn;
}

function healthEventDigest(snap: HealthSummary): string {
  const channel = ({
    authAgeMs: _authAgeMs,
    lastProbeAt: _lastProbeAt,
    lastInboundAt: _lastInboundAt,
    lastOutboundAt: _lastOutboundAt,
    lastTransportActivityAt: _lastTransportActivityAt,
    lastMessageAt: _lastMessageAt,
    lastEventAt: _lastEventAt,
    lastRunActivityAt: _lastRunActivityAt,
    busy: _busy,
    activeRuns: _activeRuns,
    activeRunStartedAt: _activeRunStartedAt,
    accounts,
    ...status
  }: ChannelHealthSummary): unknown => ({
    ...status,
    ...(accounts
      ? {
          accounts: Object.fromEntries(
            Object.entries(accounts).map(([id, value]) => [id, channel(value)]),
          ),
        }
      : {}),
  });
  // The sampler owns continuous degradation age; brief load spikes are diagnostics.
  const sustainedEventLoopDegradation =
    snap.eventLoop?.degraded === true &&
    (snap.eventLoop.degradedSinceMs ?? 0) >= HEALTH_REFRESH_INTERVAL_MS;
  // Keep lifecycle timestamps/errors and plugin-owned status. Sampling noise and
  // routine activity are diagnostics, not health transitions; tick owns liveness
  // and session events own session activity. Full diagnostics remain in the cache.
  return stableStringify({
    ...snap,
    ts: undefined,
    durationMs: undefined,
    eventLoop: snap.eventLoop
      ? {
          degraded: sustainedEventLoopDegradation,
          reasons: sustainedEventLoopDegradation ? snap.eventLoop.reasons : [],
        }
      : undefined,
    channels: Object.fromEntries(
      Object.entries(snap.channels).map(([id, value]) => [id, channel(value)]),
    ),
    agents: snap.agents.map(({ sessions: _sessions, ...agent }) => agent),
    sessions: undefined,
  });
}

export async function refreshGatewayHealthSnapshot(opts?: {
  probe?: boolean;
  includeSensitive?: boolean;
  getRuntimeSnapshot?: () => ChannelRuntimeSnapshot;
  getEventLoopHealth?: () => GatewayEventLoopHealth | undefined;
  getConfigReloaderHotReloadStatus?: () => GatewayHotReloadStatus | undefined;
  getSessionRowProjection?: () => SessionRowProjection | undefined;
}) {
  const includeSensitive = opts?.includeSensitive === true;
  const audience: HealthAudience = includeSensitive ? "admin" : "public";
  const state = healthRefreshStates[audience];
  const strength: HealthRefreshStrength = opts?.probe === false ? "passive" : "probe";
  // Passive callers can reuse a stronger probe, but an explicit probe must not
  // inherit a passive refresh that deliberately skipped live channel checks.
  const existing = strength === "passive" ? (state.probe ?? state.passive) : state.probe;
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    const { collectGatewayHealthSnapshot } = await import("../health/collector.js");
    let runtimeSnapshot: ChannelRuntimeSnapshot | undefined;
    try {
      runtimeSnapshot = opts?.getRuntimeSnapshot?.();
    } catch {
      runtimeSnapshot = undefined;
    }
    const configReloadHotReloadStatus = opts?.getConfigReloaderHotReloadStatus?.();
    const snap = await collectGatewayHealthSnapshot({
      audience,
      probe: strength === "probe",
      runtimeSnapshot,
      ...(configReloadHotReloadStatus ? { configReloadHotReloadStatus } : {}),
      ...(opts?.getSessionRowProjection
        ? { sessionRowProjection: opts.getSessionRowProjection() }
        : {}),
    });
    // Channel collection can outlive several sampling windows. Read diagnostics
    // only when this new snapshot is ready to return, cache, or broadcast.
    const eventLoop = opts?.getEventLoopHealth?.();
    if (eventLoop) {
      snap.eventLoop = eventLoop;
    }
    // Diagnostic snapshots publish in completion order; the next refresh replaces them.
    if (!includeSensitive) {
      const digest = healthEventDigest(snap);
      healthCache = snap;
      if (digest !== healthDigest) {
        healthDigest = digest;
        healthVersion += 1;
        broadcastHealthUpdate?.(snap);
      }
    }
    return snap;
  })().finally(() => {
    state[strength] = null;
  });
  state[strength] = promise;
  return promise;
}
