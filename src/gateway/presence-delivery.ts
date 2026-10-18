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
): { fragment: string; snapshot: PresenceDeliverySnapshot; mode: "delta" | "reset" } {
  const full = createPresenceReset(source, presence, version);
  const rows = new Map(full.keys.map((key, index) => [key, presence[index]!]));
  const snapshot = { version, rows };
  const fullJSON = JSON.stringify(full);
  const previous = client.presenceSnapshot;
  let json = fullJSON;
  let mode: "delta" | "reset" = "reset";
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
      if (!before) {
        delta.upsert.push({ key, presence: row });
      } else if (before !== row) {
        // Compare the projected wire fields; undefined is omitted by JSON.
        const previousFields: Record<string, unknown> = before;
        const currentFields: Record<string, unknown> = row;
        const set: Partial<SystemPresence> = {};
        const unset: string[] = [];
        for (const [field, value] of Object.entries(currentFields)) {
          if (
            value !== undefined &&
            JSON.stringify(value) !== JSON.stringify(previousFields[field])
          ) {
            Object.defineProperty(set, field, { value, enumerable: true });
          }
        }
        for (const [field, value] of Object.entries(previousFields)) {
          if (value !== undefined && currentFields[field] === undefined) {
            unset.push(field);
          }
        }
        if (Object.keys(set).length > 0 || unset.length > 0) {
          delta.upsert.push({ key, set, unset });
        }
      }
    }
    const deltaJSON = JSON.stringify(delta);
    if (Buffer.byteLength(deltaJSON) < Buffer.byteLength(fullJSON)) {
      json = deltaJSON;
      mode = "delta";
    }
  }
  return { fragment: `,"payload":${json}`, snapshot, mode };
}
