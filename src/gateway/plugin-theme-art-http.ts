import type { IncomingMessage, ServerResponse } from "node:http";
import {
  THEME_ARTWORK_ID_PATTERN,
  THEME_LOCAL_ID_PATTERN,
} from "../../packages/gateway-protocol/src/theme.js";
import { resolvePluginThemeArtwork } from "../plugins/theme-catalog.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { respondNotFound } from "./control-ui-http-utils.js";
import { parseControlUiResourcePath } from "./control-ui-resource-routes.js";
import { sendMethodNotAllowed } from "./http-common.js";
import { resolveHttpImageRepresentation, sendHttpImageResponse } from "./http-image-response.js";
import { authorizeControlUiReadRequestOrReply } from "./http-utils.js";

/** Serves published theme artwork without reopening plugin-owned files. */
export async function handlePluginThemeArtHttpRequest(
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
  const request = parseControlUiResourcePath("pluginThemeArt", pathname, opts.basePath);
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
  const [themeId, kind, artId] = request.segments ?? [];
  if (
    !request.value ||
    !themeId ||
    !THEME_LOCAL_ID_PATTERN.test(themeId) ||
    (kind !== "icon" && kind !== "hat" && kind !== "critter" && kind !== "background") ||
    !artId ||
    !THEME_ARTWORK_ID_PATTERN.test(artId)
  ) {
    respondNotFound(res);
    return true;
  }
  const artwork = resolvePluginThemeArtwork(request.value, themeId, kind, artId);
  const image = artwork && (await resolveHttpImageRepresentation(artwork.sourceName, artwork.body));
  if (!artwork || !image) {
    respondNotFound(res);
    return true;
  }
  sendHttpImageResponse({ req, res, image, filename: `plugin-${artwork.sourceName}` });
  return true;
}
