// Authenticated HTTP avatar serving for durable user profiles.
import type { IncomingMessage, ServerResponse } from "node:http";
import { getProfileAvatar } from "../state/user-profiles.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";
import {
  authorizeScopedGatewayHttpRequestOrReply,
  resolveSharedSecretHttpOperatorScopes,
} from "./http-utils.js";

const USER_AVATAR_PATH = /^\/api\/users\/([^/]+)\/avatar$/u;

function resolveProfileId(req: IncomingMessage): string | null {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const match = USER_AVATAR_PATH.exec(url.pathname);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

/** Serves a profile avatar with the same HTTP operator auth as sibling gateway endpoints. */
export async function handleUserProfileAvatarHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const profileId = resolveProfileId(req);
  if (profileId === null) {
    return false;
  }
  if (!profileId) {
    sendJson(res, 404, { ok: false, error: { type: "not_found" } });
    return true;
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
  const etag = `"${avatar.updatedAt}"`;
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
