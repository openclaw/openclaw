import type { IncomingMessage } from "node:http";
import type { OpenClawConfig } from "../../config/types.js";
import { isLoopbackAddress, isTrustedProxyAddress } from "../net.js";
import { checkBrowserOrigin } from "../origin-check.js";

const HTTP_FORBIDDEN = 403;

type GatewayVerifyClientParams = {
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  getConfigSnapshot: () => OpenClawConfig;
};

/**
 * Pre-handshake WebSocket origin gate. Runs in `verifyClient` (before the HTTP
 * 101) and reuses the existing `checkBrowserOrigin` from the post-handshake
 * admission path, so both gates share one origin-policy contract.
 * Proxy classification: uses canonical `isTrustedProxyAddress` from net.ts
 * instead of raw forwarded-header presence. Non-browser clients send no Origin
 * and pass through; they authenticate post-handshake.
 */
export function createGatewayVerifyClient(params: GatewayVerifyClientParams) {
  const { log, getConfigSnapshot } = params;

  return (
    info: { origin: string; req: IncomingMessage },
    callback: (r: boolean, code?: number, msg?: string) => void,
  ) => {
    const { req } = info;
    const controlUi = getConfigSnapshot().gateway?.controlUi;
    const requestOrigin = info.origin?.slice(0, 256);

    if (!requestOrigin) {
      callback(true);
      return;
    }

    const remoteAddr = req.socket?.remoteAddress;
    const trustedProxies = getConfigSnapshot().gateway?.trustedProxies;
    const isBehindTrustedProxy = remoteAddr
      ? isTrustedProxyAddress(remoteAddr, trustedProxies)
      : false;
    const isLocalClient = isLoopbackAddress(remoteAddr) && !isBehindTrustedProxy;

    const originCheck = checkBrowserOrigin({
      requestHost: req.headers.host?.slice(0, 256),
      origin: requestOrigin,
      allowedOrigins: controlUi?.allowedOrigins,
      allowHostHeaderOriginFallback: controlUi?.dangerouslyAllowHostHeaderOriginFallback === true,
      isLocalClient,
    });

    if (!originCheck.ok) {
      log.warn(`verifyClient: origin not allowed (${originCheck.reason})`);
      callback(false, HTTP_FORBIDDEN, "origin not allowed");
      return;
    }

    callback(true);
  };
}
