import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { getRuntimeConfig } from "../../config/io.js";
import { readPreparedGatewayIngressAttribution } from "../ingress-attribution.js";
import type { GatewayConnectionIngress } from "./connection-transport.js";
import { checkGatewayWsBrowserOrigin } from "./ws-origin-policy.js";

export type GatewayOperatorHttpIngress = GatewayConnectionIngress & { binding: string };

/** Capture actual listener-prepared facts, never a synthetic upgrade request. */
export function captureGatewayOperatorHttpIngress(
  request: IncomingMessage,
): GatewayOperatorHttpIngress | undefined {
  const attribution = readPreparedGatewayIngressAttribution(request);
  if (!attribution || attribution.kind === "unattributable-proxy") {
    return undefined;
  }
  const forwardingPolicy = () => {
    const gateway = getRuntimeConfig().gateway;
    return JSON.stringify([gateway?.trustedProxies ?? [], gateway?.allowRealIpFallback === true]);
  };
  const policy = forwardingPolicy();
  const headers = () =>
    JSON.stringify(
      Object.entries(request.headers)
        .filter(
          ([name]) =>
            name === "host" ||
            name === "origin" ||
            name === "forwarded" ||
            name === "x-real-ip" ||
            name === "x-openclaw-scopes" ||
            name.startsWith("x-forwarded-") ||
            name.startsWith("tailscale-"),
        )
        .toSorted(([a], [b]) => a.localeCompare(b)),
    );
  const admittedHeaders = headers();
  const host = request.headers.host;
  const origin = request.headers.origin;
  const browserOrigin = {
    requestHost: host,
    origin,
    isLocalClient: attribution.kind === "direct-local",
  };
  const binding = createHash("sha256")
    .update(
      JSON.stringify([
        attribution.kind,
        attribution.clientIp,
        request.socket.remoteAddress,
        admittedHeaders,
      ]),
    )
    .digest("hex");
  return Object.freeze({
    request,
    attribution,
    binding,
    // A changed forwarding policy requires reconnect, even if it would grant
    // more trust. Retained frames never reinterpret their original ingress.
    isCurrent: () =>
      policy === forwardingPolicy() &&
      admittedHeaders === headers() &&
      (origin === undefined || checkGatewayWsBrowserOrigin(browserOrigin, getRuntimeConfig()).ok),
  });
}
