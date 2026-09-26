// HTTP request authority retains admitted policy and response lifetime through awaited work.
import type { IncomingMessage, ServerResponse } from "node:http";
import { ToolAuthorizationError } from "../agents/tool-input-error.js";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginGatewayAccessAuthority } from "../plugins/gateway-access-policy.types.js";
import { readUserProfileAliasRevision } from "../state/user-profile-events.js";
import { isGatewayAuthPolicyCurrent, resolveGatewayAuthPolicyGeneration } from "./auth-policy.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendUnauthorized } from "./http-common.js";
import { sendGatewayHttpAuthFailure } from "./http-operator-access.js";
import {
  GatewayOperatorAccessDeniedError,
  hasCurrentGatewayOperatorAccess,
} from "./operator-access-policy.js";
import { readOperatorRolePolicyRevision } from "./operator-role-policy.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";

/** Authority ended; its response has already been answered or closed. */
export class GatewayHttpRequestAuthorityError extends Error {}

/** Request owners consume authority outcomes; unexpected failures keep their own diagnostics. */
export function finishGatewayHttpAuthorityError(res: ServerResponse, error: unknown): boolean {
  if (error instanceof GatewayOperatorAccessDeniedError) {
    sendGatewayHttpAuthFailure(res, { ok: false, reason: "operator_access_denied" });
    return true;
  }
  return error instanceof GatewayHttpRequestAuthorityError;
}

export type GatewayHttpRequestAuthOptions = {
  auth: ResolvedGatewayAuth;
  cfg?: OpenClawConfig;
  getRuntimeConfig?: () => OpenClawConfig;
  getResolvedAuth?: () => ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

export type GatewayHttpRequestAuthority = {
  hasCurrentClientAuthority: () => boolean;
};

export type GatewayHttpResponseAuthority = GatewayHttpRequestAuthority & {
  assertCurrent: () => void;
  revalidate: () => Promise<void>;
};

export function assertGatewayHttpRequestCurrent(requestAuth: {
  hasCurrentClientAuthority?: () => boolean;
}): void {
  if (requestAuth.hasCurrentClientAuthority?.() === false) {
    throw new ToolAuthorizationError("Gateway requester authority changed");
  }
}

export function captureHttpRequestAuthority(
  params: GatewayHttpRequestAuthOptions & { req: IncomingMessage },
): () => boolean {
  const cfg = params.cfg ?? getRuntimeConfig();
  const generation = resolveGatewayAuthPolicyGeneration(cfg);
  const authGeneration = resolveSharedGatewaySessionGeneration(
    params.auth,
    params.trustedProxies ?? cfg.gateway?.trustedProxies,
  );
  const roleRevision = cfg.gateway?.roles ? readOperatorRolePolicyRevision() : undefined;
  const aliasRevision = readUserProfileAliasRevision();
  return () => {
    const current = params.getRuntimeConfig?.() ?? getRuntimeConfig();
    return (
      !params.req.socket?.destroyed &&
      isGatewayAuthPolicyCurrent(generation, current) &&
      (roleRevision === undefined || roleRevision === readOperatorRolePolicyRevision()) &&
      aliasRevision === readUserProfileAliasRevision() &&
      authGeneration ===
        resolveSharedGatewaySessionGeneration(
          params.getResolvedAuth?.() ?? params.auth,
          params.trustedProxies ?? current.gateway?.trustedProxies,
        )
    );
  };
}

export function bindHttpResponseAuthority<T>(
  auth: T & { operatorAccessAuthority?: PluginGatewayAccessAuthority | null },
  res: ServerResponse,
  hasCurrentClientAuthority: () => boolean,
): T & GatewayHttpResponseAuthority {
  const assertCurrent = () => {
    if (res.writableEnded || res.destroyed) {
      throw new GatewayHttpRequestAuthorityError("HTTP request authority expired");
    }
    if (!hasCurrentGatewayOperatorAccess(auth.operatorAccessAuthority)) {
      throw new GatewayOperatorAccessDeniedError();
    }
    if (!hasCurrentClientAuthority()) {
      sendUnauthorized(res);
      throw new GatewayHttpRequestAuthorityError("Unauthorized");
    }
  };
  return {
    ...auth,
    hasCurrentClientAuthority: () =>
      !res.writableEnded &&
      !res.destroyed &&
      hasCurrentClientAuthority() &&
      hasCurrentGatewayOperatorAccess(auth.operatorAccessAuthority),
    assertCurrent,
    revalidate: async () => assertCurrent(),
  };
}
