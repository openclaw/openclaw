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

export type PresenceDelivery = {
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
        reset?: string | PresenceDelivery;
        snapshot: PresenceDeliverySnapshot;
        deltas: WeakMap<PresenceDeliverySnapshot, PresenceDelivery>;
      }
    >;
  }
>();
const PAYLOAD_PREFIX = ',"payload":';

export type PreparePresenceProjection = (
  presence: SystemPresence[],
) => (client: GatewayWsClient) => SystemPresence[];

export function createPresenceBroadcast(
  payload: { presence: SystemPresence[] },
  prepare: PreparePresenceProjection | undefined,
  encode: (name: "payload", value: unknown) => string,
) {
  if (!prepare) {
    throw new Error("presence recipient projection unavailable");
  }
  // The publisher freezes its plain wrapper. Other inputs retain per-send source reads.
  const ownedPayload =
    Object.isFrozen(payload) &&
    Reflect.ownKeys(payload).length === 1 &&
    Object.getOwnPropertyDescriptor(payload, "presence")?.value !== undefined;
  const project = prepare(payload.presence);
  let fragments: Map<SystemPresence[], Buffer> | undefined;
  return (client: GatewayWsClient, stateVersion?: { presence?: number }) => {
    // Read the source before checking the recipient's current session authority.
    const projected = ownedPayload ? undefined : { ...payload, presence: project(client) };
    const presence = projected?.presence ?? project(client);
    const version = acceptsPresenceDeltas(client) ? stateVersion?.presence : undefined;
    if (version !== undefined) {
      return preparePresenceDelivery(client, payload.presence, presence, version);
    }
    if (projected && (Object.keys(projected).length !== 1 || "toJSON" in projected)) {
      return encode("payload", projected);
    }
    let fragment = fragments?.get(presence);
    if (!fragment) {
      fragment = Buffer.from(encode("payload", projected ?? { presence }));
      (fragments ??= new Map()).set(presence, fragment);
    }
    return fragment;
  };
}

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
    audience = {
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
  const resetText = () => JSON.stringify({ reset: true, version, presence, keys });
  if (previous) {
    const { rows } = snapshot;
    const delta: PresenceDelta = {
      base: previous.version,
      version,
      upsert: [],
      remove: [],
      order: keys,
    };
    for (const key of previous.rows.keys()) {
      if (!rows.has(key)) {
        delta.remove.push(key);
      }
    }
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
    const deltaBytes = Buffer.byteLength(deltaJSON);
    const reset = audience.reset;
    // Every projected row contains at least these two wire fields. Small deltas
    // can win without serializing the roster just to measure its reset size.
    if (
      deltaBytes < presence.length * '{"ts":0,"text":""}'.length ||
      deltaBytes <
        (typeof reset === "object"
          ? reset.fragment.length - PAYLOAD_PREFIX.length
          : Buffer.byteLength(reset ?? (audience.reset = resetText())))
    ) {
      delivery = {
        fragment: Buffer.from(`${PAYLOAD_PREFIX}${deltaJSON}`),
        snapshot,
        mode: "delta",
      };
    }
  }
  if (!delivery) {
    if (typeof audience.reset !== "object") {
      audience.reset = {
        fragment: Buffer.from(`${PAYLOAD_PREFIX}${audience.reset ?? resetText()}`),
        snapshot,
        mode: "reset",
      };
    }
    delivery = audience.reset;
  }
  if (previous) {
    audience.deltas.set(previous, delivery);
  }
  return delivery;
}
