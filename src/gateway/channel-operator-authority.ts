import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { resolveUserChannelIdentity } from "../state/user-channel-identities.js";
import { prepareUserChannelIdentityAuthority } from "../state/user-channel-identity-operations.js";
import type {
  UserChannelIdentity,
  UserChannelIdentityAuthorityFacts,
} from "../state/user-profiles.types.js";
import {
  GatewayOperatorAccessDeniedError,
  hasCurrentGatewayOperatorAccess,
  resolvePreparedGatewayOperatorAccessAuthority,
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
  return prepared && captureLinkedOperatorAdmin(cfg, prepared.linked, prepared.isCurrent);
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
) {
  const identity = captureLinkedOperatorAdminIdentity(cfg, linked, isIdentityCurrent);
  if (!identity) {
    return undefined;
  }
  try {
    const access = resolvePreparedGatewayOperatorAccessAuthority(
      { ...linked, isCurrent: isIdentityCurrent },
      cfg,
    );
    let current = true;
    const isCurrent = (currentCfg: OpenClawConfig) => {
      current &&= identity.isCurrent(currentCfg) && hasCurrentGatewayOperatorAccess(access);
      return current;
    };
    return isCurrent(cfg)
      ? { profileId: linked.profileId, isCurrent, ...(access ? { signal: access.signal } : {}) }
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
  identity: UserChannelIdentity,
  stateOptions: OpenClawStateDatabaseOptions = {},
) {
  if (!cfg.gateway?.roles && !cfg.gateway?.auth?.identityScopes) {
    return undefined;
  }
  const prepared = await prepareUserChannelIdentityAuthority(identity, stateOptions);
  return prepared && captureLinkedOperatorAdmin(cfg, prepared.linked, prepared.isCurrent);
}
