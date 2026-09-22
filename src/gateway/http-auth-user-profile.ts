import type { IncomingMessage, ServerResponse } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/io.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHostAccountName } from "../infra/host-account-name.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginGatewayAccessAuthority } from "../plugins/gateway-access-policy.types.js";
import { intersectOperatorScopes } from "../shared/operator-scope-compat.js";
import { prepareUserProfileRoleAuthority } from "../state/user-channel-identity-operations.js";
import {
  ensureCanonicalGatewayOwnerProfile,
  ensureCanonicalUserProfileForEmail,
  ensureCanonicalUserProfileForTailscaleIdentity,
} from "../state/user-profile-writes.js";
import { getUserProfileDisplay, getUserProfileListItem } from "../state/user-profiles.js";
import type { GatewayAuthResult } from "./auth.js";
import { shouldUseGatewayOwnerProfile } from "./gateway-owner-profile.js";
import { createAuthenticatedGitHubIdentitySync } from "./github-user-identity.js";
import {
  GatewayOperatorAccessDeniedError,
  hasGatewayOperatorAccessPolicies,
  resolveGatewayOperatorAccessAuthority,
} from "./operator-access-policy.js";
import {
  resolveOperatorRolePolicyForAssignment,
  resolveOperatorRolePolicyForProfile,
} from "./operator-role-policy.js";
import { resolveBrowserOriginPolicy } from "./origin-check.js";
import type { GatewayClient } from "./server-methods/shared-types.js";
import { formatForLog } from "./ws-log.js";

const profileLog = createSubsystemLogger("gateway/user-profiles");

export type AuthenticatedHttpUserProfile = {
  authenticatedUserProfile?: GatewayClient["authenticatedUserProfile"];
  operatorRolePolicy?: GatewayOperatorRoleDefinition;
  operatorAccessAuthority?: PluginGatewayAccessAuthority;
};

type HttpUserProfileAuthResult =
  | { ok: true; profile: AuthenticatedHttpUserProfile }
  | { ok: false; authResult: GatewayAuthResult };

function failedHttpProfileAuthentication(error?: unknown): HttpUserProfileAuthResult {
  return {
    ok: false,
    authResult: {
      ok: false,
      reason:
        error instanceof GatewayOperatorAccessDeniedError
          ? "operator_access_denied"
          : "user_profile_unavailable",
    },
  };
}

export async function checkAuthenticatedHttpUserProfile(
  params: Parameters<typeof resolveAuthenticatedHttpUserProfile>[0],
): Promise<HttpUserProfileAuthResult> {
  try {
    return { ok: true, profile: await resolveAuthenticatedHttpUserProfile(params) };
  } catch (error) {
    return failedHttpProfileAuthentication(error);
  }
}

/** A signed cookie retains one exact profile reference; current policy still governs its admission. */
export function checkHttpCookieUserProfile(
  cfg: OpenClawConfig,
  profileIds: readonly (string | undefined)[],
): HttpUserProfileAuthResult {
  const profileId = profileIds[0];
  if (
    profileIds.some((candidate) => candidate !== profileId) ||
    (!profileId && (cfg.gateway?.roles || hasGatewayOperatorAccessPolicies(cfg)))
  ) {
    return failedHttpProfileAuthentication();
  }
  // A signed viewer still narrows session sharing when named roles are disabled.
  if (!profileId) {
    return { ok: true, profile: {} };
  }
  try {
    const profile = getUserProfileListItem(profileId);
    return { ok: true, profile: resolveHttpProfile(profileId, profile.updatedAt, cfg) };
  } catch (error) {
    return failedHttpProfileAuthentication(error);
  }
}

export function usesSharedSecretGatewayMethod(
  method: GatewayAuthResult["method"] | undefined,
): boolean {
  return method === "token" || method === "password";
}

