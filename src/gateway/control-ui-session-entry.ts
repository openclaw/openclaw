import type { IncomingMessage, ServerResponse } from "node:http";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/index.js";
import { parseControlUiSessionReturnPath } from "./control-ui-session-entry-path.js";
import { resolveControlUiSessionPath } from "./control-ui-session-path-resolve.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import {
  checkGatewayHttpRequestAuth,
  resolveSharedSecretHttpOperatorScopes,
} from "./http-auth-utils.js";
import { sendGatewayAuthFailure } from "./http-common.js";
import type { GatewayHttpRequestAuthOptions } from "./http-request-authority.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import type { GatewayClient } from "./server-methods/types.js";
import type { SessionRowProjection } from "./session-row-projection.js";

/** This endpoint must remain behind the deployment's authenticated proxy, unlike /chat. */
export async function serveControlUiSessionEntry(
  params: GatewayHttpRequestAuthOptions & {
    req: IncomingMessage;
    res: ServerResponse;
    basePath: string;
    projection?: SessionRowProjection;
    serveApp: (path: string, isCurrent?: () => boolean) => Promise<boolean>;
  },
): Promise<true> {
  const { req, res, basePath, projection } = params;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.searchParams.get("path") ?? "";
  const target = parseControlUiSessionReturnPath(path, basePath);
  const probe = url.searchParams.get("probe") === "1";
  if (
    req.method !== "GET" ||
    !target ||
    url.searchParams.getAll("path").length !== 1 ||
    url.searchParams.getAll("probe").length > 1 ||
    [...url.searchParams.keys()].some((key) => key !== "path" && key !== "probe") ||
    (url.searchParams.has("probe") && !probe)
  ) {
    res.statusCode = 404;
    res.end("Not found");
    return true;
  }
  const auth = await checkGatewayHttpRequestAuth({ ...params, res: undefined }, true);
  if (!auth.ok) {
    // Token/password credentials belong to the normal browser login gate. The
    // app shell grants no data access; its existing WS/bootstrap checks still apply.
    if (!probe && (params.auth.mode === "token" || params.auth.mode === "password")) {
      await params.serveApp(path);
    } else {
      sendGatewayAuthFailure(res, auth.authResult);
    }
    return true;
  }
  const requestAuth = auth.requestAuth;
  const scopes =
    requestAuth.deviceOperatorScopes ?? resolveSharedSecretHttpOperatorScopes(req, requestAuth);
  const client: GatewayClient = {
    connect: {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: GATEWAY_CLIENT_IDS.CONTROL_UI,
        version: "internal",
        platform: "web",
        mode: GATEWAY_CLIENT_MODES.UI,
      },
      role: "operator",
      scopes,
    },
    authenticatedUserProfile: requestAuth.authenticatedUserProfile,
    internal: {
      operatorRoleActor: requestAuth.operatorRoleActor,
      operatorAccessAuthority: requestAuth.operatorAccessAuthority,
    },
  };
  // The HTTP client shares the resident profile facts used by connection-bound
  // session selection; authenticated display metadata alone carries no role/aliases.
  if (projection) {
    prepareGatewayRecipientProfile(client);
  }
  const selected =
    projection && authorizeOperatorScopesForMethod("chat.history", scopes).allowed
      ? await resolveControlUiSessionPath({
          target,
          projection,
          client,
          isCurrent: requestAuth.hasCurrentClientAuthority,
        })
      : null;
  if (!selected || !projection || !requestAuth.hasCurrentClientAuthority()) {
    if (probe) {
      res.statusCode = 403;
      res.end();
    } else {
      res.statusCode = 303;
      res.setHeader("Location", path);
      res.end();
    }
    return true;
  }
  const isCurrent = () => requestAuth.hasCurrentClientAuthority() && selected.isCurrent();
  if (probe) {
    res.statusCode = isCurrent() ? 204 : 403;
    res.end();
  } else {
    res.setHeader("X-OpenClaw-Session-Entry", "1");
    await params.serveApp(path, isCurrent);
  }
  return true;
}
