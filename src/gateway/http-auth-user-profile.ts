import type { IncomingMessage, ServerResponse } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/io.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHostAccountName } from "../infra/host-account-name.js";
import { isOperatorAuthorityUnavailable } from "../infra/operator-authority-error.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { intersectOperatorScopes } from "../shared/operator-scope-compat.js";
import { prepareUserProfileRoleAuthority } from "../state/user-channel-identity-operations.js";
import {
  captureResidentUserProfileAccess,
  prepareUserProfileCatalog,
  readResidentUserProfileRevision,
  projectUserProfileDisplay,
} from "../state/user-profile-list.js";
import {
  ensureCanonicalGatewayOwnerProfile,
  ensureCanonicalUserProfileForEmail,
  ensureCanonicalDelegatedUserProfile,
  ensureCanonicalUserProfileForOpenClawIdIdentity,
  ensureCanonicalUserProfileForTailscaleIdentity,
} from "../state/user-profile-writes.js";
import type { GatewayAuthResult } from "./auth.js";
import type { ControlUiPluginTabAuthGrant } from "./control-ui-plugin-tabs.js";
import { shouldUseGatewayOwnerProfile } from "./gateway-owner-profile.js";
import { createAuthenticatedGitHubIdentitySync } from "./github-user-identity.js";
import type { AdmittedHttpOperatorDevice } from "./http-operator-device-token.js";
import type { GatewayHttpRequestAuthority } from "./http-request-authority.js";
import {
  getRemoteControlUiIngressContext,
  assertRemoteControlUiIngressCurrent,
} from "./ingress-attribution.js";
import { resolveOpenClawIdOperatorProfileEnrollment } from "./openclaw-id/operator-profile-enrollment.js";
import {
  isOpenClawIdTunnelPrincipalCurrent,
  type OpenClawIdTunnelPrincipal,
} from "./openclaw-id/tunnel-principal.js";
import {
  GatewayOperatorAccessDeniedError,
  hasGatewayOperatorAccessPolicies,
  resolveGatewayOperatorAccessAuthority,
} from "./operator-access-policy.js";
import type { GatewayOperatorAccessAuthority } from "./operator-access-policy.types.js";
import type { OperatorProfileEnrollment } from "./operator-device-profile.types.js";
import {
  resolveOperatorRolePolicyForAssignment,
  resolveOperatorRolePolicyForPrincipal,
} from "./operator-role-policy.js";
import { resolveBrowserOriginPolicy } from "./origin-check.js";
import type { GatewayClient, GatewayOperatorRoleActor } from "./server-methods/shared-types.js";
import { isGatewayDelegationCurrent } from "./trusted-proxy-delegation.js";
import { syncTrustedProxyGitCoauthor } from "./trusted-proxy-git-coauthor.js";
import { formatForLog } from "./ws-log.js";

const profileLog = createSubsystemLogger("gateway/user-profiles");

export type AuthenticatedHttpUserProfile = {
  authenticatedUserProfile?: GatewayClient["authenticatedUserProfile"];
  /** Original authenticated device authority, retained across synthetic execution clients. */
  openclawIdPrincipal?: OpenClawIdTunnelPrincipal;
  preparedSessionProfile?: GatewayClient["preparedSessionProfile"];
  operatorProfileEnrollment?: OperatorProfileEnrollment;
  operatorProfileScopeCeiling?: readonly string[];
  operatorRolePolicy?: GatewayOperatorRoleDefinition;
  operatorAccessAuthority?: GatewayOperatorAccessAuthority | null;
  operatorRoleActor?: GatewayOperatorRoleActor;
  hasCurrentProfileAuthority?: () => boolean;
};

type HttpUserProfileAuthResult =
  | { ok: true; profile: AuthenticatedHttpUserProfile }
  | { ok: false; authResult: GatewayAuthResult };

