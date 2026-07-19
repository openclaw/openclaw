// Authenticated HTTP avatar serving for durable user profiles.
import type { IncomingMessage, ServerResponse } from "node:http";
import { formatUserProfileAvatarEtag, getProfileAvatar } from "../state/user-profiles.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";
import {
  authorizeScopedGatewayHttpRequestOrReply,
  resolveSharedSecretHttpOperatorScopes,
} from "./http-utils.js";
import { matchUserProfileAvatarPath } from "./user-profiles-http-path.js";

/** Serves a profile avatar with the same HTTP operator auth as sibling gateway endpoints. */
export async function handleUserProfileAvatarHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const profileId = matchUserProfileAvatarPath(pathname);
  if (profileId === undefined) {
    return false;
  }
  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }
  const authResult = await authorizeScopedGatewayHttpRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    operatorMethod: "users.list",
    resolveOperatorScopes: resolveSharedSecretHttpOperatorScopes,
  });
  if (!authResult) {
    return true;
  }
  const avatar = getProfileAvatar(profileId);
  if (!avatar) {
    sendJson(res, 404, { ok: false, error: { type: "not_found" } });
    return true;
  }
  const etag = formatUserProfileAvatarEtag(avatar.sha256, avatar.mime);
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return true;
  }
  res.writeHead(200, {
    "Content-Type": avatar.mime,
    "Content-Length": avatar.bytes.byteLength,
    "Cache-Control": "private, max-age=0, must-revalidate",
    ETag: etag,
  });
  res.end(avatar.bytes);
  return true;
}
