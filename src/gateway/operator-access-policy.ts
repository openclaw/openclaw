import {
  gatewayOperatorAccessError,
  readGatewayOperatorAccessCause,
  type GatewayOperatorAccessCause,
} from "../../packages/gateway-protocol/src/connect-error-details.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OperatorAccessDecision } from "../infra/operator-access-decision.js";
import { GatewayOperatorAccessUnavailableError } from "../infra/operator-authority-error.js";
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
import {
  openclawIdTunnelRolePolicy,
  type OpenClawIdTunnelPrincipal,
} from "./openclaw-id/tunnel-principal.js";
import type { GatewayOperatorAccessAuthority } from "./operator-access-policy.types.js";
import { isNamedOperatorRoleEnforcementEnabled } from "./operator-role-enforcement.js";
import { resolveOperatorRolePolicyForAssignment } from "./operator-role-policy.js";

export const GATEWAY_OPERATOR_ACCESS_DENIED_MESSAGE =
  "Gateway access is not active for this account; ask a Gateway administrator to grant or restore access.";

export class GatewayOperatorAccessDeniedError extends Error {
  constructor(readonly accessCause: GatewayOperatorAccessCause = "policy-check-failed") {
    super(gatewayOperatorAccessError(accessCause).message);
    this.name = "GatewayOperatorAccessDeniedError";
  }
}

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
  /** Attested connection or retained source; never inferred from profile identities. */
  openclawIdPrincipal?: OpenClawIdTunnelPrincipal;
};

export function hasGatewayOperatorAccessPolicies(
  config: OpenClawConfig,
  source: GatewayOperatorAccessSource = {},
): boolean {
  if (source.openclawIdPrincipal?.kind === "member") {
    return (
      Boolean(openclawIdTunnelRolePolicy(source.openclawIdPrincipal)?.accessPolicyPlugin) ||
      currentAccessPolicies().length > 0
    );
  }
  return (
    usesGitHubRoleAssignments(config, null) ||
    currentAccessPolicies().length > 0 ||
    (isNamedOperatorRoleEnforcementEnabled(config) &&
      Object.values(config.gateway?.roles?.definitions ?? {}).some(
        (role) => role.accessPolicyPlugin,
      ))
  );
}

function usesGitHubRoleAssignments(
  config: OpenClawConfig,
  assignedRole: string | null,
  source: GatewayOperatorAccessSource = {},
): boolean {
  const roles = config.gateway?.roles;
  return Boolean(
    roles &&
    source.openclawIdPrincipal?.kind !== "member" &&
    isNamedOperatorRoleEnforcementEnabled(config) &&
    Object.keys(roles.assignments?.byGithubLogin ?? {}).length > 0 &&
    (!assignedRole || !Object.hasOwn(roles.definitions, assignedRole)),
  );
}

