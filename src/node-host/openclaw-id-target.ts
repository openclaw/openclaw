import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isClawId,
  isEd25519PublicKey,
  isKeyFingerprint,
  parseStatement,
  type BindingEvidence,
  type ClawPin,
  type FreshnessState,
} from "../../packages/openclaw-id-protocol/src/index.js";

/** Public enrollment facts only. W's secret is held separately in private node state. */
export type NodeHostOpenClawIdTarget = {
  hostname: string;
  pin: ClawPin & { claw_id: string };
  evidence: BindingEvidence;
  relayUrl: string;
  /** Deployment-selected routing; never derived from hostname or relay. */
  discoveryUrl: string;
  freshness?: FreshnessState;
};

/**
 * Preview builds saved targets without a Discovery origin. Their trust facts still load so
 * `node join --discovery-url` can retain them, but such a target never dials.
 */
export type SavedNodeHostOpenClawIdTarget = Omit<NodeHostOpenClawIdTarget, "discoveryUrl"> & {
  discoveryUrl?: string;
};

export function parseNodeHostOpenClawIdTarget(value: unknown): NodeHostOpenClawIdTarget {
  return dialableNodeHostOpenClawIdTarget(parseSavedNodeHostOpenClawIdTarget(value));
}

export function dialableNodeHostOpenClawIdTarget(
  target: SavedNodeHostOpenClawIdTarget,
): NodeHostOpenClawIdTarget {
  const { discoveryUrl } = target;
  if (discoveryUrl === undefined) {
    throw new Error(
      "OpenClaw ID Discovery origin is missing; ask the owner to remove this node on the Access page, then re-join this node with a new link and --discovery-url",
    );
  }
  return { ...target, discoveryUrl };
}

export function parseSavedNodeHostOpenClawIdTarget(value: unknown): SavedNodeHostOpenClawIdTarget {
  if (
    !isRecord(value) ||
    typeof value.hostname !== "string" ||
    !value.hostname ||
    !isRecord(value.pin) ||
    !isClawId(value.pin.claw_id) ||
    !isKeyFingerprint(value.pin.root_fp) ||
    typeof value.pin.binding_seq !== "number" ||
    !Number.isSafeInteger(value.pin.binding_seq) ||
    value.pin.binding_seq < 1 ||
    !isRecord(value.evidence) ||
    !isEd25519PublicKey(value.evidence.root_pub) ||
    typeof value.relayUrl !== "string"
  ) {
    throw new Error("invalid OpenClaw ID node target");
  }
  const relayUrl = parseNodeRelayUrl(value.relayUrl);
  if (!relayUrl) {
    throw new Error("invalid OpenClaw ID relay URL");
  }
  const discoveryUrl =
    value.discoveryUrl === undefined ? undefined : parseNodeDiscoveryOrigin(value.discoveryUrl);
  let freshness: FreshnessState | undefined;
  if (value.freshness !== undefined) {
    const stored = value.freshness;
    if (!isRecord(stored) || stored.claw_id !== value.pin.claw_id) {
      throw new Error("invalid OpenClaw ID node freshness state");
    }
    const marker = stored.snapshot;
    if (marker === null) {
      freshness = { claw_id: stored.claw_id, snapshot: null };
    } else {
      if (
        !isRecord(marker) ||
        !isNonNegativeInteger(marker.seq) ||
        !isNonNegativeInteger(marker.issued_at) ||
        !isNonNegativeInteger(marker.binding_seq) ||
        (marker.k_gw !== undefined && !isEd25519PublicKey(marker.k_gw)) ||
        (marker.k_gw_binding_seq !== undefined && !isNonNegativeInteger(marker.k_gw_binding_seq))
      ) {
        throw new Error("invalid OpenClaw ID node freshness state");
      }
      freshness = {
        claw_id: stored.claw_id,
        snapshot: {
          seq: marker.seq,
          issued_at: marker.issued_at,
          binding_seq: marker.binding_seq,
          ...(marker.k_gw !== undefined ? { k_gw: marker.k_gw } : {}),
          ...(marker.k_gw_binding_seq !== undefined
            ? { k_gw_binding_seq: marker.k_gw_binding_seq }
            : {}),
        },
      };
    }
  }
  if (value.pin.k_gw !== undefined && !isEd25519PublicKey(value.pin.k_gw)) {
    throw new Error("invalid OpenClaw ID node pin");
  }
  const binding = parseStatement(value.evidence.binding, "ServerBinding");
  if (
    !binding.ok ||
    binding.statement.body.binding_seq !== value.pin.binding_seq ||
    binding.statement.body.claw_id !== value.pin.claw_id ||
    binding.statement.body.hostname !== value.hostname ||
    (value.pin.k_gw !== undefined && binding.statement.body.k_gw !== value.pin.k_gw)
  ) {
    throw new Error("invalid OpenClaw ID ServerBinding");
  }
  return {
    hostname: value.hostname,
    pin: {
      claw_id: value.pin.claw_id,
      root_fp: value.pin.root_fp,
      binding_seq: value.pin.binding_seq,
      ...(value.pin.k_gw !== undefined ? { k_gw: value.pin.k_gw } : {}),
    },
    evidence: { root_pub: value.evidence.root_pub, binding: binding.statement },
    relayUrl,
    ...(discoveryUrl ? { discoveryUrl } : {}),
    ...(freshness ? { freshness } : {}),
  };
}

/** Unsigned routing hint: a dialable relay URL without credentials or fragments. */
export function parseNodeRelayUrl(value: unknown): string | undefined {
  const relay = typeof value === "string" ? URL.parse(value) : null;
  if (
    !relay ||
    !["https:", "http:"].includes(relay.protocol) ||
    relay.username ||
    relay.password ||
    relay.hash
  ) {
    return undefined;
  }
  return relay.href;
}

/** Discovery routing is deployment configuration, not an authority or a relay hint. */
export function parseNodeDiscoveryOrigin(value: unknown): string {
  const discovery = typeof value === "string" ? URL.parse(value) : null;
  const localHttp =
    discovery?.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(discovery.hostname);
  if (
    !discovery ||
    (!localHttp && discovery.protocol !== "https:") ||
    discovery.username ||
    discovery.password ||
    discovery.pathname !== "/" ||
    discovery.search ||
    discovery.hash
  ) {
    throw new Error("invalid OpenClaw ID Discovery origin");
  }
  return discovery.origin;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Discovery routing can change without changing the claw's trust identity. */
export function sameNodeHostOpenClawIdIdentity(
  a: SavedNodeHostOpenClawIdTarget,
  b: SavedNodeHostOpenClawIdTarget,
): boolean {
  return (
    a.hostname === b.hostname && a.pin.claw_id === b.pin.claw_id && a.pin.root_fp === b.pin.root_fp
  );
}

/** A reconnect may advance trust within a claw, never switch its configured identity or route. */
export function sameNodeHostOpenClawIdScope(
  a: SavedNodeHostOpenClawIdTarget,
  b: SavedNodeHostOpenClawIdTarget,
): boolean {
  return sameNodeHostOpenClawIdIdentity(a, b) && a.discoveryUrl === b.discoveryUrl;
}
