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
// Tracks the most recent runtimeSnapshot queued while a refresh is in-flight so it
// is not silently dropped when a second caller arrives concurrently.
let pendingRuntimeSnapshot: ChannelRuntimeSnapshot | undefined = undefined;
// Tracks the most recent probe intent so the follow-up refresh uses the latest caller's preference.
let pendingProbe: boolean | undefined = undefined;

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

/** @internal Reset module-level state between tests only. */
export function __resetHealthStateForTest() {
  healthCache = null;
  healthRefresh = null;
  pendingRuntimeSnapshot = undefined;
  pendingProbe = undefined;
  healthVersion = 1;
  presenceVersion = 1;
  broadcastHealthUpdate = null;
}

export async function refreshGatewayHealthSnapshot(opts?: {
  probe?: boolean;
  runtimeSnapshot?: ChannelRuntimeSnapshot;
}) {
  // Always track the newest runtimeSnapshot so it is not silently discarded when
  // a refresh is already in-flight and a second caller provides a fresher snapshot.
  if (opts?.runtimeSnapshot !== undefined) {
    pendingRuntimeSnapshot = opts.runtimeSnapshot;
  }

  // Track the latest probe intent so the finally block uses the most recent caller's preference.
  // Only set when probe is true — false is the default, so storing it would trigger needless
  // follow-up refreshes (hadPendingProbe would be true even though nothing changed).
  if (opts?.probe) {
    pendingProbe = opts.probe;
  }

  if (!healthRefresh) {
    // Capture and clear the pending snapshot for this refresh cycle.
    const snapshotForRefresh = pendingRuntimeSnapshot;
    pendingRuntimeSnapshot = undefined;
    const probeForRefresh = pendingProbe ?? false;
    pendingProbe = undefined; // must be cleared so finally block only fires for NEW callers

    healthRefresh = (async () => {
      const snap = await getHealthSnapshot({
        probe: probeForRefresh,
        runtimeSnapshot: snapshotForRefresh,
      });
      healthCache = snap;
      healthVersion += 1;
      if (broadcastHealthUpdate) {
        broadcastHealthUpdate(snap);
      }
      return snap;
    })().finally(() => {
      healthRefresh = null;
      // Capture the latest probe intent and whether a newer probe arrived while
      // the refresh was in-flight, before clearing.
      const followUpProbe = pendingProbe ?? false;
      const hadPendingProbe = pendingProbe !== undefined;
      pendingProbe = undefined;
      // If a newer runtimeSnapshot or probe intent arrived while the refresh was
      // in-flight, kick off a follow-up so the latest state is reflected.
      if (pendingRuntimeSnapshot !== undefined || hadPendingProbe) {
        void refreshGatewayHealthSnapshot({ probe: followUpProbe }).catch(() => {});
      }
    });
  } else if (opts?.runtimeSnapshot !== undefined || opts?.probe) {
    // Caller provided fresh runtime data or a probe request that the in-flight
    // refresh won't include. Wait for the current refresh to complete (its
    // finally block will kick off a follow-up using pendingProbe or
    // pendingRuntimeSnapshot), then return the follow-up result so the caller
    // receives a snapshot that reflects the latest state.
    await healthRefresh;
    // After the finally block runs, healthRefresh is either the follow-up promise
    // (if pendingRuntimeSnapshot or hadPendingProbe was set) or null.
    if (healthRefresh) {
      return healthRefresh;
    }
    return healthCache!;
  }
  return healthRefresh;
}
