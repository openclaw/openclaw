import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginGatewayAccessAuthority } from "../plugins/gateway-access-policy.types.js";
import { getPluginRegistryState } from "../plugins/runtime-state.js";
import { onUserProfilesChanged, readUserProfileVersion } from "../state/user-profile-events.js";
import { getUserProfileListItem } from "../state/user-profiles.js";
import { resolveOperatorRolePolicyForAssignment } from "./operator-role-policy.js";

export const GATEWAY_OPERATOR_ACCESS_DENIED_MESSAGE =
  "Gateway access is no longer active; ask a Gateway administrator to restore it.";

export class GatewayOperatorAccessDeniedError extends Error {
  constructor() {
    super(GATEWAY_OPERATOR_ACCESS_DENIED_MESSAGE);
    this.name = "GatewayOperatorAccessDeniedError";
  }
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

export function hasGatewayOperatorAccessPolicies(config: OpenClawConfig): boolean {
  return (
    currentAccessPolicies().length > 0 ||
    Object.values(config.gateway?.roles?.definitions ?? {}).some((role) => role.accessPolicyPlugin)
  );
}

/** Bind additional access to this exact authenticated person and the original policy lifetimes. */
export function resolveGatewayOperatorAccessAuthority(
  profileId: string,
  config: OpenClawConfig,
): PluginGatewayAccessAuthority | undefined {
  if (profileId === GATEWAY_OWNER_PROFILE_ID) {
    return undefined;
  }
  if (!hasGatewayOperatorAccessPolicies(config)) {
    return undefined;
  }
  const profile = getUserProfileListItem(profileId);
  const emails = [...profile.emails];
  let profileVersion = readUserProfileVersion();
  return resolvePreparedGatewayOperatorAccessAuthority(
    {
      profileId: profile.id,
      emails,
      role: profile.role ?? null,
      isCurrent: () => {
        if (profile.id !== profileId) {
          return false;
        }
        const currentVersion = readUserProfileVersion();
        if (currentVersion !== profileVersion) {
          const current = getUserProfileListItem(profileId);
          const currentEmails = new Set(current.emails);
          // A merge or alias replacement cannot transfer a captured grant to its successor.
          // Display/avatar changes preserve admitted work.
          if (current.id !== profileId || emails.some((email) => !currentEmails.has(email))) {
            return false;
          }
          profileVersion = currentVersion;
        }
        return true;
      },
    },
    config,
  );
}

/** Worker-prepared person facts retain their owner's memory-only identity lifetime. */
export function resolvePreparedGatewayOperatorAccessAuthority(
  profile: Readonly<{
    profileId: string;
    emails: readonly string[];
    role: string | null;
    isCurrent: () => boolean;
  }>,
  config: OpenClawConfig,
): PluginGatewayAccessAuthority | undefined {
  if (profile.profileId === GATEWAY_OWNER_PROFILE_ID) {
    return undefined;
  }
  const policies = currentAccessPolicies();
  if (policies.length === 0 && !hasGatewayOperatorAccessPolicies(config)) {
    return undefined;
  }
  const emails = [...profile.emails];
  const requiredPlugin = resolveOperatorRolePolicyForAssignment(
    profile.profileId,
    profile.role,
    config,
  )?.accessPolicyPlugin;
  if (requiredPlugin && !policies.some((entry) => entry.pluginId === requiredPlugin)) {
    throw new GatewayOperatorAccessDeniedError();
  }
  const invalidated = new AbortController();
  let signal = invalidated.signal;
  let denial: GatewayOperatorAccessDeniedError | undefined;
  const invalidate = () => {
    // A later invitation, alias restoration, or profile repair cannot revive this capture.
    denial ??= new GatewayOperatorAccessDeniedError();
    invalidated.abort(denial);
    return denial;
  };
  const assertProfileCurrent = () => {
    try {
      signal.throwIfAborted();
      if (!profile.isCurrent()) {
        throw new GatewayOperatorAccessDeniedError();
      }
    } catch {
      throw invalidate();
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
    const authorities = policies.flatMap(({ policy, pluginId }) => {
      const authority = policy.authorize({
        config,
        profile: { profileId: profile.profileId, emails: [...emails], assignedRole: profile.role },
        requiredByRole: pluginId === requiredPlugin,
      });
      if (authority && pluginId === requiredPlugin) {
        requiredPolicyConfirmed = true;
      }
      return authority ? [authority] : [];
    });
    if (!requiredPolicyConfirmed) {
      throw new GatewayOperatorAccessDeniedError();
    }
    if (authorities.length === 0) {
      releaseProfiles();
      return undefined;
    }
    signal = AbortSignal.any([invalidated.signal, ...authorities.map((entry) => entry.signal)]);
    const assertCurrent = () => {
      try {
        assertProfileCurrent();
        for (const authority of authorities) {
          authority.assertCurrent();
        }
      } catch {
        releaseProfiles();
        throw invalidate();
      }
    };
    // Retaining only the composed signal must also retain its policy sources.
    profileAccessChecks.set(signal, assertCurrent);
    assertCurrent();
    return { assertCurrent, signal };
  } catch {
    releaseProfiles();
    // Policy errors can contain private configuration; only the generic denial crosses ingress.
    throw invalidate();
  }
}

export function hasCurrentGatewayOperatorAccess(
  authority: PluginGatewayAccessAuthority | undefined,
): boolean {
  try {
    authority?.signal.throwIfAborted();
    authority?.assertCurrent();
    return true;
  } catch {
    return false;
  }
}