export async function resolveAuthenticatedHttpUserProfile(params: {
  authResult: GatewayAuthResult;
  cfg: OpenClawConfig;
  getRuntimeConfig?: () => OpenClawConfig;
  req: IncomingMessage;
  res?: ServerResponse;
}): Promise<AuthenticatedHttpUserProfile> {
  const readAdmissionPolicy = (cfg: OpenClawConfig) => {
    return {
      auth: cfg.gateway?.auth,
      roles: cfg.gateway?.roles,
      trustedProxies: cfg.gateway?.trustedProxies,
      allowRealIpFallback: cfg.gateway?.allowRealIpFallback,
      browserOrigin: resolveBrowserOriginPolicy({ req: params.req, cfg }),
    };
  };
  const admissionPolicy = structuredClone(readAdmissionPolicy(params.cfg));
  const assertCurrent = () => {
    if (
      params.req.aborted ||
      params.req.socket?.destroyed ||
      params.res?.destroyed ||
      params.res?.writableEnded ||
      !isDeepStrictEqual(
        admissionPolicy,
        readAdmissionPolicy(params.getRuntimeConfig?.() ?? getRuntimeConfig()),
      )
    ) {
      throw new Error("HTTP profile acquisition authority expired");
    }
  };
  assertCurrent();
  const options = { assertCurrent };
  const authenticatedUserId = normalizeOptionalString(params.authResult.user);
  const rolesConfigured = Boolean(params.cfg.gateway?.roles);
  const accessPoliciesConfigured = hasGatewayOperatorAccessPolicies(params.cfg);
  if (!authenticatedUserId) {
    if (
      shouldUseGatewayOwnerProfile({
        role: "operator",
        authenticatedUserId,
        authMethod: params.authResult.method,
        rolesConfigured,
      })
    ) {
      try {
        const displayName = await resolveHostAccountName();
        assertCurrent();
        const profile = await ensureCanonicalGatewayOwnerProfile(displayName, options);
        // Shared-secret operators retain their existing authority, regardless of profile roles.
        return await prepareHttpProfile(profile.id, profile.updatedAt, assertCurrent);
      } catch (error) {
        assertCurrent();
        profileLog.warn(`owner profile resolution failed: ${formatForLog(error)}`);
        return {};
      }
    }
    throw new Error("operator role policies require a verified durable user profile");
  }
  try {
    const syncGitHubIdentity = createAuthenticatedGitHubIdentitySync({
      authResult: params.authResult,
      authConfig: params.cfg.gateway?.auth,
      requestHeaders: params.req.headers,
      assertCurrent,
    });
    const profile = syncGitHubIdentity
      ? await syncGitHubIdentity()
      : params.authResult.tailscaleIdentity
        ? await ensureCanonicalUserProfileForTailscaleIdentity(
            params.authResult.tailscaleIdentity,
            options,
          )
        : await ensureCanonicalUserProfileForEmail(authenticatedUserId, options);
    const profileId = "profileId" in profile ? profile.profileId : profile.id;
    return await prepareHttpProfile(
      profileId,
      profile.updatedAt,
      assertCurrent,
      usesSharedSecretGatewayMethod(params.authResult.method) ? undefined : params.cfg,
    );
  } catch (error) {
    assertCurrent();
    // Attribution enriches authenticated requests; configured role/access policies
    // make durable profile resolution a prerequisite for authorization.
    if (rolesConfigured || accessPoliciesConfigured) {
      throw error;
    }
    return {};
  }
}

async function prepareHttpProfile(
  profileId: string,
  updatedAt: number,
  assertCurrent: () => void,
  cfg?: OpenClawConfig,
) {
  assertCurrent();
  const authority = await prepareUserProfileRoleAuthority(profileId);
  assertCurrent();
  if (!authority?.isCurrent()) {
    throw new Error("HTTP profile authority changed during acquisition");
  }
  const display = authority.display;
  const operatorRolePolicy = cfg
    ? resolveOperatorRolePolicyForAssignment(display.id, authority.role, cfg)
    : undefined;
  const operatorAccessAuthority = cfg
    ? resolveGatewayOperatorAccessAuthority(profileId, cfg)
    : undefined;
  assertCurrent();
  if (!authority.isCurrent()) {
    throw new Error("HTTP profile authority changed during acquisition");
  }
  return projectHttpProfile(display, updatedAt, operatorRolePolicy, operatorAccessAuthority);
}

/** Cookie and media disclosure retain their existing synchronous final policy check. */
export function resolveHttpProfile(profileId: string, updatedAt: number, cfg?: OpenClawConfig) {
  const display = getUserProfileDisplay(profileId);
  const operatorRolePolicy = cfg ? resolveOperatorRolePolicyForProfile(display.id, cfg) : undefined;
  const operatorAccessAuthority = cfg
    ? resolveGatewayOperatorAccessAuthority(profileId, cfg)
    : undefined;
  return projectHttpProfile(display, updatedAt, operatorRolePolicy, operatorAccessAuthority);
}

function projectHttpProfile(
  display: ReturnType<typeof getUserProfileDisplay>,
  updatedAt: number,
  operatorRolePolicy: GatewayOperatorRoleDefinition | undefined,
  operatorAccessAuthority: PluginGatewayAccessAuthority | undefined,
) {
  return {
    authenticatedUserProfile: {
      profileId: display.id,
      displayName: display.displayName,
      avatarRevision: display.avatarRevision,
      hasAvatar: display.hasAvatar,
      updatedAt,
    },
    ...(operatorRolePolicy ? { operatorRolePolicy } : {}),
    ...(operatorAccessAuthority ? { operatorAccessAuthority } : {}),
  };
}

export function applyHttpOperatorRoleScopeCeiling(
  scopes: string[],
  auth: Pick<AuthenticatedHttpUserProfile, "operatorRolePolicy"> | undefined,
): string[] {
  const allowedScopes = auth?.operatorRolePolicy?.scopes;
  return allowedScopes ? intersectOperatorScopes(scopes, allowedScopes) : scopes;
}
