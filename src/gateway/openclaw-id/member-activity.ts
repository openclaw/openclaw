// What each OpenClaw ID device key is doing right now, for the owner's People
// page: whether a relayed Gateway connection is open for it, when this Gateway
// last saw it, and the active runs started over its connections. Everything is
// read from the Gateway's live client registry and run registry; nothing comes
// from Discovery.
import {
  getRpcSourceIdentity,
  isRpcSourceActive,
  listRpcSourceEntries,
} from "../../sessions/session-controller.rpc-sources.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { openclawIdTunnelConnectionsOf } from "./tunnel-connections.js";

/** One active run started over a device's relayed connection. */
type OpenClawIdPeerRun = { runId: string; sessionKey: string };

/** Live activity of one device key (iroh endpoint key W). */
export type OpenClawIdPeerActivity = {
  /** Open relayed Gateway connections for this key. */
  connections: number;
  /**
   * Last activity this Gateway observed for the key, in ms since the epoch:
   * the newest connection activity while connected, else the value kept from
   * the last read that saw it connected. Null when not seen since start.
   */
  lastSeenAt: number | null;
  runs: OpenClawIdPeerRun[];
};

/** Reads device activity on demand; cheap enough for every status read. */
export type OpenClawIdMemberActivityReader = {
  describe: (peerKeys: readonly string[]) => Record<string, OpenClawIdPeerActivity>;
};

// The newest activity time a connection reports, if any.
function connectionActivityAt(client: GatewayWsClient): number | undefined {
  const times = [
    client.connectionLastActivityAt,
    client.personPresence?.lastActivityAt,
    client.personPresence?.onlineSince,
  ].filter((value): value is number => typeof value === "number");
  return times.length > 0 ? Math.max(...times) : undefined;
}

/**
 * Creates the activity reader over the Gateway's live clients. It remembers
 * the last time it saw each key connected, so a member who just left still
 * shows when they were last active (until the Gateway restarts).
 */
export function createOpenClawIdMemberActivity(params: {
  clients: () => Iterable<GatewayWsClient>;
  now?: () => number;
}): OpenClawIdMemberActivityReader {
  const now = params.now ?? Date.now;
  const lastSeen = new Map<string, number>();
  return {
    describe(peerKeys) {
      const activity = new Map<string, OpenClawIdPeerActivity>(
        peerKeys.map((key) => [key, { connections: 0, lastSeenAt: null, runs: [] }]),
      );
      // Count open connections per key and note which connection belongs to whom.
      const keyOfConnection = new Map<string, string>();
      // Runs survive a socket close; use the connection owner's retained run custody.
      for (const key of peerKeys) {
        for (const connId of openclawIdTunnelConnectionsOf([key])) {
          keyOfConnection.set(connId, key);
        }
      }
      for (const client of params.clients()) {
        const key = client.internal?.openclawIdPeerKey;
        const entry = key ? activity.get(key) : undefined;
        if (!key || !entry) {
          continue;
        }
        entry.connections += 1;
        keyOfConnection.set(client.connId, key);
        const seen = connectionActivityAt(client) ?? now();
        lastSeen.set(key, Math.max(lastSeen.get(key) ?? 0, seen));
      }
      // Attribute each active run to the key whose connection started it.
      for (const [runId, ref] of listRpcSourceEntries()) {
        const connectionId = ref.adapter.requester?.connectionId;
        const key = connectionId ? keyOfConnection.get(connectionId) : undefined;
        const entry = key ? activity.get(key) : undefined;
        if (!entry || !isRpcSourceActive(ref)) {
          continue;
        }
        entry.runs.push({ runId, sessionKey: getRpcSourceIdentity(ref).sessionKey });
      }
      for (const [key, entry] of activity) {
        entry.lastSeenAt = lastSeen.get(key) ?? null;
      }
      return Object.fromEntries(activity);
    },
  };
}
