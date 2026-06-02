import type { Snapshot } from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { getHealthSnapshot, type HealthSummary } from "../../commands/health.js";
import { createConfigIO, getRuntimeConfig } from "../../config/io.js";
import { STATE_DIR } from "../../config/paths.js";
import { resolveMainSessionKey } from "../../config/sessions.js";
import { listSystemPresence } from "../../infra/system-presence.js";
import { getUpdateAvailable } from "../../infra/update-startup.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import { resolveGatewayAuth } from "../auth.js";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import type { GatewayEventLoopHealth } from "./event-loop-health.js";

let presenceVersion = 1;
let healthVersion = 1;
let healthCache: HealthSummary | null = null;
let healthRefresh: Promise<HealthSummary> | null = null;
let sensitiveHealthRefresh: Promise<HealthSummary> | null = null;
let broadcastHealthUpdate: ((snap: HealthSummary) => void) | null = null;

/** Builds the synchronous Gateway snapshot sent on connect before async health refresh fills in. */
export function buildGatewaySnapshot(opts?: { includeSensitive?: boolean }): Snapshot {
  const cfg = getRuntimeConfig();
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  const mainSessionKey = resolveMainSessionKey(cfg);
  const scope = cfg.session?.scope ?? "per-sender";
  const presence = listSystemPresence();
  const uptimeMs = Math.round(process.uptime() * 1000);
  const updateAvailable = getUpdateAvailable() ?? undefined;
  // Health is async; caller should await getHealthSnapshot and replace later if needed.
  const emptyHealth: unknown = {};
  const snapshot: Snapshot = {
    presence,
    health: emptyHealth,
    stateVersion: { presence: presenceVersion, health: healthVersion },
    uptimeMs,
    sessionDefaults: {
      defaultAgentId,
      mainKey,
      mainSessionKey,
      scope,
    },
    updateAvailable,
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

/** Returns the last non-sensitive health summary cached for post-connect snapshots. */
export function getHealthCache(): HealthSummary | null {
  return healthCache;
}

/** Returns the monotonic health version used by clients to ignore stale snapshots. */
export function getHealthVersion(): number {
  return healthVersion;
}

/** Increments the system-presence version after presence-affecting changes. */
export function incrementPresenceVersion(): number {
  presenceVersion += 1;
  return presenceVersion;
}

/** Returns the monotonic system-presence version included in Gateway snapshots. */
export function getPresenceVersion(): number {
  return presenceVersion;
}

/** Installs the broadcast callback invoked after non-sensitive health refreshes. */
export function setBroadcastHealthUpdate(fn: ((snap: HealthSummary) => void) | null) {
  broadcastHealthUpdate = fn;
}

/** Refreshes Gateway health with in-flight dedupe split by sensitive/non-sensitive views. */
export async function refreshGatewayHealthSnapshot(opts?: {
  probe?: boolean;
  includeSensitive?: boolean;
  getRuntimeSnapshot?: () => ChannelRuntimeSnapshot;
  getEventLoopHealth?: () => GatewayEventLoopHealth | undefined;
}) {
  const includeSensitive = opts?.includeSensitive === true;
  // Sensitive health may include paths/auth details, so keep its in-flight
  // promise separate from public refreshes that can be cached and broadcast.
  let refresh = includeSensitive ? sensitiveHealthRefresh : healthRefresh;
  if (!refresh) {
    refresh = (async () => {
      let runtimeSnapshot: ChannelRuntimeSnapshot | undefined;
      try {
        runtimeSnapshot = opts?.getRuntimeSnapshot?.();
      } catch {
        // Health refresh should survive transient channel snapshot failures and
        // still report the rest of the gateway state.
        runtimeSnapshot = undefined;
      }
      const eventLoop = opts?.getEventLoopHealth?.();
      const snap = await getHealthSnapshot({
        probe: opts?.probe,
        includeSensitive,
        runtimeSnapshot,
        ...(eventLoop ? { eventLoop } : {}),
      });
      if (!includeSensitive) {
        // Only public health updates advance the client-visible version/cache;
        // admin-sensitive probes are one-shot responses.
        healthCache = snap;
        healthVersion += 1;
        if (broadcastHealthUpdate) {
          broadcastHealthUpdate(snap);
        }
      }
      return snap;
    })().finally(() => {
      if (includeSensitive) {
        sensitiveHealthRefresh = null;
      } else {
        healthRefresh = null;
      }
    });
    if (includeSensitive) {
      sensitiveHealthRefresh = refresh;
    } else {
      healthRefresh = refresh;
    }
  }
  return refresh;
}
