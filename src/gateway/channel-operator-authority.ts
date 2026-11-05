import type { OpenClawConfig } from "../config/types.openclaw.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { parseUserChannelAuthorizationReference } from "../state/user-channel-authorization-reference.js";
import {
  resolveUserChannelAuthorizationPolicy,
  resolveUserChannelIdentity,
} from "../state/user-channel-identities.js";
import {
  authorizeCanonicalUserChannelIdentity,
  prepareUserChannelIdentityAuthority,
} from "../state/user-channel-identity-operations.js";
import type {
  UserChannelAuthorization,
  UserChannelAuthorizationReference,
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
import {
  resolveOperatorRolePolicyForAssignment,
  resolveOperatorRoleSelection,
} from "./operator-role-policy.js";

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
    isCurrent: (currentCfg = cfg) => {
      const current = resolveUserChannelIdentity(capturedIdentity, stateOptions);
      const usesGithubAssignment =
        Object.keys(currentCfg.gateway?.roles?.assignments?.byGithubLogin ?? {}).length > 0 &&
        resolveOperatorRoleSelection(
          linked.profileId,
          linked.role,
          currentCfg,
          linked.githubLogin ?? null,
        ).roleSource !== "assigned";
      return (
        current !== undefined &&
        current.profileId === linked.profileId &&
        current.role === linked.role &&
        (!usesGithubAssignment || current.githubLogin === linked.githubLogin) &&
        linked.emails.every((email) => current.emails.includes(email)) &&
        linked.loginIdentities.every((login) => current.loginIdentities.includes(login))
      );
    },
  };
}

function resolveLinkedOperatorScopes(
  cfg: OpenClawConfig,
  linked: UserChannelIdentityAuthorityFacts,
) {
  return (
    resolveOperatorRolePolicyForAssignment(
      linked.profileId,
      linked.role,
      cfg,
      linked.githubLogin ?? null,
    )?.scopes ?? [
      ...new Set(
        linked.loginIdentities.flatMap((login) =>
          resolveIdentityOperatorScopes(login, cfg.gateway?.auth?.identityScopes),
        ),
      ),
    ]
  );
}

function captureLinkedOperatorAdminIdentity(
  cfg: OpenClawConfig,
  linked: UserChannelIdentityAuthorityFacts,
  isIdentityCurrent: (cfg?: OpenClawConfig) => boolean,
  requireAdmin = true,
) {
  const scopes = resolveLinkedOperatorScopes(cfg, linked);
  if (!scopes.length || (requireAdmin && !scopes.includes("operator.admin"))) {
    return undefined;
  }
  const requiredPlugin = resolveOperatorRolePolicyForAssignment(
    linked.profileId,
    linked.role,
    cfg,
    linked.githubLogin ?? null,
  )?.accessPolicyPlugin;
  let current = true;
  const isCurrent = (currentCfg: OpenClawConfig) => {
    current &&=
      isIdentityCurrent(currentCfg) &&
      roleScopesAllow({
        role: "operator",
        requestedScopes: scopes,
        allowedScopes: resolveLinkedOperatorScopes(currentCfg, linked),
      }) &&
      resolveOperatorRolePolicyForAssignment(
        linked.profileId,
        linked.role,
        currentCfg,
        linked.githubLogin ?? null,
      )?.accessPolicyPlugin === requiredPlugin;
    return current;
  };
  return isCurrent(cfg) ? { profileId: linked.profileId, isCurrent } : undefined;
}

function captureLinkedOperatorAdmin(
  cfg: OpenClawConfig,
  linked: UserChannelIdentityAuthorityFacts,
  isIdentityCurrent: (cfg?: OpenClawConfig) => boolean,
  original?: UserChannelAuthorization,
  requireAdmin = true,
) {
  const identity = captureLinkedOperatorAdminIdentity(cfg, linked, isIdentityCurrent, requireAdmin);
  if (!identity) {
    return undefined;
  }
  try {
    const access = original
      ? null
      : resolvePreparedGatewayOperatorAccessAuthority(
          {
            ...linked,
            githubLogin: linked.githubLogin ?? null,
            isCurrent: () => isIdentityCurrent(cfg),
          },
          cfg,
        );
    let current = true;
    const isCurrent = (currentCfg: OpenClawConfig) => {
      current &&= identity.isCurrent(currentCfg) && hasCurrentGatewayOperatorAccess(access);
      if (current && original) {
        resumeGatewayOperatorAccessGrant(
          {
            profileId: linked.profileId,
            emails: linked.emails,
            githubAccountIds: linked.githubAccountIds,
            assignedRole: linked.role,
            githubLogin: linked.githubLogin ?? null,
          },
          currentCfg,
          original.grant,
        );
        current &&= isIdentityCurrent(currentCfg);
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

export type ResolvedChannelOperatorIdentity = {
  identity: UserChannelIdentity;
  prepared: Awaited<ReturnType<typeof prepareUserChannelIdentityAuthority>>;
};

async function prepareChannelOperatorIdentity(
  cfg: OpenClawConfig,
  input: UserChannelIdentity | UserChannelAuthorizationReference | ResolvedChannelOperatorIdentity,
  stateOptions: OpenClawStateDatabaseOptions,
  requireAdmin: boolean,
) {
  if (!cfg.gateway?.roles && !cfg.gateway?.auth?.identityScopes) {
    return undefined;
  }
  const identity = "identity" in input ? input.identity : input;
  const policy = resolveUserChannelAuthorizationPolicy(cfg.gateway);
  const reference =
    "version" in identity ? parseUserChannelAuthorizationReference(identity) : undefined;
  if ("version" in identity && !reference) {
    return undefined;
  }
  // An admitted ingress carries even an absent result; never reread an unlinked sender.
  const prepared =
    "identity" in input
      ? input.prepared
      : await prepareUserChannelIdentityAuthority(
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
    requireAdmin,
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
  return {
    ...captured.authority,
    recoveryReference,
    operatorProfile: {
      profileId: prepared.linked.profileId,
      assignedRole: prepared.linked.role,
      githubLogin: prepared.linked.githubLogin ?? null,
      scopes: resolveLinkedOperatorScopes(cfg, prepared.linked),
      gatewayAccessGrant: captured.grant,
    },
  };
}

/** Personal operator scope is independent from command-owner/admin status. */
export function prepareChannelOperatorAuthority(
  cfg: OpenClawConfig,
  input: UserChannelIdentity | UserChannelAuthorizationReference | ResolvedChannelOperatorIdentity,
  stateOptions: OpenClawStateDatabaseOptions = {},
) {
  return prepareChannelOperatorIdentity(cfg, input, stateOptions, false);
}

export function prepareChannelOperatorAdmin(
  cfg: OpenClawConfig,
  input: UserChannelIdentity | UserChannelAuthorizationReference | ResolvedChannelOperatorIdentity,
  stateOptions: OpenClawStateDatabaseOptions = {},
) {
  return prepareChannelOperatorIdentity(cfg, input, stateOptions, true);
}
