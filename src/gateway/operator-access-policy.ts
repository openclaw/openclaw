import {
  readGatewayOperatorAccessCause,
  type GatewayOperatorAccessCause,
} from "../../packages/gateway-protocol/src/connect-error-details.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OperatorAccessDecision } from "../infra/operator-access-decision.js";
import {
  GatewayOperatorAccessDeniedError,
  GatewayOperatorAccessUnavailableError,
} from "../infra/operator-authority-error.js";
import { redactSensitiveText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { assertBoundGatewayAccessDecision } from "../plugins/gateway-access-policy-registration.js";
import type {
  GatewayAccessGrantRef,
  PluginGatewayAccessAuthority,
  PluginGatewayAccessPolicy,
} from "../plugins/gateway-access-policy.types.js";
import { getPluginRegistryState } from "../plugins/runtime-state.js";
import { onUserProfilesChanged, readUserProfileVersion } from "../state/user-profile-events.js";
import { captureResidentUserProfileAccess } from "../state/user-profile-list.js";
import type { UserProfileAccessFacts } from "../state/user-profiles.types.js";
import type { OpenClawIdTunnelPrincipal } from "./openclaw-id/tunnel-principal.js";
import type { GatewayOperatorAccessAuthority } from "./operator-access-policy.types.js";
import { isOperatorRoleEnforcedFor, operatorRoleSubject } from "./operator-role-enforcement.js";
import { resolveOperatorRolePolicyForAssignment } from "./operator-role-policy.js";

export const GATEWAY_OPERATOR_ACCESS_DENIED_MESSAGE =
  "Gateway access is not active for this account; ask a Gateway administrator to grant or restore access.";

export { GatewayOperatorAccessDeniedError };

export { GatewayOperatorAccessUnavailableError } from "../infra/operator-authority-error.js";
const log = createSubsystemLogger("gateway/access");

function unavailablePolicy(error: unknown, pluginId?: string) {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  log.warn(
    `Access policy${pluginId ? ` ${pluginId}` : ""} evaluation failed: ${redactSensitiveText(detail, { mode: "tools" })}`,
  );
  return new GatewayOperatorAccessUnavailableError();
}

// A retained signal keeps its identity check alive without pinning abandoned HTTP captures.
// An abort listener on AbortSignal.any would itself keep the composite signal alive in Node.
const profileAccessChecks = new WeakMap<AbortSignal, () => void>();
const profileAccessCleanup = new FinalizationRegistry<() => void>((release) => release());

function watchProfileAccess(reference: WeakRef<() => void>, token: object): () => void {
  const unsubscribe = onUserProfilesChanged(() => {
    const check = reference.deref();
    if (check) {
      try {
        check();
        return;
      } catch {
        // The identity check publishes revocation before throwing.
      }
    }
    release();
  });
  function release() {
    unsubscribe();
    profileAccessCleanup.unregister(token);
  }
  return release;
}

function currentAccessPolicies() {
  const registry = getPluginRegistryState()?.activeRegistry;
  return (
    registry?.gatewayAccessPolicies?.filter((registration) =>
      registry.plugins.some(
        (plugin) =>
          plugin.id === registration.pluginId && plugin.enabled && plugin.status === "loaded",
      ),
    ) ?? []
  );
}

type GatewayOperatorAccessSource = {
  profileId?: string;
  openclawIdAccountIds?: readonly string[];
  /** Attested connection or retained source; never inferred from profile identities. */
  openclawIdPrincipal?: OpenClawIdTunnelPrincipal;
  /** Original grant fact; its owner may resume it or answer current authorization. */
  grant?: GatewayAccessGrantRef | null;
};

export function hasGatewayOperatorAccessPolicies(
  config: OpenClawConfig,
  _source: GatewayOperatorAccessSource = {},
): boolean {
  return (
    usesGitHubRoleAssignments(config, null, _source) ||
    currentAccessPolicies().length > 0 ||
    (isOperatorRoleEnforcedFor(config, operatorRoleSubject(_source)) &&
      Object.values(config.gateway?.roles?.definitions ?? {}).some(
        (role) => role.accessPolicyPlugin,
      ))
  );
}

function usesGitHubRoleAssignments(
  config: OpenClawConfig,
  assignedRole: string | null,
  _source: GatewayOperatorAccessSource = {},
): boolean {
  const roles = config.gateway?.roles;
  return Boolean(
    roles &&
    isOperatorRoleEnforcedFor(config, operatorRoleSubject(_source)) &&
    Object.keys(roles.assignments?.byGithubLogin ?? {}).length > 0 &&
    (!assignedRole || !Object.hasOwn(roles.definitions, assignedRole)),
  );
}

function resolveAccessPolicyRole(
  profileId: string,
  assignedRole: string | null,
  config: OpenClawConfig,
  githubLogin: string | null,
  _source: GatewayOperatorAccessSource,
) {
  return {
    assignedRole,
    policy: resolveOperatorRolePolicyForAssignment(
      profileId,
      assignedRole,
      config,
      githubLogin,
      operatorRoleSubject(_source),
    ),
  };
}

function pluginProfile(
  profile: Pick<UserProfileAccessFacts, "profileId" | "emails" | "githubAccountIds">,
  assignedRole: string | null,
): Parameters<PluginGatewayAccessPolicy["authorize"]>[0]["profile"] {
  return {
    profileId: profile.profileId,
    emails: [...profile.emails],
    ...(profile.githubAccountIds ? { githubAccountIds: [...profile.githubAccountIds] } : {}),
    assignedRole,
  };
}

/** Bind additional access to this exact authenticated person and the original policy lifetimes. */
export function resolveGatewayOperatorAccessAuthority(
  profileId: string,
  config: OpenClawConfig,
  inputOptions: GatewayOperatorAccessSource & { requireLivePolicySet?: boolean } = {},
): GatewayOperatorAccessAuthority | null {
  if (profileId === GATEWAY_OWNER_PROFILE_ID) {
    return null;
  }
  if (
    !inputOptions.requireLivePolicySet &&
    !config.gateway?.openclawId?.enabled &&
    !hasGatewayOperatorAccessPolicies(config, inputOptions)
  ) {
    return null;
  }
  const resident = captureResidentUserProfileAccess(profileId);
  const profile = resident.readCurrentFacts();
  const options = {
    ...inputOptions,
    profileId: profile.profileId,
    openclawIdAccountIds: profile.openclawIdAccountIds,
  };
  const emails = [...profile.emails];
  const githubAccountIds = [...(profile.githubAccountIds ?? [])];
  const usesGithubAssignments = usesGitHubRoleAssignments(config, profile.assignedRole, options);
  let profileVersion = readUserProfileVersion();
  return resolvePreparedGatewayOperatorAccessAuthority(
    {
      profileId: profile.profileId,
      openclawIdAccountIds: profile.openclawIdAccountIds,
      emails,
      githubAccountIds,
      role: profile.assignedRole,
      githubLogin: profile.githubLogin ?? null,
      isCurrent: () => {
        resident.assertCurrent();
        if (profile.profileId !== profileId) {
          return false;
        }
        const currentVersion = readUserProfileVersion();
        if (currentVersion !== profileVersion) {
          const current = resident.readCurrentFacts();
          const currentEmails = new Set(current.emails);
          // A merge or alias replacement cannot transfer a captured grant to its successor.
          // Display/avatar changes preserve admitted work.
          if (
            current.profileId !== profileId ||
            (usesGithubAssignments && current.githubLogin !== profile.githubLogin) ||
            emails.some((email) => !currentEmails.has(email)) ||
            githubAccountIds.some((accountId) => !current.githubAccountIds?.includes(accountId)) ||
            (profile.openclawIdAccountIds ?? []).some(
              (accountId) => !current.openclawIdAccountIds?.includes(accountId),
            )
          ) {
            return false;
          }
          profileVersion = currentVersion;
        }
        return true;
      },
    },
    config,
    options,
  );
}

/** Worker-prepared person facts retain their owner's memory-only identity lifetime. */
export function resolvePreparedGatewayOperatorAccessAuthority(
  profile: Readonly<{
    profileId: string;
    emails: readonly string[];
    openclawIdAccountIds?: readonly string[];
    githubAccountIds?: readonly number[];
    githubLogin?: string | null;
    role: string | null;
    isCurrent: () => boolean;
  }>,
  config: OpenClawConfig,
  inputOptions: GatewayOperatorAccessSource & { requireLivePolicySet?: boolean } = {},
): GatewayOperatorAccessAuthority | null {
  if (profile.profileId === GATEWAY_OWNER_PROFILE_ID) {
    return null;
  }
  const options = {
    ...inputOptions,
    profileId: profile.profileId,
    openclawIdAccountIds: profile.openclawIdAccountIds,
  };
  const policies = currentAccessPolicies();
  if (options.grant && !policies.some(({ pluginId }) => pluginId === options.grant?.pluginId)) {
    throw new GatewayOperatorAccessUnavailableError();
  }
  if (
    !options.requireLivePolicySet &&
    policies.length === 0 &&
    !hasGatewayOperatorAccessPolicies(config, options)
  ) {
    return null;
  }
  const role = resolveAccessPolicyRole(
    profile.profileId,
    profile.role,
    config,
    profile.githubLogin ?? null,
    options,
  );
  const requiredPlugin = role.policy?.accessPolicyPlugin;
  if (requiredPlugin && !policies.some((entry) => entry.pluginId === requiredPlugin)) {
    throw new GatewayOperatorAccessDeniedError("policy-unavailable");
  }
  const invalidated = new AbortController();
  let signal = invalidated.signal;
  let denial: GatewayOperatorAccessDeniedError | undefined;
  let authorities: {
    pluginId: string;
    authority: PluginGatewayAccessAuthority;
    decision?: OperatorAccessDecision;
    assertCurrent: () => void;
  }[] = [];
  const sourceFailure = () => {
    const source = authorities.find(({ authority }) => authority.signal.aborted);
    return source
      ? (readGatewayOperatorAccessCause(source.authority.failureCause) ?? "grant-revoked")
      : undefined;
  };
  const invalidate = (cause: GatewayOperatorAccessCause) => {
    // A later invitation, alias restoration, or profile repair cannot revive this capture.
    denial ??= new GatewayOperatorAccessDeniedError(sourceFailure() ?? cause);
    invalidated.abort(denial);
    return denial;
  };
  const assertProfileCurrent = () => {
    if (signal.aborted) {
      throw invalidate(sourceFailure() ?? "policy-check-failed");
    }
    try {
      if (!profile.isCurrent()) {
        throw invalidate("profile-invalidated");
      }
    } catch {
      throw invalidate("profile-invalidated");
    }
  };
  // Observe before plugin callbacks: an alias can move away and back during authorization.
  // The separately scoped listener and finalizer hold no strong reference to this capture.
  const token = {};
  const releaseProfiles = watchProfileAccess(new WeakRef(assertProfileCurrent), token);
  profileAccessCleanup.register(assertProfileCurrent, releaseProfiles, token);
  try {
    assertProfileCurrent();
    let requiredPolicyConfirmed = !requiredPlugin;
    authorities = policies.flatMap(({ policy, pluginId }) => {
      const input = {
        config,
        profile: pluginProfile(profile, role.assignedRole),
        requiredByRole: pluginId === requiredPlugin,
      };
      let authority: PluginGatewayAccessAuthority | undefined;
      if (options.grant && pluginId === options.grant.pluginId) {
        // Without resume, the owner's current authorization may legitimately name a new grant.
        authority = policy.resume
          ? policy.resume({ ...input, grantId: options.grant.grantId })
          : policy.authorize(input);
        if (policy.resume && (!authority || authority.grantId !== options.grant.grantId)) {
          throw new GatewayOperatorAccessDeniedError("grant-revoked");
        }
      } else {
        authority = policy.authorize(input);
      }
      if (authority && pluginId === requiredPlugin) {
        requiredPolicyConfirmed = true;
      }
      return authority
        ? [
            {
              pluginId,
              authority,
              assertCurrent: () => authority.assertCurrent(),
              // A durable grant denotes one uninterrupted source. Unclassified captures
              // cannot share a decision; person/config/policy inputs remain independent.
              decision: authority.grantId
                ? {
                    policy,
                    config,
                    subject: JSON.stringify([
                      profile.profileId,
                      profile.role,
                      profile.emails,
                      profile.githubAccountIds,
                      pluginId === requiredPlugin,
                      authority.grantId,
                    ]),
                  }
                : undefined,
            },
          ]
        : [];
    });
    if (!requiredPolicyConfirmed) {
      throw new GatewayOperatorAccessDeniedError("access-record-inactive");
    }
    if (
      !options.requireLivePolicySet &&
      authorities.length === 0 &&
      !usesGitHubRoleAssignments(config, profile.role, options)
    ) {
      releaseProfiles();
      return null;
    }
    signal = AbortSignal.any([
      invalidated.signal,
      ...authorities.map(({ authority }) => authority.signal),
    ]);
    const assertCurrent = () => {
      try {
        assertProfileCurrent();
        if (options.requireLivePolicySet) {
          const current = currentAccessPolicies();
          if (
            current.length !== policies.length ||
            current.some((entry, index) => entry !== policies[index])
          ) {
            throw invalidate("policy-set-changed");
          }
        }
        for (const {
          authority,
          pluginId,
          decision,
          assertCurrent: assertAuthorityCurrent,
        } of authorities) {
          try {
            assertBoundGatewayAccessDecision(authority, decision, assertAuthorityCurrent);
          } catch (error) {
            if (error instanceof GatewayOperatorAccessDeniedError) {
              throw invalidate(error.accessCause);
            }
            const cause = readGatewayOperatorAccessCause(authority.failureCause);
            if (
              authority.signal.aborted ||
              (cause && cause !== "policy-check-failed" && cause !== "policy-unavailable")
            ) {
              throw invalidate(cause ?? "grant-revoked");
            }
            const unavailable = unavailablePolicy(error, pluginId);
            // An exception is not a policy decision. Recompute the original grant before
            // invalidating it; a healthy replacement never authorizes the failed operation.
            const policy = policies.find((entry) => entry.pluginId === pluginId)!.policy;
            let current: PluginGatewayAccessAuthority | undefined;
            let evaluated = false;
            try {
              const input = {
                config,
                profile: pluginProfile(profile, role.assignedRole),
                requiredByRole: pluginId === requiredPlugin,
              };
              current =
                authority.grantId && policy.resume
                  ? policy.resume({ ...input, grantId: authority.grantId })
                  : policy.authorize(input);
              evaluated = true;
            } catch {
              // A second unavailable evaluation still says nothing about the grant.
            }
            assertProfileCurrent();
            if (
              evaluated &&
              (!current || current.signal.aborted || current.grantId !== authority.grantId)
            ) {
              throw invalidate("grant-revoked");
            }
            throw unavailable;
          }
        }
      } catch (error) {
        if (error instanceof GatewayOperatorAccessUnavailableError) {
          throw error;
        }
        releaseProfiles();
        throw invalidate("policy-check-failed");
      }
    };
    // Retaining only the composed signal must also retain its policy sources.
    profileAccessChecks.set(signal, assertCurrent);
    assertCurrent();
    const original = authorities.length === 1 ? authorities[0] : undefined;
    return {
      assertCurrent,
      signal,
      get failureCause() {
        const cause = sourceFailure();
        if (cause) {
          denial ??= new GatewayOperatorAccessDeniedError(cause);
        }
        return denial?.accessCause;
      },
      requiredPolicyPlugin: requiredPlugin,
      gatewayAccessGrant: original?.authority.grantId
        ? Object.freeze({ pluginId: original.pluginId, grantId: original.authority.grantId })
        : authorities.length === 0
          ? null
          : undefined,
    };
  } catch (error) {
    releaseProfiles();
    if (error instanceof GatewayOperatorAccessUnavailableError) {
      throw error;
    }
    // Policy errors can contain private configuration; only a closed cause crosses ingress.
    throw error instanceof GatewayOperatorAccessDeniedError
      ? invalidate(error.accessCause)
      : unavailablePolicy(error);
  }
}

export function hasCurrentGatewayOperatorAccess(
  authority: PluginGatewayAccessAuthority | null | undefined,
): boolean {
  try {
    authority?.signal.throwIfAborted();
    authority?.assertCurrent();
    return true;
  } catch (error) {
    if (error instanceof GatewayOperatorAccessUnavailableError) {
      throw error;
    }
    return false;
  }
}