function failedHttpProfileAuthentication(error?: unknown): HttpUserProfileAuthResult {
  return {
    ok: false,
    authResult: {
      ok: false,
      reason: isOperatorAuthorityUnavailable(error)
        ? "operator_access_unavailable"
        : error instanceof GatewayOperatorAccessDeniedError
          ? "operator_access_denied"
          : "user_profile_unavailable",
    },
  };
}

// An OpenClaw ID tunnel device is capped by its membership role on every HTTP
// surface, and its request keeps authority only while that membership is
// unchanged: a removal or role change fails every later authority check.
function withOpenClawIdPrincipal(
  profile: AuthenticatedHttpUserProfile,
  principal: OpenClawIdTunnelPrincipal,
  cfg: OpenClawConfig,
): AuthenticatedHttpUserProfile {
  const person = profile.preparedSessionProfile;
  const rolePolicy = resolveOperatorRolePolicyForPrincipal(
    person?.profileId,
    person?.role ?? null,
    cfg,
    person?.githubLogin ?? null,
    principal,
    person ? profile.operatorProfileEnrollment : undefined,
  );
  const hasCurrentProfileAuthority = profile.hasCurrentProfileAuthority;
  return {
    ...profile,
    openclawIdPrincipal: principal,
    ...(rolePolicy ? { operatorRolePolicy: rolePolicy } : {}),
    hasCurrentProfileAuthority: () =>
      hasCurrentProfileAuthority?.() !== false && isOpenClawIdTunnelPrincipalCurrent(principal),
  };
}

export async function checkAuthenticatedHttpUserProfile(
  params: Parameters<typeof resolveAuthenticatedHttpUserProfile>[0],
): Promise<HttpUserProfileAuthResult> {
  try {
    const profile = await resolveAuthenticatedHttpUserProfile(params);
    const principal =
      profile.openclawIdPrincipal ??
      (params.authResult.method === "trusted-proxy" ? params.authResult.openclawId : undefined);
    return {
      ok: true,
      profile: principal ? withOpenClawIdPrincipal(profile, principal, params.cfg) : profile,
    };
  } catch (error) {
    return failedHttpProfileAuthentication(error);
  }
}

/** A signed cookie retains one exact profile reference; current policy still governs its admission. */
export function checkHttpCookieUserProfile(
  cfg: OpenClawConfig,
  profileId: string | undefined,
): HttpUserProfileAuthResult {
  if (!profileId && (cfg.gateway?.roles || hasGatewayOperatorAccessPolicies(cfg))) {
    return failedHttpProfileAuthentication();
  }
  // A signed viewer still narrows session sharing when named roles are disabled.
  if (!profileId) {
    return { ok: true, profile: {} };
  }
  try {
    return { ok: true, profile: resolveHttpProfile(profileId, cfg) };
  } catch (error) {
    return failedHttpProfileAuthentication(error);
  }
}

/** Response disclosure retains the existing profile owner through its last synchronous check. */
export async function prepareHttpUserProfileCatalog(res: ServerResponse): Promise<boolean> {
  if (res.writableEnded || res.destroyed) {
    return false;
  }
  let catalog: Awaited<ReturnType<typeof prepareUserProfileCatalog>>;
  try {
    catalog = await prepareUserProfileCatalog();
  } catch {
    return false;
  }
  const release = () => {
    res.off("finish", release);
    res.off("close", release);
    catalog.release();
  };
  if (res.writableEnded || res.destroyed) {
    release();
    return false;
  }
  res.once("finish", release);
  res.once("close", release);
  return true;
}

export function usesSharedSecretGatewayMethod(
  method: GatewayAuthResult["method"] | undefined,
): boolean {
  return method === "token" || method === "password";
}

