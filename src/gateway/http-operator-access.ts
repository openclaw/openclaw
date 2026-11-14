import type { ServerResponse } from "node:http";
import {
  GatewayOperatorAccessUnavailableError,
  isOperatorAuthorityUnavailable,
} from "../infra/operator-authority-error.js";
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
  { retryable = true }: { retryable?: boolean } = {},
): void {
  if (authResult.reason === "operator_access_unavailable") {
    if (prepareGatewayHttpErrorResponse(res, "Service Unavailable")) {
      sendJson(res, 503, {
        error: {
          message: retryable
            ? new GatewayOperatorAccessUnavailableError().message
            : "Gateway access policy is unavailable. The operation may have completed; check its status before retrying.",
          type: "service_unavailable",
          retryable,
        },
      });
    }
    return;
  }
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
  replyOnFailure = true,
): boolean {
  if (!authority) {
    return true;
  }
  let failure: string | undefined;
  try {
    if (!hasCurrentGatewayOperatorAccess(authority)) {
      failure = "operator_access_denied";
    }
  } catch (error) {
    if (!isOperatorAuthorityUnavailable(error)) {
      throw error;
    }
    failure = "operator_access_unavailable";
  }
  if (failure) {
    if (replyOnFailure && !res.writableEnded && !res.destroyed) {
      sendGatewayHttpAuthFailure(res, { ok: false, reason: failure });
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
