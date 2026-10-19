import { isLoopbackHostname } from "../../lib/gateway-locality.ts";

/** HTTP previews require a matching UI scheme and host to keep their authentication cookies. */
export function portalNeedsNewTab(portalUrl: string, controlUiUrl: string): boolean {
  const portal = new URL(portalUrl);
  const controlUi = new URL(controlUiUrl);
  // Without secure partitioned cookies, prefer a working top-level launch over
  // guessing registrable-domain relationships between different hostnames.
  return (
    portal.protocol === "http:" &&
    (controlUi.protocol !== portal.protocol || controlUi.hostname !== portal.hostname)
  );
}

/** A remote Gateway's loopback endpoint points at the browser, not the Gateway. */
export function portalNeedsRemoteIngress(portalUrl: string, gatewayUrl: string): boolean {
  return (
    isLoopbackHostname(new URL(portalUrl).hostname) &&
    !isLoopbackHostname(new URL(gatewayUrl).hostname)
  );
}