export async function resolveAuthenticatedHttpUserProfile(params: {
  authResult: GatewayAuthResult;
  cfg: OpenClawConfig;
  operatorDevice?: AdmittedHttpOperatorDevice;
  getRuntimeConfig?: () => OpenClawConfig;
  req: IncomingMessage;
  res?: ServerResponse;
}): Promise<AuthenticatedHttpUserProfile> {
  const ingress = getRemoteControlUiIngressContext(params.req);
  if (ingress) {
    assertRemoteControlUiIngressCurrent(ingress);
  }
  const ingressPrincipal = ingress?.resolvePrincipal();
  const readAdmissionPolicy = (cfg: OpenClawConfig) => ({
    // HTTP admission never consumes WebSocket identity grants.
    auth: { ...cfg.gateway?.auth, identityScopes: undefined },
    roles: cfg.gateway?.roles,
    trustedProxies: cfg.gateway?.trustedProxies,
    allowRealIpFallback: cfg.gateway?.allowRealIpFallback,
    browserOrigin: {
      ...resolveBrowserOriginPolicy({ req: params.req, cfg }),
      // Ingress keeps live callbacks under its own authority above, not in a cloned policy.
      remoteControlUiIngress: undefined,
    },
  });
  const admissionPolicy = structuredClone(readAdmissionPolicy(params.cfg));
  let peerSource:
    | Awaited<ReturnType<typeof resolveOpenClawIdOperatorProfileEnrollment>>
    | undefined;
  const assertCurrent = () => {
    ingressPrincipal?.assertCurrent();
    if (
      params.operatorDevice?.isCurrent() === false ||
      peerSource?.isCurrent() === false ||
      (params.authResult.delegation &&
        !isGatewayDelegationCurrent(
          params.authResult.delegation,
          params.getRuntimeConfig?.() ?? getRuntimeConfig(),
        )) ||
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
  const idPrincipal =
    ingressPrincipal?.openclawIdPrincipal ??
    (params.authResult.method === "trusted-proxy" ? params.authResult.openclawId : undefined);
  if (idPrincipal) {
    peerSource = await resolveOpenClawIdOperatorProfileEnrollment(idPrincipal);
    assertCurrent();
  }
  const operatorSource = params.operatorDevice ?? peerSource;
  if (ingressPrincipal) {
    const profile: AuthenticatedHttpUserProfile = operatorSource?.enrollment
      ? await prepareHttpProfile(
          ingressPrincipal.operatorRoleActor.kind === "operator"
            ? ingressPrincipal.authenticatedUserProfile.profileId
            : operatorSource.enrollment.profileId,
          undefined,
          assertCurrent,
          params.cfg,
          operatorSource,
        )
      : {
          authenticatedUserProfile: ingressPrincipal.authenticatedUserProfile,
          preparedSessionProfile: ingressPrincipal.preparedSessionProfile,
          operatorRolePolicy: ingressPrincipal.operatorRolePolicy,
          operatorRoleActor: ingressPrincipal.operatorRoleActor,
          operatorAccessAuthority: ingressPrincipal.operatorAccessAuthority,
        };
    assertCurrent();
    const hasProfileAuthority = profile.hasCurrentProfileAuthority;
    return {
      ...profile,
      ...(idPrincipal ? { openclawIdPrincipal: idPrincipal } : {}),
      hasCurrentProfileAuthority: () => {
        try {
          assertCurrent();
          return hasProfileAuthority?.() !== false;
        } catch {
          return false;
        }
      },
    };
  }
  const options = { assertCurrent };
  const authenticatedUserId = normalizeOptionalString(params.authResult.user);
  const rolesConfigured = Boolean(params.cfg.gateway?.roles);
  const accessPoliciesConfigured = hasGatewayOperatorAccessPolicies(params.cfg);
  if (!authenticatedUserId && operatorSource?.enrollment) {
    return prepareHttpProfile(
      operatorSource.enrollment.profileId,
      undefined,
      assertCurrent,
      params.cfg,
      operatorSource,
    );
  }
  if (!authenticatedUserId) {
    if (
      shouldUseGatewayOwnerProfile({
        role: "operator",
        authenticatedUserId,
        authMethod: params.authResult.method,
        rolesConfigured,
        openclawIdOwner:
          params.authResult.method === "trusted-proxy" &&
          params.authResult.openclawId?.kind === "owner",
      })
    ) {
      try {
        const displayName = await resolveHostAccountName();
        assertCurrent();
        const profile = await ensureCanonicalGatewayOwnerProfile(displayName, options);
        // Shared-secret operators retain their existing authority, regardless of profile roles.
        return await prepareHttpProfile(
          profile.id,
          profile.updatedAt,
          assertCurrent,
          undefined,
          operatorSource,
        );
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
      config: params.cfg,
      requestHeaders: params.req.headers,
      assertCurrent,
    });
    const member =
      params.authResult.method === "trusted-proxy" &&
      params.authResult.openclawId?.kind === "member"
        ? params.authResult.openclawId
        : undefined;
    const profile = params.authResult.delegation
      ? await ensureCanonicalDelegatedUserProfile(params.authResult.delegation.identity, options)
      : member
        ? await ensureCanonicalUserProfileForOpenClawIdIdentity(
            { accountId: member.accountId },
            options,
          )
        : syncGitHubIdentity
          ? await syncGitHubIdentity()
          : params.authResult.tailscaleIdentity
            ? await ensureCanonicalUserProfileForTailscaleIdentity(
                params.authResult.tailscaleIdentity,
                options,
              )
            : await ensureCanonicalUserProfileForEmail(authenticatedUserId, options);
    const profileId = "profileId" in profile ? profile.profileId : profile.id;
    await syncTrustedProxyGitCoauthor({
      authConfig: params.cfg.gateway?.auth,
      authResult: params.authResult,
      headers: params.req.headers,
      profileId,
      assertCurrent,
    });
    const prepared = await prepareHttpProfile(
      profileId,
      profile.updatedAt,
      assertCurrent,
      usesSharedSecretGatewayMethod(params.authResult.method) && !operatorSource?.enrollment
        ? undefined
        : params.cfg,
      operatorSource,
    );
    const delegation = params.authResult.delegation;
    if (delegation) {
      const profileCurrent = prepared.hasCurrentProfileAuthority;
      return {
        ...prepared,
        hasCurrentProfileAuthority: () =>
          profileCurrent?.() !== false &&
          isGatewayDelegationCurrent(delegation, params.getRuntimeConfig?.() ?? getRuntimeConfig()),
      };
    }
    return prepared;
  } catch (error) {
    assertCurrent();
    // Attribution enriches authenticated requests; configured role/access policies
    // make durable profile resolution a prerequisite for authorization.
    if (
      operatorSource?.enrollment ||
      params.authResult.delegation ||
      rolesConfigured ||
      accessPoliciesConfigured
    ) {
      throw error;
    }
    return {};
  }
}

async function prepareHttpProfile(
  profileId: string,
  updatedAt: number | undefined,
  assertCurrent: () => void,
  cfg?: OpenClawConfig,
  device?: Pick<AdmittedHttpOperatorDevice, "enrollment" | "isCurrent"> & {
    scopeCeiling?: readonly string[];
  },
) {
  assertCurrent();
  if (cfg && hasGatewayOperatorAccessPolicies(cfg)) {
    (await prepareUserProfileCatalog()).release();
    assertCurrent();
  }
  const authority = await prepareUserProfileRoleAuthority(profileId);
  assertCurrent();
  if (!authority?.isCurrent()) {
    throw new Error("HTTP profile authority changed during acquisition");
  }
  if (device?.enrollment && !authority.aliases.includes(device.enrollment.profileId)) {
    throw new Error("Personal device enrollment conflicts with the authenticated person");
  }
  const display = authority.display;
  const revision =
    updatedAt === undefined
      ? readResidentUserProfileRevision(authority.profileId, authority.readSource().path)
      : undefined;
  const profileUpdatedAt = updatedAt ?? revision?.updated_at;
  if (profileUpdatedAt === undefined) {
    throw new Error("Personal profile metadata is unavailable");
  }
  const operatorRolePolicy = cfg
    ? resolveOperatorRolePolicyForAssignment(
        display.id,
        authority.role,
        cfg,
        authority.githubLogin ?? null,
      )
    : undefined;
  const operatorAccessAuthority = cfg
    ? resolveGatewayOperatorAccessAuthority(profileId, cfg)
    : undefined;
  assertCurrent();
  if (!authority.isCurrent()) {
    throw new Error("HTTP profile authority changed during acquisition");
  }
  return {
    ...projectHttpProfile(display, profileUpdatedAt, operatorRolePolicy, operatorAccessAuthority),
    ...(device?.scopeCeiling ? { operatorProfileScopeCeiling: device.scopeCeiling } : {}),
    ...(device?.enrollment
      ? {
          operatorProfileEnrollment: device.enrollment,
          operatorRoleActor: { kind: "operator" as const, profileId: authority.profileId },
        }
      : {}),
    // Identity-derived HTTP authority must not outlive the profile binding that admitted it.
    // Shared-secret authority remains independent of owner-profile attribution.
    ...(cfg || device
      ? { hasCurrentProfileAuthority: () => authority.isCurrent() && device?.isCurrent() !== false }
      : {}),
    ...(cfg
      ? {
          preparedSessionProfile: {
            profileId: authority.profileId,
            aliases: new Set(authority.aliases),
            role: authority.role,
            githubLogin: authority.githubLogin,
          },
        }
      : {}),
  };
}

/** Cookie and media disclosure retain their existing synchronous final policy check. */
export function resolveHttpProfile(profileId: string, cfg?: OpenClawConfig) {
  const profile = captureResidentUserProfileAccess(profileId).assertCurrent();
  const display = projectUserProfileDisplay(profile);
  const operatorRolePolicy = cfg
    ? resolveOperatorRolePolicyForAssignment(
        profile.id,
        profile.role ?? null,
        cfg,
        profile.githubLogin ?? null,
      )
    : undefined;
  const operatorAccessAuthority = cfg
    ? resolveGatewayOperatorAccessAuthority(profileId, cfg)
    : undefined;
  return projectHttpProfile(
    display,
    profile.updated_at,
    operatorRolePolicy,
    operatorAccessAuthority,
  );
}

function projectHttpProfile(
  display: ReturnType<typeof projectUserProfileDisplay>,
  updatedAt: number,
  operatorRolePolicy: GatewayOperatorRoleDefinition | undefined,
  operatorAccessAuthority: GatewayOperatorAccessAuthority | null | undefined,
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
    ...(operatorAccessAuthority !== undefined ? { operatorAccessAuthority } : {}),
  };
}

export function applyHttpOperatorRoleScopeCeiling(
  scopes: string[],
  auth:
    | Pick<AuthenticatedHttpUserProfile, "operatorRolePolicy" | "operatorProfileScopeCeiling">
    | undefined,
): string[] {
  const allowedScopes = auth?.operatorRolePolicy?.scopes;
  const permitted = allowedScopes ? intersectOperatorScopes(scopes, allowedScopes) : scopes;
  return auth?.operatorProfileScopeCeiling
    ? intersectOperatorScopes(permitted, auth.operatorProfileScopeCeiling)
    : permitted;
}

export type AuthorizedGatewayHttpRequest = AuthenticatedHttpUserProfile & {
  authMethod?: GatewayAuthResult["method"];
  user?: string;
  trustDeclaredOperatorScopes: boolean;
  deviceOperatorScopes?: string[];
  revalidate?: () => Promise<void>;
  hasCurrentClientAuthority?: () => boolean;
  controlUiPluginGrants?: ControlUiPluginTabAuthGrant[];
  controlUiPluginGrant?: ControlUiPluginTabAuthGrant;
};

export type GatewayHttpRequestAuthCheckResult =
  | {
      ok: true;
      requestAuth: AuthorizedGatewayHttpRequest & GatewayHttpRequestAuthority;
    }
  | {
      ok: false;
      authResult: GatewayAuthResult;
    };
