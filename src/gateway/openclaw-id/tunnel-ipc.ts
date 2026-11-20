// Control messages between the Gateway and its supervised tunnel child.
// The Node IPC channel carries control only: start config, ready, health and
// membership. Request data travels over the ingress socket, never over IPC.

/** Child exit code: the iroh transport cannot load on this platform. Not retried. */
export const TUNNEL_EXIT_UNAVAILABLE = 78;
/** Child exit code: the endpoint key file is unsafe or corrupt. Not retried. */
export const TUNNEL_EXIT_KEY_REFUSED = 77;
/** Child exit code: no file holds the endpoint key the claw is bound to. Not retried. */
export const TUNNEL_EXIT_KEY_MISSING = 76;
/** Child exit code: the endpoint key file holds another key than the bound one. Not retried. */
export const TUNNEL_EXIT_KEY_MISMATCH = 75;

/** argv flag for a one-shot child that stages the next endpoint key and binds nothing. */
export const TUNNEL_STAGE_ARG = "--stage";

/**
 * Sent once to a child started with {@link TUNNEL_STAGE_ARG}, which answers `staged` and
 * exits. `stage` creates the key at `keyPath` (the staged `.next` file) unless it exists.
 * `discard` deletes that file unless it holds `keep`, the K_srv the stored binding names
 * (a committed re-bind not promoted yet).
 */
export type TunnelStageMessage =
  | { type: "stage"; keyPath: string }
  | { type: "discard"; keyPath: string; keep: string };

/** A staged child's answer: the K_srv the staged key file holds, or null when there is none. */
type TunnelStagedMessage = { type: "staged"; endpointKey: string | null };

/** Sent once, right after the child starts. */
export type TunnelStartMessage = {
  type: "start";
  /** The only relay in the endpoint's relay map. */
  relayUrl: string;
  /** Endpoint secret key file (32 raw bytes, 0600); created by the child while unlinked. */
  keyPath: string;
  /**
   * K_srv the stored binding names (`iroh:<hex>`), once the claw is linked. The child
   * then loads only that key (promoting a staged `.next` file that holds it) and never
   * creates one.
   */
  expectedEndpointKey?: string;
  /** Optional UDP bind address (`host:port`). */
  bindAddr?: string;
  /** Gateway ingress the child proxies every stream to. */
  ingress: { socketPath: string; proxyToken: string };
  /** X-Forwarded-Proto the child reports to the Gateway. */
  forwardedProto: "http" | "https";
};

/** The admitted peer keys (`iroh:<hex>`). Replaces the previous set; nothing is admitted before the first one. */
type TunnelMembershipMessage = { type: "membership"; seq: number; admitted: string[] };

/** Health probe; the child answers with `pong`. */
type TunnelPingMessage = { type: "ping"; id: number };

/** Gateway -> child. */
export type GatewayToTunnelMessage =
  | TunnelStartMessage
  | TunnelMembershipMessage
  | TunnelPingMessage;

/** The endpoint is bound; the descriptor data the Gateway may publish. */
export type TunnelReadyMessage = {
  type: "ready";
  /** K_srv, `iroh:<64 hex>`. */
  endpointKey: string;
  relayUrl: string;
  /** Local UDP sockets (`host:port`) for direct dialing on the same host or LAN. */
  directAddrs: string[];
  keyCreated: boolean;
};

/** Answer to `ping`, with the child's resident set size. */
type TunnelPongMessage = { type: "pong"; id: number; rssBytes: number };

/**
 * Relay attachment and live connection counts. `relayDenied` carries the relay's
 * reason when it refused this claw's endpoint (not yet admitted by Discovery).
 */
type TunnelStateMessage = {
  type: "state";
  relayOnline: boolean;
  connections: number;
  relayDenied?: string | null;
};

/** Child -> Gateway. */
export type TunnelToGatewayMessage =
  | TunnelReadyMessage
  | TunnelPongMessage
  | TunnelStateMessage
  | TunnelStagedMessage;

/** Narrows an untrusted IPC payload to a child message. */
export function parseTunnelToGatewayMessage(value: unknown): TunnelToGatewayMessage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  // SAFETY: checked above to be a non-null object; each field is validated by the switch below.
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case "ready":
      return typeof message.endpointKey === "string" && typeof message.relayUrl === "string"
        ? {
            type: "ready",
            endpointKey: message.endpointKey,
            relayUrl: message.relayUrl,
            directAddrs: Array.isArray(message.directAddrs)
              ? message.directAddrs.filter((addr): addr is string => typeof addr === "string")
              : [],
            keyCreated: message.keyCreated === true,
          }
        : undefined;
    case "staged":
      return typeof message.endpointKey === "string" || message.endpointKey === null
        ? { type: "staged", endpointKey: message.endpointKey }
        : undefined;
    case "pong":
      return typeof message.id === "number" && typeof message.rssBytes === "number"
        ? { type: "pong", id: message.id, rssBytes: message.rssBytes }
        : undefined;
    case "state":
      return typeof message.relayOnline === "boolean" && typeof message.connections === "number"
        ? {
            type: "state",
            relayOnline: message.relayOnline,
            connections: message.connections,
            relayDenied: typeof message.relayDenied === "string" ? message.relayDenied : null,
          }
        : undefined;
    default:
      return undefined;
  }
}
