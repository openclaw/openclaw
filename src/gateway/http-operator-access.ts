import type { ServerResponse } from "node:http";
import type { PluginGatewayAccessAuthority } from "../plugins/gateway-access-policy.types.js";
import type { GatewayAuthResult } from "./auth.js";
import {
  prepareGatewayHttpErrorResponse,
  sendGatewayAuthFailure,
  sendJson,
} from "./http-common.js";
import {
  GATEWAY_OPERATOR_ACCESS_DENIED_MESSAGE,
  hasCurrentGatewayOperatorAccess,
} from "./operator-access-policy.js";

export function sendGatewayHttpAuthFailure(
  res: ServerResponse,
  authResult: GatewayAuthResult,
): void {
  if (authResult.reason !== "operator_access_denied") {
    sendGatewayAuthFailure(res, authResult);
    return;
  }
  if (!prepareGatewayHttpErrorResponse(res, "Forbidden")) {
    return;
  }
  sendJson(res, 403, {
    error: { message: GATEWAY_OPERATOR_ACCESS_DENIED_MESSAGE, type: "forbidden" },
  });
}

/** The listener belongs to this response, never to a reusable keep-alive socket. */
export function bindHttpOperatorAccessAuthority(
  res: ServerResponse,
  authority: PluginGatewayAccessAuthority | null | undefined,
): boolean {
  if (!authority) {
    return true;
  }
  if (!hasCurrentGatewayOperatorAccess(authority)) {
    if (!res.writableEnded && !res.destroyed) {
      sendGatewayHttpAuthFailure(res, { ok: false, reason: "operator_access_denied" });
    }
    return false;
  }
  if (res.writableEnded || res.destroyed) {
    return false;
  }
  const release = () => {
    authority.signal.removeEventListener("abort", revoke);
    res.off("finish", release);
    res.off("close", release);
  };
  const revoke = () => {
    release();
    if (!res.writableEnded && !res.destroyed) {
      res.destroy();
    }
  };
  authority.signal.addEventListener("abort", revoke, { once: true });
  res.once("finish", release);
  res.once("close", release);
  return true;
}
