import type { IncomingMessage, ServerResponse } from "node:http";
import { getRuntimeConfig } from "../config/io.js";
import { getUserBackgroundImage } from "../state/user-background.js";
import { setControlUiImageCorsHeaders } from "./control-ui-image-cors.js";
import { parseControlUiUserBackgroundPath } from "./control-ui-user-background-route.js";
import { authorizeControlUiReadRequestOrReply } from "./http-auth-utils.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";
import type { GatewayHttpRequestAuthOptions } from "./http-request-authority.js";

/** Private bytes are never authorized by an asset ID, avatar visibility, or a query token. */
export async function handleUserBackgroundHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  options: GatewayHttpRequestAuthOptions & { basePath?: string },
): Promise<boolean> {
  const parsed = parseControlUiUserBackgroundPath(pathname, options.basePath);
  if (!parsed.matched) {
    return false;
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const corsAllowed = setControlUiImageCorsHeaders(
    req,
    res,
    options.cfg ?? options.getRuntimeConfig?.() ?? getRuntimeConfig(),
    options.publishedPort,
  );
  if (req.method === "OPTIONS") {
    if (!corsAllowed) {
      sendJson(res, 403, { error: { type: "origin_not_allowed" } });
      return true;
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD");
    res.setHeader("Access-Control-Allow-Headers", "Authorization");
    res.setHeader("Access-Control-Max-Age", "600");
    res.writeHead(204);
    res.end();
    return true;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendMethodNotAllowed(res, "GET, HEAD");
    return true;
  }
  const auth = await authorizeControlUiReadRequestOrReply({
    req,
    res,
    ...options,
    requiredOperatorMethod: "users.background.get",
    allowQueryToken: false,
  });
  if (!auth) {
    return true;
  }
  // CORS is separate from explicit-credential authorization. Reapply the live
  // origin grant after attribution; revoked browser origins must not inherit ACAO.
  setControlUiImageCorsHeaders(
    req,
    res,
    options.getRuntimeConfig?.() ?? getRuntimeConfig(),
    options.publishedPort,
  );
  const profileId = auth.authenticatedUserProfile?.profileId;
  if (!profileId || !parsed.assetId) {
    auth.assertCurrent();
    sendJson(res, 404, { error: { type: "not_found" } });
    return true;
  }
  for (;;) {
    const prepared = await getUserBackgroundImage(profileId, parsed.assetId, {
      assertCurrent: auth.assertCurrent,
      includeBytes: req.method !== "HEAD",
    });
    await auth.revalidate();
    // Credential verification may yield while the image is replaced or removed.
    if (!prepared.isCurrent()) {
      continue;
    }
    setControlUiImageCorsHeaders(
      req,
      res,
      options.getRuntimeConfig?.() ?? getRuntimeConfig(),
      options.publishedPort,
    );
    auth.assertCurrent();
    const image = prepared.image;
    if (prepared.byteLength === undefined) {
      sendJson(res, 404, { error: { type: "not_found" } });
      return true;
    }
    res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": prepared.byteLength });
    res.end(req.method === "HEAD" ? undefined : image);
    return true;
  }
}