function resolveAccessPolicyRole(
  profileId: string,
  assignedRole: string | null,
  config: OpenClawConfig,
  githubLogin: string | null,
  source: GatewayOperatorAccessSource,
) {
  const principal = source.openclawIdPrincipal;
  return principal?.kind === "member"
    ? { assignedRole: principal.role, policy: openclawIdTunnelRolePolicy(principal) }
    : {
        assignedRole,
        policy: resolveOperatorRolePolicyForAssignment(
          profileId,
          assignedRole,
          config,
          githubLogin,
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
  options: GatewayOperatorAccessSource & { requireLivePolicySet?: boolean } = {},
): GatewayOperatorAccessAuthority | null {
  if (profileId === GATEWAY_OWNER_PROFILE_ID) {
    return null;
  }
  if (!options.requireLivePolicySet && !hasGatewayOperatorAccessPolicies(config, options)) {
    return null;
  }
  const resident = captureResidentUserProfileAccess(profileId);
  const profile = resident.readCurrentFacts();
  const emails = [...profile.emails];
  const githubAccountIds = [...(profile.githubAccountIds ?? [])];
  const usesGithubAssignments = usesGitHubRoleAssignments(config, profile.assignedRole, options);
  let profileVersion = readUserProfileVersion();
  return resolvePreparedGatewayOperatorAccessAuthority(
    {
      profileId: profile.profileId,
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
            githubAccountIds.some((accountId) => !current.githubAccountIds?.includes(accountId))
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
    githubAccountIds?: readonly number[];
    githubLogin?: string | null;
    role: string | null;
    isCurrent: () => boolean;
  }>,
  config: OpenClawConfig,
  options: GatewayOperatorAccessSource & { requireLivePolicySet?: boolean } = {},
): GatewayOperatorAccessAuthority | null {
  if (profile.profileId === GATEWAY_OWNER_PROFILE_ID) {
    return null;
  }
  const policies = currentAccessPolicies();
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
      const authority = policy.authorize({
        config,
        profile: pluginProfile(profile, role.assignedRole),
        requiredByRole: pluginId === requiredPlugin,
      });
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

/**
 * Recheck current facts, returning the original grant's live authority for retained work.
 * `options.openclawIdPrincipal` is the run's OpenClaw ID principal. A linked owner device
 * was admitted as the owner, outside its person's access policies, and resumes the same way;
 * the caller checks that its principal is current.
 */
export function resumeGatewayOperatorAccessGrant(
  profile: UserProfileAccessFacts,
  config: OpenClawConfig,
  grant: GatewayAccessGrantRef | null,
  options: GatewayOperatorAccessSource & { retained?: PluginGatewayAccessAuthority } = {},
): PluginGatewayAccessAuthority | undefined {
  if (options.openclawIdPrincipal?.kind === "owner" && grant === null) {
    return undefined;
  }
  const policies = currentAccessPolicies();
  const role = resolveAccessPolicyRole(
    profile.profileId,
    profile.assignedRole,
    config,
    profile.githubLogin ?? null,
    options,
  );
  const requiredPlugin = role.policy?.accessPolicyPlugin;
  if (requiredPlugin && requiredPlugin !== grant?.pluginId) {
    // A newly required policy cannot replace the original request's recorded basis.
    throw new GatewayOperatorAccessDeniedError("policy-set-changed");
  }
  let policyProfile: ReturnType<typeof pluginProfile> | undefined;
  let resumed: PluginGatewayAccessAuthority | undefined;
  if (grant) {
    const policy = policies.find(({ pluginId }) => pluginId === grant.pluginId)?.policy;
    if (!policy?.resume) {
      throw new GatewayOperatorAccessUnavailableError();
    }
    let authority: PluginGatewayAccessAuthority | undefined;
    try {
      // The admitted authority owns live grant checks; resuming again creates a second owner.
      authority =
        options.retained ??
        policy.resume({
          config,
          profile: (policyProfile ??= pluginProfile(profile, role.assignedRole)),
          grantId: grant.grantId,
          requiredByRole: requiredPlugin === grant.pluginId,
        });
    } catch {
      // Startup and unavailable observations are not evidence that a grant ended.
      throw new GatewayOperatorAccessUnavailableError();
    }
    if (!authority || authority.grantId !== grant.grantId) {
      throw new GatewayOperatorAccessDeniedError("grant-revoked");
    }
    resumed = authority;
  }
  for (const { pluginId, policy } of policies) {
    if (pluginId === grant?.pluginId) {
      continue;
    }
    let authority: PluginGatewayAccessAuthority | undefined;
    try {
      authority = policy.authorize({
        config,
        profile: (policyProfile ??= pluginProfile(profile, role.assignedRole)),
        requiredByRole: requiredPlugin === pluginId,
      });
    } catch {
      throw new GatewayOperatorAccessUnavailableError();
    }
    if (authority) {
      // A newly applicable policy needs a fresh request bound to that dependency.
      throw new GatewayOperatorAccessDeniedError("policy-set-changed");
    }
  }
  if (resumed?.signal.aborted) {
    throw new GatewayOperatorAccessDeniedError("grant-revoked");
  }
  try {
    resumed?.assertCurrent();
  } catch (error) {
    if (resumed?.signal.aborted || error instanceof GatewayOperatorAccessDeniedError) {
      throw new GatewayOperatorAccessDeniedError("grant-revoked");
    }
    // Re-evaluate a failed retained assertion once; an unavailable check cannot end its grant.
    if (options.retained) {
      resumeGatewayOperatorAccessGrant(profile, config, grant, { ...options, retained: undefined });
    }
    throw new GatewayOperatorAccessUnavailableError();
  }
  return resumed;
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
