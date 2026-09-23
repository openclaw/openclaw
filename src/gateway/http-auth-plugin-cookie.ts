// HTTP cookie handoff and lifetime belong to the Gateway auth owner.
import type { IncomingMessage, ServerResponse } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sha256Base64Url } from "../infra/crypto-digest.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { resolveGatewayAuthPolicyGeneration } from "./auth-policy.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { resolveControlUiPluginAuthCookieGrants } from "./control-ui-plugin-auth-cookie.js";
import {
  applyHttpOperatorRoleScopeCeiling,
  checkHttpCookieUserProfile,
} from "./http-auth-user-profile.js";
import { sendUnauthorized } from "./http-common.js";
import { getBearerToken } from "./http-header-value.js";
import {
  bindHttpOperatorAccessAuthority,
  sendGatewayHttpAuthFailure,
} from "./http-operator-access.js";
import { hasCurrentGatewayOperatorAccess } from "./operator-access-policy.js";
import { normalizeOperatorScopeList } from "./operator-scopes.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";

type CookieRequestAuth = NonNullable<ReturnType<typeof authorizeControlUiPluginCookieRequest>>;

export function resolveControlUiPluginAuthCookieGeneration(
  authGeneration: string | undefined,
  cfg: OpenClawConfig,
): string | undefined {
  return authGeneration
    ? sha256Base64Url(`${authGeneration}\0${resolveGatewayAuthPolicyGeneration(cfg)}`)
    : undefined;
}

export function authorizeControlUiPluginCookieRequest(
  req: IncomingMessage,
  params: { requestPath: string; authGeneration: string | undefined; res?: ServerResponse },
) {
  // WebSocket upgrades bypass this HTTP-only handoff and use
  // checkGatewayHttpRequestAuth directly in attachGatewayUpgradeHandler.
  // Explicit owner/staff credentials retain their own authority even when an
  // unrelated visitor cookie remains in the browser.
  if (getBearerToken(req) || (req.method !== "GET" && req.method !== "HEAD")) {
    return null;
  }
  // Native plugins and the UI they serve share the Gateway's trusted in-process
  // boundary. Cross-site sandbox descendants need an ambient cookie, so this
  // handoff is read-only; mutations stay on explicit Gateway auth surfaces.
  const cfg = getRuntimeConfig();
  const grants = resolveControlUiPluginAuthCookieGrants(req, {
    requestPath: params.requestPath,
    generation: resolveControlUiPluginAuthCookieGeneration(params.authGeneration, cfg),
  });
  if (grants.length === 0) {
    return null;
  }
  const profileAuth = checkHttpCookieUserProfile(
    cfg,
    grants.map((grant) => grant.profileId),
  );
  if (!profileAuth.ok) {
    if (profileAuth.authResult.reason === "operator_access_denied" && params.res) {
      sendGatewayHttpAuthFailure(params.res, profileAuth.authResult);
    }
    return null;
  }
  const authenticatedProfile = profileAuth.profile;
  for (const grant of grants) {
    grant.scopes =
      normalizeOperatorScopeList(
        applyHttpOperatorRoleScopeCeiling(grant.scopes, authenticatedProfile),
      ) ?? [];
  }
  if (
    params.res &&
    !bindHttpOperatorAccessAuthority(params.res, authenticatedProfile.operatorAccessAuthority)
  ) {
    return null;
  }
  return {
    requestAuth: {
      trustDeclaredOperatorScopes: false,
      controlUiPluginGrants: grants,
      ...authenticatedProfile,
    },
    // Route dispatch selects the candidate that owns the first matched gateway
    // route. Do not union scopes before that owner boundary is known.
    operatorScopes: [],
  };
}

export function bindControlUiPluginCookieRequestAuthority(
  cookieAuth: CookieRequestAuth,
  params: {
    req: IncomingMessage;
    res: ServerResponse;
    requestPath: string;
    auth: ResolvedGatewayAuth;
    getResolvedAuth?: () => ResolvedGatewayAuth;
    trustedProxies?: string[];
    hasCurrentClientAuthority: () => boolean;
  },
) {
  const hasCurrentClientAuthority = () =>
    !params.res.writableEnded &&
    !params.res.destroyed &&
    params.hasCurrentClientAuthority() &&
    hasCurrentGatewayOperatorAccess(cookieAuth.requestAuth.operatorAccessAuthority);
  const revalidate = async () => {
    if (params.res.writableEnded || params.res.destroyed) {
      throw new Error("HTTP request authority expired");
    }
    // A renewed grant may satisfy a new request, never revive this original source.
    cookieAuth.requestAuth.operatorAccessAuthority?.assertCurrent();
    // Reuse the cookie/profile owner, including expiry and the current auth
    // generation. Admission does not extend a browser grant across awaited work.
    const current = authorizeControlUiPluginCookieRequest(params.req, {
      requestPath: params.requestPath,
      authGeneration: resolveSharedGatewaySessionGeneration(
        params.getResolvedAuth?.() ?? params.auth,
        params.trustedProxies ?? getRuntimeConfig().gateway?.trustedProxies,
      ),
    });
    const currentGrants = current?.requestAuth.controlUiPluginGrants ?? [];
    // Prepared data used the admitted policy, not just its operator scopes. A
    // policy change requires a fresh request before that data can be disclosed.
    if (
      !hasCurrentClientAuthority() ||
      !isDeepStrictEqual(
        current?.requestAuth.operatorRolePolicy,
        cookieAuth.requestAuth.operatorRolePolicy,
      ) ||
      !cookieAuth.requestAuth.controlUiPluginGrants.every((admitted) =>
        currentGrants.some(
          (grant) =>
            grant.pluginId === admitted.pluginId &&
            grant.path === admitted.path &&
            grant.match === admitted.match &&
            grant.profileId === admitted.profileId &&
            roleScopesAllow({
              role: "operator",
              requestedScopes: admitted.scopes,
              allowedScopes: grant.scopes,
            }),
        ),
      )
    ) {
      sendUnauthorized(params.res);
      throw new Error("Unauthorized");
    }
  };
  return {
    ...cookieAuth,
    requestAuth: {
      ...cookieAuth.requestAuth,
      hasCurrentClientAuthority,
      revalidate,
    },
  };
}
