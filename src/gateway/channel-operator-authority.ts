import type { OpenClawConfig } from "../config/types.openclaw.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
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
  return prepared && captureLinkedOperator(cfg, prepared.linked, prepared.isCurrent, true);
}

/** The update owner must prove accepted native custody before using identity-only checks. */
export function resolveUpdateChannelOperatorAdminIdentityAuthority(
  cfg: OpenClawConfig,
  identity: UserChannelIdentity,
  stateOptions: OpenClawStateDatabaseOptions = {},
) {
  const prepared = resolveChannelOperatorIdentityFacts(cfg, identity, stateOptions);
  return prepared && captureLinkedOperatorIdentity(cfg, prepared.linked, prepared.isCurrent, true);
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

function resolveLinkedOperatorScopes(
  cfg: OpenClawConfig,
  linked: UserChannelIdentityAuthorityFacts,
): readonly string[] {
  const policy = resolveOperatorRolePolicyForAssignment(linked.profileId, linked.role, cfg);
  return (
    policy?.scopes ?? [
      ...new Set(
        linked.loginIdentities.flatMap((login) =>
          resolveIdentityOperatorScopes(login, cfg.gateway?.auth?.identityScopes),
        ),
      ),
    ]
  );
}

function captureLinkedOperatorIdentity(
  cfg: OpenClawConfig,
  linked: UserChannelIdentityAuthorityFacts,
  isIdentityCurrent: () => boolean,
  adminOnly = false,
) {
  const scopes = Object.freeze([...resolveLinkedOperatorScopes(cfg, linked)]);
  if (adminOnly && !scopes.includes("operator.admin")) {
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
      roleScopesAllow({
        role: "operator",
        requestedScopes: scopes,
        allowedScopes: resolveLinkedOperatorScopes(currentCfg, linked),
      }) &&
      resolveOperatorRolePolicyForAssignment(linked.profileId, linked.role, currentCfg)
        ?.accessPolicyPlugin === requiredPlugin;
    return current;
  };
  return isCurrent(cfg)
    ? { profileId: linked.profileId, role: linked.role, scopes, isCurrent }
    : undefined;
}

function captureLinkedOperator(
  cfg: OpenClawConfig,
  linked: UserChannelIdentityAuthorityFacts,
  isIdentityCurrent: () => boolean,
  adminOnly = false,
) {
  const identity = captureLinkedOperatorIdentity(cfg, linked, isIdentityCurrent, adminOnly);
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
      ? { ...identity, access, isCurrent, ...(access ? { signal: access.signal } : {}) }
      : undefined;
  } catch (error) {
    if (adminOnly && error instanceof GatewayOperatorAccessDeniedError) {
      return undefined;
    }
    throw error;
  }
}

export async function prepareChannelOperatorAuthority(
  cfg: OpenClawConfig,
  identity: UserChannelIdentity,
  stateOptions: OpenClawStateDatabaseOptions = {},
) {
  if (!cfg.gateway?.roles && !cfg.gateway?.auth?.identityScopes) {
    return undefined;
  }
  const prepared = await prepareUserChannelIdentityAuthority(identity, stateOptions);
  return prepared && captureLinkedOperator(cfg, prepared.linked, prepared.isCurrent);
}
