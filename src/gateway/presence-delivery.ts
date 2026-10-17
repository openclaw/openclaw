import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../packages/gateway-protocol/src/client-info.js";
import type {
  PresenceDelta,
  PresenceReset,
} from "../../packages/gateway-protocol/src/presence-deltas.js";
import { getSystemPresenceKey, type SystemPresence } from "../infra/system-presence.js";
import type { GatewayWsClient, PresenceDeliverySnapshot } from "./server/ws-types.js";

export function acceptsPresenceDeltas(client: Pick<GatewayWsClient, "connect">): boolean {
  return hasGatewayClientCap(client.connect.caps, GATEWAY_CLIENT_CAPS.PRESENCE_DELTAS);
}

export function createPresenceReset(
  source: SystemPresence[],
  presence: SystemPresence[],
  version: number,
): PresenceReset {
  // Projection preserves source ordering; only watched-session fields change.
  return { reset: true, version, presence, keys: source.map(getSystemPresenceKey) };
}

/** Prepare from the live recipient projection; commit only after socket.send accepts the frame. */
export function preparePresenceDelivery(
  client: GatewayWsClient,
  source: SystemPresence[],
  presence: SystemPresence[],
  version: number,
): { fragment: string; snapshot: PresenceDeliverySnapshot } {
  const full = createPresenceReset(source, presence, version);
  const rows = new Map(full.keys.map((key, index) => [key, presence[index]!]));
  const snapshot = { version, rows };
  const fullJSON = JSON.stringify(full);
  const previous = client.presenceSnapshot;
  let json = fullJSON;
  if (previous) {
    const delta: PresenceDelta = {
      base: previous.version,
      version,
      upsert: [],
      remove: [...previous.rows.keys()].filter((key) => !rows.has(key)),
      order: full.keys,
    };
    for (const [key, row] of rows) {
      const before = previous.rows.get(key);
      if (before !== row && (!before || JSON.stringify(before) !== JSON.stringify(row))) {
        delta.upsert.push({ key, presence: row });
      }
    }
    const deltaJSON = JSON.stringify(delta);
    if (Buffer.byteLength(deltaJSON) < Buffer.byteLength(fullJSON)) {
      json = deltaJSON;
    }
  }
  return { fragment: `,"payload":${json}`, snapshot };
}
