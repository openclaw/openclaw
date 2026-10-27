// Gateway health state builds snapshots, caches health probes, and broadcasts health/presence version changes.
import type { Snapshot } from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentEffectiveModelPrimary } from "../../agents/agent-scope.js";
import { createConfigIO, getRuntimeConfig } from "../../config/io.js";
import { STATE_DIR } from "../../config/paths.js";
import { getRuntimeConfigAppliedHash } from "../../config/runtime-snapshot.js";
import { resolveAgentMainSessionKey } from "../../config/sessions.js";
import { isDiagnosticFlagEnabled } from "../../infra/diagnostic-flags.js";
import { listSystemPresence } from "../../infra/system-presence.js";
import { getUpdateAvailable, getUpdateSchedule } from "../../infra/update-status-state.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGatewaySuspendAdmissionPhase } from "../../process/gateway-work-admission.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import { resolveGatewayAgentSelectionState } from "../agent-list.js";
import { resolveGatewayAuth } from "../auth.js";
import type { GatewayHotReloadStatus } from "../config-reload-status.types.js";
import type { GatewayConfigRevisionProjector } from "../config-revision-token.js";
import { projectUpdateAvailable } from "../events.js";
import type { HealthSummary } from "../health/types.js";
import { createPresenceRecipientProjection } from "../presence-projection.js";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import type { GatewayClient } from "../server-methods/types.js";
import type { SessionRowProjection } from "../session-row-projection.js";
import type { GatewayEventLoopHealth } from "./event-loop-health.js";

let presenceVersion = 1;
let healthVersion = 1;
let healthCache: HealthSummary | null = null;
let broadcastHealthUpdate: ((snap: HealthSummary) => void) | null = null;

type HealthAudience = "public" | "admin";
type HealthRefreshStrength = "passive" | "probe";
const healthRefreshOrigins = [
  "periodic",
  "host_thaw",
  "post_connect",
  "cached_health_rpc",
  "health_rpc",
  "unspecified",
] as const;
export type GatewayHealthRefreshOrigin = (typeof healthRefreshOrigins)[number];
const healthLog = createSubsystemLogger("gateway/health");

type HealthRefreshObservation = {
  collectionId: string;
  origin: GatewayHealthRefreshOrigin;
  audience: HealthAudience;
  strength: HealthRefreshStrength;
  startedAtMs: number;
  startedMonotonicMs: number;
  cpu: ReturnType<typeof readRefreshCpuUsage>;
  coalescedOrigins: Set<GatewayHealthRefreshOrigin>;
  coalescedRequests: number;
};
type HealthRefreshOperation = {
  generation: number;
  promise: Promise<HealthSummary>;
  observation?: HealthRefreshObservation;
};
type HealthRefreshState = {
  nextGeneration: number;
  committedGeneration: number;
  inFlight: Record<HealthRefreshStrength, HealthRefreshOperation | null>;
};

const healthRefreshStates: Record<HealthAudience, HealthRefreshState> = {
  public: {
    nextGeneration: 0,
    committedGeneration: 0,
    inFlight: { passive: null, probe: null },
  },
  admin: {
    nextGeneration: 0,
    committedGeneration: 0,
    inFlight: { passive: null, probe: null },
  },
};

function readRefreshCpuUsage() {
  const usage: { process?: NodeJS.CpuUsage; thread?: NodeJS.CpuUsage } = {};
  try {
    usage.process = process.cpuUsage();
  } catch {
    // An unavailable counter must not fail a health request or become idle CPU.
  }
  try {
    usage.thread =
      typeof process.threadCpuUsage === "function" ? process.threadCpuUsage() : undefined;
  } catch {
    // Older runtimes can expose the API without supporting its native counter.
  }
  return usage;
}

function refreshCpuDelta(current?: NodeJS.CpuUsage, previous?: NodeJS.CpuUsage) {
  if (!current || !previous) {
    return undefined;
  }
  const user = current.user - previous.user;
  const system = current.system - previous.system;
  return Number.isFinite(user + system) && user >= 0 && system >= 0 ? { user, system } : undefined;
}

