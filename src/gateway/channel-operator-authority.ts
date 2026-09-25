import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import {
  parseUserChannelAuthorizationReference,
  resolveUserChannelAuthorizationPolicy,
  resolveUserChannelIdentity,
  type UserChannelAuthorization,
  type UserChannelAuthorizationReference,
} from "../state/user-channel-identities.js";
import {
  authorizeCanonicalUserChannelIdentity,
  prepareUserChannelIdentityAuthority,
} from "../state/user-channel-identity-operations.js";
import type {
  UserChannelIdentity,
  UserChannelIdentityAuthorityFacts,
} from "../state/user-profiles.types.js";
import {
  GatewayOperatorAccessDeniedError,
  hasCurrentGatewayOperatorAccess,
  resolvePreparedGatewayOperatorAccessAuthority,
  resumeGatewayOperatorAccessGrant,
} from "./operator-access-policy.js";
import { resolveIdentityOperatorScopes } from "./operator-identity-scopes.js";
import { resolveOperatorRolePolicyForAssignment } from "./operator-role-policy.js";

/** One-shot CLI owners retain the grant while checking their original installation's state. */
export function resolveChannelOperatorAdminAuthority(
  cfg: OpenClawConfig,
  identity: UserChannelIdentity,
  stateOptions: OpenClawStateDatabaseOptions = {},
) {
  const prepared = resolveChannelOperatorIdentityFacts(cfg, identity, stateOptions);
  return (
    prepared && captureLinkedOperatorAdmin(cfg, prepared.linked, prepared.isCurrent)?.authority
  );
}

/** The update owner must prove accepted native custody before using identity-only checks. */
export function resolveUpdateChannelOperatorAdminIdentityAuthority(
  cfg: OpenClawConfig,
  identity: UserChannelIdentity,
  stateOptions: OpenClawStateDatabaseOptions = {},
) {
  const prepared = resolveChannelOperatorIdentityFacts(cfg, identity, stateOptions);
  return prepared && captureLinkedOperatorAdminIdentity(cfg, prepared.linked, prepared.isCurrent);
}

function resolveChannelOperatorIdentityFacts(
  cfg: OpenClawConfig,
  identity: UserChannelIdentity,
  stateOptions: OpenClawStateDatabaseOptions,
) {
  if (!cfg.gateway?.roles && !cfg.gateway?.auth?.identityScopes) {
    return undefined;
  }
  const capturedIdentity = { ...identity };
  const linked = resolveUserChannelIdentity(capturedIdentity, stateOptions);
  if (!linked) {
    return undefined;
  }
  return {
    linked,
    isCurrent: () => {
      const current = resolveUserChannelIdentity(capturedIdentity, stateOptions);
      return (
        current !== undefined &&
        current.profileId === linked.profileId &&
        current.role === linked.role &&
        linked.emails.every((email) => current.emails.includes(email)) &&
        linked.loginIdentities.every((login) => current.loginIdentities.includes(login))
      );
    },
  };
}

function resolveLinkedOperatorAdmin(
  cfg: OpenClawConfig,
  linked: UserChannelIdentityAuthorityFacts,
): string | undefined {
  const policy = resolveOperatorRolePolicyForAssignment(linked.profileId, linked.role, cfg);
  const authorized = policy
    ? policy.scopes.includes("operator.admin")
    : linked.loginIdentities.some((login) =>
        resolveIdentityOperatorScopes(login, cfg.gateway?.auth?.identityScopes).includes(
          "operator.admin",
        ),
      );
  return authorized ? linked.profileId : undefined;
}

function captureLinkedOperatorAdminIdentity(
  cfg: OpenClawConfig,
  linked: UserChannelIdentityAuthorityFacts,
  isIdentityCurrent: () => boolean,
) {
  if (!resolveLinkedOperatorAdmin(cfg, linked)) {
    return undefined;
  }
  const requiredPlugin = resolveOperatorRolePolicyForAssignment(
    linked.profileId,
    linked.role,
    cfg,
  )?.accessPolicyPlugin;
  let current = true;
  const isCurrent = (currentCfg: OpenClawConfig) => {
    current &&=
      isIdentityCurrent() &&
      resolveLinkedOperatorAdmin(currentCfg, linked) === linked.profileId &&
      resolveOperatorRolePolicyForAssignment(linked.profileId, linked.role, currentCfg)
        ?.accessPolicyPlugin === requiredPlugin;
    return current;
  };
  return isCurrent(cfg) ? { profileId: linked.profileId, isCurrent } : undefined;
}

function captureLinkedOperatorAdmin(
  cfg: OpenClawConfig,
  linked: UserChannelIdentityAuthorityFacts,
  isIdentityCurrent: () => boolean,
  original?: UserChannelAuthorization,
) {
  const identity = captureLinkedOperatorAdminIdentity(cfg, linked, isIdentityCurrent);
  if (!identity) {
    return undefined;
  }
  try {
    const access = original
      ? null
      : resolvePreparedGatewayOperatorAccessAuthority(
          { ...linked, isCurrent: isIdentityCurrent },
          cfg,
        );
    let current = true;
    const isCurrent = (currentCfg: OpenClawConfig) => {
      current &&= identity.isCurrent(currentCfg) && hasCurrentGatewayOperatorAccess(access);
      if (current && original) {
        resumeGatewayOperatorAccessGrant(
          { profileId: linked.profileId, emails: linked.emails, assignedRole: linked.role },
          currentCfg,
          original.grant,
        );
        current &&= isIdentityCurrent();
      }
      return current;
    };
    return isCurrent(cfg)
      ? {
          authority: {
            profileId: linked.profileId,
            isCurrent,
            ...(access ? { signal: access.signal } : {}),
          },
          grant: access === null ? null : access.gatewayAccessGrant,
        }
      : undefined;
  } catch (error) {
    if (error instanceof GatewayOperatorAccessDeniedError) {
      return undefined;
    }
    throw error;
  }
}

export async function prepareChannelOperatorAdmin(
  cfg: OpenClawConfig,
  identity: UserChannelIdentity | UserChannelAuthorizationReference,
  stateOptions: OpenClawStateDatabaseOptions = {},
) {
  if (!cfg.gateway?.roles && !cfg.gateway?.auth?.identityScopes) {
    return undefined;
  }
  const policy = resolveUserChannelAuthorizationPolicy(cfg.gateway);
  const reference =
    "version" in identity ? parseUserChannelAuthorizationReference(identity) : undefined;
  if ("version" in identity && !reference) {
    return undefined;
  }
  const prepared = await prepareUserChannelIdentityAuthority(
    "version" in identity ? { authorizationId: identity.id, policy } : identity,
    stateOptions,
  );
  if (!prepared) {
    return undefined;
  }
  const captured = captureLinkedOperatorAdmin(
    cfg,
    prepared.linked,
    prepared.isCurrent,
    prepared.linked.authorization,
  );
  if (!captured) {
    return undefined;
  }
  const original = prepared.linked.authorization;
  const assertCurrent = () => {
    if (!captured.authority.isCurrent(cfg)) {
      throw new GatewayOperatorAccessDeniedError();
    }
  };
  const recoveryReference =
    original?.reference ??
    (!("version" in identity) && captured.grant !== undefined
      ? await authorizeCanonicalUserChannelIdentity(
          {
            action: "authorize",
            identity,
            profileId: prepared.linked.profileId,
            policy,
            grant: captured.grant,
          },
          { ...stateOptions, assertCurrent },
        )
      : undefined);
  assertCurrent();
  return { ...captured.authority, recoveryReference };
}
