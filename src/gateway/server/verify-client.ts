import type { IncomingMessage, OutgoingHttpHeaders } from "node:http";
import type { OpenClawConfig } from "../../config/types.js";
import { isLoopbackAddress } from "../net.js";
import { checkBrowserOrigin } from "../origin-check.js";

const HTTP_FORBIDDEN = 403;

type GatewayVerifyClientInfo = { origin: string; req: IncomingMessage };
type GatewayVerifyClientCallback = (
  result: boolean,
  code?: number,
  message?: string,
  headers?: OutgoingHttpHeaders,
) => void;

type GatewayVerifyClient = (
  info: GatewayVerifyClientInfo,
  callback: GatewayVerifyClientCallback,
) => void;

type GatewayVerifyClientParams = {
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  getConfigSnapshot: () => OpenClawConfig;
};

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

/**
 * Pre-handshake WebSocket origin gate. Runs in `verifyClient` (before the HTTP
 * 101) and reuses the existing `checkBrowserOrigin` from the post-handshake
 * admission path, so both gates share one origin-policy contract. Non-browser
 * clients send no Origin and pass through; they authenticate post-handshake.
 */
export function createGatewayVerifyClient(params: GatewayVerifyClientParams): GatewayVerifyClient {
  const { log, getConfigSnapshot } = params;

  return (info, callback) => {
    const { req } = info;
    const controlUi = getConfigSnapshot().gateway?.controlUi;
    const requestOrigin = info.origin?.slice(0, 256);

    if (!requestOrigin) {
      callback(true);
      return;
    }

    const hasProxyHeaders = Boolean(
      req.headers["x-forwarded-for"] ||
      req.headers["x-real-ip"] ||
      req.headers["x-forwarded-host"] ||
      req.headers["x-forwarded-proto"] ||
      req.headers.forwarded,
    );
    const isLocalClient = isLoopbackAddress(req.socket?.remoteAddress) && !hasProxyHeaders;

    const originCheck = checkBrowserOrigin({
      requestHost: headerValue(req.headers.host)?.slice(0, 256),
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
