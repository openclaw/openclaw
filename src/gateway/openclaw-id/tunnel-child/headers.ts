// Request headers toward the Gateway: client-supplied forwarding and identity
// headers are removed (protocol rules), then the ingress contract headers are
// set from facts the child authenticated itself, never from the client.
import {
  HOP_BY_HOP_HEADERS,
  INGRESS_HEADERS,
  stripClientHeaders,
  type HeaderPair,
} from "../../../../packages/openclaw-id-protocol/src/index.js";

/** Facts the child attaches to every proxied request. */
export type IngressFacts = {
  /** Authenticated peer key W, `iroh:<hex>`, from the QUIC handshake. */
  peerKey: string;
  /** Per-boot token proving the request came through the supervised child. */
  proxyToken: string;
  /** Synthetic per-device address (never loopback). */
  peerAddress: string;
  forwardedProto: "http" | "https";
};

/** Builds upstream headers for node:http / ws (repeated names become arrays). */
export function upstreamHeaders(
  pairs: HeaderPair[],
  facts: IngressFacts,
  kind: "http" | "ws",
): Record<string, string | string[]> {
  const host = pairs.find(([name]) => name.toLowerCase() === "host")?.[1];
  const out: Record<string, string | string[]> = {};
  for (const [rawName, value] of stripClientHeaders(pairs, kind)) {
    const name = rawName.toLowerCase();
    const existing = out[name];
    out[name] = existing === undefined ? value : [existing, value].flat();
  }
  out[INGRESS_HEADERS.peerKey] = facts.peerKey;
  out[INGRESS_HEADERS.proxyToken] = facts.proxyToken;
  out[INGRESS_HEADERS.forwardedFor] = facts.peerAddress;
  out[INGRESS_HEADERS.forwardedProto] = facts.forwardedProto;
  if (host) {
    out.host = host;
    out[INGRESS_HEADERS.forwardedHost] = host;
  }
  return out;
}

const HOP_BY_HOP = new Set<string>(HOP_BY_HOP_HEADERS);

/** Converts node:http rawHeaders into [name, value] pairs without hop-by-hop headers. */
export function responseHeaders(rawHeaders: string[]): HeaderPair[] {
  const pairs: HeaderPair[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]!;
    if (!HOP_BY_HOP.has(name.toLowerCase())) {
      pairs.push([name, rawHeaders[i + 1]!]);
    }
  }
  return pairs;
}
