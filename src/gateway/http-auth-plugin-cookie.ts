// HTTP cookie handoff and lifetime belong to the Gateway auth owner.
import type { IncomingMessage, ServerResponse } from "node:http";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sha256Base64Url } from "../infra/crypto-digest.js";
import { GatewayOperatorAccessUnavailableError } from "../infra/operator-authority-error.js";
import { captureGatewayAuthPolicy } from "./auth-policy.js";
import { resolveControlUiPluginAuthCookieGrants } from "./control-ui-plugin-auth-cookie.js";
import {
  applyHttpOperatorRoleScopeCeiling,
  checkHttpCookieUserProfile,
  prepareHttpUserProfileCatalog,
} from "./http-auth-user-profile.js";
import { getBearerToken } from "./http-header-value.js";
import {
  bindHttpOperatorAccessAuthority,
  sendGatewayHttpAuthFailure,
} from "./http-operator-access.js";
import {
  getRemoteControlUiIngressContext,
  assertRemoteControlUiIngressCurrent,
  readGatewayIngressTransport,
} from "./ingress-attribution.js";
import { normalizeOperatorScopeList } from "./operator-scopes.js";
import { hasGatewayDelegationClaim } from "./trusted-proxy-delegation.js";

export function resolveControlUiPluginAuthCookieGeneration(
  authGeneration: string | undefined,
  cfg: OpenClawConfig,
): string | undefined {
  return authGeneration
    ? sha256Base64Url(`${authGeneration}\0${captureGatewayAuthPolicy(cfg, null).generation}`)
    : undefined;
}

function readControlUiPluginCookieRequest(
  req: IncomingMessage,
  params: { requestPath: string; authGeneration: string | undefined },
) {
  const ingress = getRemoteControlUiIngressContext(req);
  assertRemoteControlUiIngressCurrent(ingress);
  // Tunnel requests already have a device principal. Cookie handoffs must not
  // replace its current membership/role with a previously signed browser grant.
  if (readGatewayIngressTransport(req)?.kind === "openclaw-id-tunnel") {
    return null;
  }
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
  if (hasGatewayDelegationClaim(req, cfg.gateway?.auth?.trustedProxy?.userHeader)) {
    return null;
  }
  const grants = resolveControlUiPluginAuthCookieGrants(req, {
    requestPath: params.requestPath,
    generation: resolveControlUiPluginAuthCookieGeneration(params.authGeneration, cfg),
  });
  if (grants.length === 0) {
    return null;
  }
  const profileId = grants[0]?.profileId;
  if (grants.some((grant) => grant.profileId !== profileId)) {
    return null;
  }
  return { cfg, grants, profileId };
}

export async function prepareControlUiPluginCookieRequest(
  req: IncomingMessage,
  params: { requestPath: string; authGeneration: string | undefined; res: ServerResponse },
) {
  const selected = readControlUiPluginCookieRequest(req, params);
  if (
    !getRemoteControlUiIngressContext(req) &&
    selected?.profileId &&
    !(await prepareHttpUserProfileCatalog(params.res))
  ) {
    return null;
  }
  return authorizeControlUiPluginCookieRequest(req, params);
}

export function authorizeControlUiPluginCookieRequest(
  req: IncomingMessage,
  params: { requestPath: string; authGeneration: string | undefined; res?: ServerResponse },
) {
  const selected = readControlUiPluginCookieRequest(req, params);
  if (!selected) {
    return null;
  }
  const { cfg, grants, profileId } = selected;
  const ingress = getRemoteControlUiIngressContext(req);
  const principal = ingress?.resolvePrincipal();
  const profileAuth = principal
    ? {
        ok: true as const,
        profile: {
          authenticatedUserProfile: principal.authenticatedUserProfile,
          openclawIdPrincipal: principal.openclawIdPrincipal,
          operatorRolePolicy: principal.operatorRolePolicy,
          operatorRoleActor: principal.operatorRoleActor,
          operatorAccessAuthority: principal.operatorAccessAuthority,
        },
      }
    : checkHttpCookieUserProfile(cfg, profileId);
  if (!profileAuth.ok) {
    const unavailable = profileAuth.authResult.reason === "operator_access_unavailable";
    if (unavailable && !params.res) {
      throw new GatewayOperatorAccessUnavailableError();
    }
    if (params.res && (unavailable || profileAuth.authResult.reason === "operator_access_denied")) {
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