function observeHealthRefresh(
  phase: "started" | "coalesced" | "completed",
  observation: HealthRefreshObservation,
  fields: Record<string, unknown> = {},
) {
  const record = {
    phase,
    collectionId: observation.collectionId,
    pid: process.pid,
    origin: observation.origin,
    audience: observation.audience,
    strength: observation.strength,
    startedAtMs: observation.startedAtMs,
    startedMonotonicMs: observation.startedMonotonicMs,
    ...fields,
  };
  try {
    healthLog.info("health refresh", record);
  } catch {
    // Opt-in local observations never change collection, cache or retry behavior.
  }
}

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
  const includeUpdateDetails = opts?.includeUpdateDetails === true;
  const updateAvailable =
    projectUpdateAvailable(getUpdateAvailable(), includeUpdateDetails) ?? undefined;
  const updateSchedule = includeUpdateDetails ? (getUpdateSchedule() ?? undefined) : undefined;
  const appliedConfigHash = getRuntimeConfigAppliedHash();
  // Health is async; the caller replaces this with the collected snapshot.
  const emptyHealth: Snapshot["health"] = {};
  const snapshot: Snapshot = {
    suspension: { phase: getGatewaySuspendAdmissionPhase() },
    presence,
    health: emptyHealth,
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
  if (opts?.includeSensitive === true) {
    const auth = resolveGatewayAuth({ authConfig: cfg.gateway?.auth, env: process.env });
    // Surface resolved paths only to admin callers that already have broader gateway access.
    snapshot.configPath = createConfigIO().configPath;
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

export async function refreshGatewayHealthSnapshot(opts?: {
  probe?: boolean;
  includeSensitive?: boolean;
  origin?: GatewayHealthRefreshOrigin;
  getRuntimeSnapshot?: () => ChannelRuntimeSnapshot;
  getEventLoopHealth?: () => GatewayEventLoopHealth | undefined;
  getConfigReloaderHotReloadStatus?: () => GatewayHotReloadStatus | undefined;
  getSessionRowProjection?: () => SessionRowProjection | undefined;
}) {
  const includeSensitive = opts?.includeSensitive === true;
  const audience: HealthAudience = includeSensitive ? "admin" : "public";
  const state = healthRefreshStates[audience];
  const strength: HealthRefreshStrength = opts?.probe === false ? "passive" : "probe";
  const origin = healthRefreshOrigins.find((value) => value === opts?.origin) ?? "unspecified";
  // Passive callers can reuse a stronger probe, but an explicit probe must not
  // inherit a passive refresh that deliberately skipped live channel checks.
  const existing =
    strength === "passive"
      ? (state.inFlight.probe ?? state.inFlight.passive)
      : state.inFlight.probe;
  if (existing) {
    const observation = existing.observation;
    if (observation) {
      observation.coalescedRequests = Math.min(
        Number.MAX_SAFE_INTEGER,
        observation.coalescedRequests + 1,
      );
      if (!observation.coalescedOrigins.has(origin)) {
        observation.coalescedOrigins.add(origin);
        observeHealthRefresh("coalesced", observation, {
          joiningOrigin: origin,
          joinedAtMs: Date.now(),
          joinedMonotonicMs: performance.now(),
        });
      }
    }
    return existing.promise;
  }

  const generation = state.nextGeneration + 1;
  state.nextGeneration = generation;
  const observation: HealthRefreshObservation | undefined = isDiagnosticFlagEnabled("health")
    ? {
        collectionId: `${process.pid}:${audience}:${generation}`,
        origin,
        audience,
        strength,
        startedAtMs: Date.now(),
        startedMonotonicMs: performance.now(),
        cpu: readRefreshCpuUsage(),
        coalescedOrigins: new Set(),
        coalescedRequests: 0,
      }
    : undefined;
  if (observation) {
    observeHealthRefresh("started", observation);
  }
  let succeeded = false;
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
    if (
      strength === "probe" &&
      state.inFlight.passive &&
      state.inFlight.passive.generation < generation
    ) {
      // Existing passive waiters may finish, but new callers must not join
      // weaker work after this newer live probe has succeeded.
      state.inFlight.passive = null;
    }
    // Concurrent passive/probe refreshes can finish out of order. Only a
    // generation newer than the published cache may advance version/broadcast.
    if (!includeSensitive && generation > state.committedGeneration) {
      state.committedGeneration = generation;
      healthCache = snap;
      healthVersion += 1;
      if (broadcastHealthUpdate) {
        broadcastHealthUpdate(snap);
      }
    }
    succeeded = true;
    return snap;
  })().finally(() => {
    if (observation) {
      const cpu = readRefreshCpuUsage();
      const completedAtMs = Date.now();
      const completedMonotonicMs = performance.now();
      // These counters include concurrent work and observation overhead; they
      // describe interval overlap, never CPU exclusively owned by the collector.
      observeHealthRefresh("completed", observation, {
        outcome: succeeded ? "success" : "failure",
        completedAtMs,
        completedMonotonicMs,
        elapsedMs: completedMonotonicMs - observation.startedMonotonicMs,
        cpuScope: "process_and_calling_thread_interval_overlap",
        processCpuUsageUs: refreshCpuDelta(cpu.process, observation.cpu.process),
        threadCpuUsageUs: refreshCpuDelta(cpu.thread, observation.cpu.thread),
        coalescedRequests: observation.coalescedRequests,
        coalescedOrigins: [...observation.coalescedOrigins],
      });
    }
    if (state.inFlight[strength]?.generation === generation) {
      state.inFlight[strength] = null;
    }
  });
  state.inFlight[strength] = { generation, promise, observation };
  return promise;
}
