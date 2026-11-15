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

type PresenceDelivery = {
  fragment: Buffer;
  snapshot: PresenceDeliverySnapshot;
  mode: "delta" | "reset";
};

// Source and projected rosters are immutable publication snapshots. Weak keys end
// preparation with that publication and never retain a recipient's old baselines.
const publications = new WeakMap<
  SystemPresence[],
  {
    version: number;
    keys: string[];
    audiences: WeakMap<
      SystemPresence[],
      {
        reset: string | PresenceDelivery;
        resetBytes: number;
        snapshot: PresenceDeliverySnapshot;
        deltas: WeakMap<PresenceDeliverySnapshot, PresenceDelivery>;
      }
    >;
  }
>();
const PAYLOAD_PREFIX = ',"payload":';

/** Prepare from the live recipient projection; commit only after socket.send accepts the frame. */
export function preparePresenceDelivery(
  client: GatewayWsClient,
  source: SystemPresence[],
  presence: SystemPresence[],
  version: number,
): PresenceDelivery {
  let publication = publications.get(source);
  if (!publication || publication.version !== version) {
    publication = { version, keys: source.map(getSystemPresenceKey), audiences: new WeakMap() };
    publications.set(source, publication);
  }
  const { keys, audiences } = publication;
  let audience = audiences.get(presence);
  if (!audience) {
    const rows = new Map<string, SystemPresence>();
    keys.forEach((key, index) => rows.set(key, presence[index]!));
    const reset = `${PAYLOAD_PREFIX}${JSON.stringify({ reset: true, version, presence, keys })}`;
    audience = {
      reset,
      resetBytes: Buffer.byteLength(reset),
      snapshot: { version, rows },
      deltas: new WeakMap(),
    };
    audiences.set(presence, audience);
  }
  const previous = client.presenceSnapshot;
  let delivery = previous ? audience.deltas.get(previous) : undefined;
  if (delivery) {
    return delivery;
  }
  const { snapshot } = audience;
  if (previous) {
    const { rows } = snapshot;
    const delta: PresenceDelta = {
      base: previous.version,
      version,
      upsert: [],
      remove: [...previous.rows.keys()].filter((key) => !rows.has(key)),
      order: keys,
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
            value !== previousFields[field] &&
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
    if (Buffer.byteLength(deltaJSON) < audience.resetBytes - PAYLOAD_PREFIX.length) {
      delivery = {
        fragment: Buffer.from(`${PAYLOAD_PREFIX}${deltaJSON}`),
        snapshot,
        mode: "delta",
      };
    }
  }
  if (!delivery) {
    // A delta-only publication needs the reset's wire size, but never its encoded bytes.
    if (typeof audience.reset === "string") {
      audience.reset = { fragment: Buffer.from(audience.reset), snapshot, mode: "reset" };
    }
    delivery = audience.reset;
  }
  if (previous) {
    audience.deltas.set(previous, delivery);
  }
  return delivery;
}
