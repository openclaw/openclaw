import type { IncomingMessage } from "node:http";
import { TLSSocket } from "node:tls";
import type { GatewayAttributedIngress } from "./ingress-attribution.js";
import { isLoopbackHost, resolveHostName } from "./net.js";

/** Transport provenance only. Proxy identity headers on public paths prove no user authority. */
export function isSecurePublicSessionIngress(
  req: IncomingMessage,
  ingress: GatewayAttributedIngress,
  publicOrigin?: string,
): boolean {
  const advertisedHttps = publicOrigin?.startsWith("https://") === true;
  const proto = req.headers["x-forwarded-proto"];
  return (
    req.socket instanceof TLSSocket ||
    (ingress.kind === "direct-local" && isLoopbackHost(resolveHostName(req.headers.host))) ||
    (ingress.kind === "trusted-proxy" &&
      advertisedHttps &&
      typeof proto === "string" &&
      proto.trim().toLowerCase() === "https") ||
    ((ingress.kind === "tailscale-serve" || ingress.kind === "tailscale-funnel") && advertisedHttps)
  );
}
