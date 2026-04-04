import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { getHealthSnapshot, type HealthSummary } from "../../commands/health.js";
import { STATE_DIR, createConfigIO, loadConfig } from "../../config/config.js";
import { resolveMainSessionKey } from "../../config/sessions.js";
import { listSystemPresence } from "../../infra/system-presence.js";
import { getUpdateAvailable } from "../../infra/update-startup.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import { resolveGatewayAuth } from "../auth.js";
import type { Snapshot } from "../protocol/index.js";

let presenceVersion = 1;
let healthVersion = 1;
let healthCache: HealthSummary | null = null;
let healthSnapshotRefresh: Promise<HealthSummary> | null = null;
let healthProbeRefresh: Promise<HealthSummary> | null = null;
let broadcastHealthUpdate: ((snap: HealthSummary) => void) | null = null;

function commitHealthSnapshot(snap: HealthSummary): HealthSummary {
  healthCache = snap;
  healthVersion += 1;
  if (broadcastHealthUpdate) {
    broadcastHealthUpdate(snap);
  }
  return snap;
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

export async function refreshGatewayHealthSnapshot(opts?: { probe?: boolean }) {
  const wantsProbe = opts?.probe === true;
  const inFlight = wantsProbe ? healthProbeRefresh : healthSnapshotRefresh;
  if (inFlight) {
    return inFlight;
  }

  const refresh = (async () => {
    const snap = await getHealthSnapshot({ probe: wantsProbe });
    return commitHealthSnapshot(snap);
  })().finally(() => {
    if (wantsProbe) {
      if (healthProbeRefresh === refresh) {
        healthProbeRefresh = null;
      }
      return;
    }
    if (healthSnapshotRefresh === refresh) {
      healthSnapshotRefresh = null;
    }
  });

  if (wantsProbe) {
    healthProbeRefresh = refresh;
  } else {
    healthSnapshotRefresh = refresh;
  }
  return refresh;
}

export function __resetHealthStateForTest(): void {
  if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
    return;
  }
  presenceVersion = 1;
  healthVersion = 1;
  healthCache = null;
  healthSnapshotRefresh = null;
  healthProbeRefresh = null;
  broadcastHealthUpdate = null;
}
