import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { getHealthSnapshot, type HealthSummary } from "../../commands/health.js";
import { STATE_DIR, createConfigIO, loadConfig } from "../../config/config.js";
import { resolveMainSessionKey } from "../../config/sessions.js";
import { listSystemPresence } from "../../infra/system-presence.js";
import { getUpdateAvailable } from "../../infra/update-startup.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import { resolveGatewayAuth } from "../auth.js";
import type { Snapshot } from "../protocol/index.js";
import type { ChannelRuntimeSnapshot } from "../server-channels.js";

let presenceVersion = 1;
let healthVersion = 1;
let healthCache: HealthSummary | null = null;
let healthRefresh: Promise<HealthSummary> | null = null;
let broadcastHealthUpdate: ((snap: HealthSummary) => void) | null = null;
let healthRuntimeSnapshotProvider: (() => ChannelRuntimeSnapshot) | null = null;

function hasNewerRuntimeState(cache: HealthSummary): boolean {
  const runtimeSnapshot = healthRuntimeSnapshotProvider?.();
  if (!runtimeSnapshot) {
    return false;
  }
  for (const [channelId, runtime] of Object.entries(runtimeSnapshot.channels)) {
    if (!runtime) {
      continue;
    }
    const cached = cache.channels?.[channelId];
    if (!cached) {
      return true;
    }
    const runtimeRunning = runtime.running === true;
    const cachedRunning = cached.running === true;
    if (runtimeRunning && !cachedRunning) {
      return true;
    }
    const runtimeLastStartAt = typeof runtime.lastStartAt === "number" ? runtime.lastStartAt : null;
    const cachedLastStartAt = typeof cached.lastStartAt === "number" ? cached.lastStartAt : null;
    // Only compare lastStartAt when the cached summary actually carries it.
    // Channels like WhatsApp omit lastStartAt, so cached is always null while
    // runtime always has a number, which would force a rebuild every time.
    if (
      runtimeLastStartAt !== null &&
      cachedLastStartAt !== null &&
      runtimeLastStartAt !== cachedLastStartAt
    ) {
      return true;
    }
  }
  return false;
}

export function buildGatewaySnapshot(): Snapshot {
  const cfg = loadConfig();
  const configPath = createConfigIO().configPath;
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  const mainSessionKey = resolveMainSessionKey(cfg);
  const scope = cfg.session?.scope ?? "per-sender";
  const presence = listSystemPresence();
  const uptimeMs = Math.round(process.uptime() * 1000);
  const auth = resolveGatewayAuth({ authConfig: cfg.gateway?.auth, env: process.env });
  const updateAvailable = getUpdateAvailable() ?? undefined;
  // Health is async; caller should await getHealthSnapshot and replace later if needed.
  const emptyHealth: unknown = {};
  return {
    presence,
    health: emptyHealth,
    stateVersion: { presence: presenceVersion, health: healthVersion },
    uptimeMs,
    // Surface resolved paths so UIs can display the true config location.
    configPath,
    stateDir: STATE_DIR,
    sessionDefaults: {
      defaultAgentId,
      mainKey,
      mainSessionKey,
      scope,
    },
    authMode: auth.mode,
    updateAvailable,
  };
}

export function getHealthCache(): HealthSummary | null {
  return healthCache;
}

export function getHealthVersion(): number {
  return healthVersion;
}

export function isGatewayHealthCacheStale(cache: HealthSummary | null): boolean {
  if (!cache) {
    return true;
  }
  return hasNewerRuntimeState(cache);
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

export function setHealthRuntimeSnapshotProvider(fn: (() => ChannelRuntimeSnapshot) | null) {
  healthRuntimeSnapshotProvider = fn;
}

export async function refreshGatewayHealthSnapshot(opts?: { probe?: boolean }) {
  if (!healthRefresh) {
    healthRefresh = (async () => {
      const runtimeSnapshot = healthRuntimeSnapshotProvider?.();
      const snap = await getHealthSnapshot({
        probe: opts?.probe,
        runtimeSnapshot,
      });
      healthCache = snap;
      healthVersion += 1;
      if (broadcastHealthUpdate) {
        broadcastHealthUpdate(snap);
      }
      return snap;
    })().finally(() => {
      healthRefresh = null;
    });
  }
  return healthRefresh;
}
