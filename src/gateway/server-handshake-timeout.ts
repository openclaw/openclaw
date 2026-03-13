import type { IncomingMessage } from "node:http";
import { isLocalDirectRequest } from "./auth.js";
import { getHandshakeTimeoutMs } from "./server-constants.js";

export function resolveHandshakeTimeoutMs(params: {
  req: IncomingMessage;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
}): number {
  const isLocalHandshake = isLocalDirectRequest(
    params.req,
    params.trustedProxies,
    params.allowRealIpFallback === true,
  );
  return getHandshakeTimeoutMs(isLocalHandshake);
}
