import type { IncomingMessage, ServerResponse } from "node:http";
import { LOBSTER_LOCAL_ID_PATTERN } from "../../packages/gateway-protocol/src/lobsterdex.js";
import { resolvePluginLobsterArtwork } from "../plugins/lobster-catalog.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { respondNotFound } from "./control-ui-http-utils.js";
import { parseControlUiResourcePath } from "./control-ui-resource-routes.js";
import { sendMethodNotAllowed } from "./http-common.js";
import {
  createHttpImageRepresentation,
  sendHttpImageResponse,
  type HttpImageRepresentation,
} from "./http-image-response.js";
import { authorizeControlUiReadRequestOrReply } from "./http-utils.js";

const imageByArtwork = new WeakMap<{ data: string; mimeType: string }, HttpImageRepresentation>();

/** Resolves captured validated bytes only after authenticating the current request. */
export async function handlePluginLobsterArtHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    basePath?: string;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const pathname = req.url ? new URL(req.url, "http://localhost").pathname : undefined;
  const request = parseControlUiResourcePath("pluginLobsterArt", pathname, opts.basePath);
  if (!request.matched) {
    return false;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendMethodNotAllowed(res, "GET, HEAD");
    return true;
  }
  if (
    !(await authorizeControlUiReadRequestOrReply({
      req,
      res,
      auth: opts.auth,
      trustedProxies: opts.trustedProxies,
      allowRealIpFallback: opts.allowRealIpFallback,
      rateLimiter: opts.rateLimiter,
    }))
  ) {
    return true;
  }
  const [packId, characterId] = request.segments ?? [];
  if (
    !request.value ||
    !packId ||
    !LOBSTER_LOCAL_ID_PATTERN.test(packId) ||
    !characterId ||
    !LOBSTER_LOCAL_ID_PATTERN.test(characterId)
  ) {
    respondNotFound(res);
    return true;
  }
  const artwork = resolvePluginLobsterArtwork(request.value, packId, characterId);
  if (!artwork) {
    respondNotFound(res);
    return true;
  }
  let image = imageByArtwork.get(artwork);
  if (!image) {
    image = createHttpImageRepresentation(Buffer.from(artwork.data, "base64"), artwork.mimeType);
    imageByArtwork.set(artwork, image);
  }
  sendHttpImageResponse({
    req,
    res,
    image,
    filename: artwork.mimeType === "image/png" ? "clawmoji.png" : "clawmoji.svg",
  });
  return true;
}
