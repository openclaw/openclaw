import type { IncomingMessage, ServerResponse } from "node:http";
import { dispatchNativeHookRelayHttpCallback } from "../agents/harness/native-hook-relay.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";

/** Independent capability auth: forwarded operator identity is never accepted. */
export async function handleNativeHookRelayHttpRequest(options: {
  req: IncomingMessage;
  res: ServerResponse;
  clientIp: string;
  rateLimiter?: AuthRateLimiter;
}): Promise<boolean> {
  const { req, res, clientIp, rateLimiter } = options;
  const scope = "native-hook-callback";
  if (rateLimiter && !rateLimiter.check(clientIp, scope).allowed) {
    res.writeHead(429).end();
    return true;
  }
  await dispatchNativeHookRelayHttpCallback(req, res);
  if (res.statusCode === 403) {
    rateLimiter?.recordFailure(clientIp, scope);
  }
  return true;
}
