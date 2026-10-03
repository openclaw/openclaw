import {
  intersectOperatorScopes,
  operatorScopeSatisfied,
  roleScopesAllow,
} from "../../shared/operator-scope-compat.js";
import { prepareUserProfileRoleAuthority } from "../../state/user-channel-identity-operations.js";
import { resolvePersonalGitHubOwner } from "../../state/user-github-connections.js";
import type { PersonalGitHubAction } from "../github-personal-oauth.js";
import { GitHubPublicationSessionChangedError } from "../github-publication-failure.js";
import { hasCurrentGatewayOperatorAccess } from "../operator-access-policy.js";
import {
  resolveOperatorRolePolicy,
  resolveOperatorRolePolicyForProfile,
  resolveOperatorRolePolicyForAssignment,
} from "../operator-role-policy.js";
import type { SessionMutationTarget } from "../session-mutation-authorization-error.js";
import {
  createSessionListEntryFilter,
  resolveSessionMutationAuthorization,
} from "../session-sharing.js";
import type { GatewaySessionStoreDiscoveryCache } from "../session-utils-store-candidates.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { isGatewayClientProfilePending } from "./gateway-client-identity.js";
import {
  isIneligiblePersonalGatewayCaller,
  isSyntheticGatewayCaller,
} from "./gateway-personal-caller.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type Request = Pick<GatewayRequestHandlerOptions, "client" | "context" | "signal">;

/** Intersect the live role ceiling with the socket grant, preserving scope implications. */
function currentGitHubClient(
  options: Request,
  scope: "operator.read" | "operator.write" | "operator.sessions.read",
  owner?: string | { profileId: string; role: string | null },
) {
  const { client, context } = options;
  if (
    options.signal?.aborted ||
    client?.invalidated ||
    client?.connectionSignal?.aborted ||
    !hasCurrentGatewayOperatorAccess(client?.internal?.operatorAccessAuthority) ||
    (client?.connId &&
      !isSyntheticGatewayCaller(client) &&
      !context.getClientConnIds?.((current) => current === client).has(client.connId))
  ) {
    throw new Error("GitHub request connection is no longer current; reconnect and try again.");
  }
  if (!client) {
    return null;
  }
  if (isGatewayClientProfilePending(client)) {
    throw new Error("Authenticated profile verification is unavailable; retry the request.");
  }
  const cfg = context.getRuntimeConfig();
  const profileId = typeof owner === "string" ? owner : owner?.profileId;
  const policy =
    typeof owner === "object"
      ? resolveOperatorRolePolicyForAssignment(owner.profileId, owner.role, cfg)
      : profileId
        ? resolveOperatorRolePolicyForProfile(profileId, cfg)
        : resolveOperatorRolePolicy(client, cfg);
  const granted = client.connect.scopes ?? [];
  const scopes = policy ? intersectOperatorScopes(granted, policy.scopes) : granted;
  if (
    client.connect.role !== "operator" ||
    !roleScopesAllow({
      role: "operator",
      requestedScopes: [scope],
      allowedScopes: scopes,
    })
  ) {
    throw new Error(`GitHub requires current ${scope} permission.`);
  }
  return {
    ...client,
    connect: { ...client.connect, scopes },
    ...(profileId && client.authenticatedUserProfile
      ? { authenticatedUserProfile: { ...client.authenticatedUserProfile, profileId } }
      : {}),
  };
}

type PersonalEligibility =
  | { kind: "eligible"; action: PersonalGitHubAction }
  | { kind: "absent" | "ineligible" };

/** Shared reads do not require a person; absence never substitutes for failed authentication. */
export async function prepareGitHubPublicationOptionsRead(
  options: Request &
    Pick<
      GatewayRequestHandlerOptions,
      "req" | "hasCurrentClientAuthority" | "sessionMutationCommitGuard"
    >,
  { sessionKey, agentId: requestedAgentId }: SessionMutationTarget,
) {
  // Store discovery is stable within this request; session rows remain live reads.
  const targetDiscoveryCache: GatewaySessionStoreDiscoveryCache = new Map();
  const authority = readGatewayRequestMutationAuthority(options);
  const client = options.client;
  const profileReference = client?.authenticatedUserProfile?.profileId;
  const userId = client?.authenticatedUserId;
  const access = client?.internal?.operatorAccessAuthority;
  const assertConnection = () => {
    authority.assertCurrent();
    if (
      client?.authenticatedUserProfile?.profileId !== profileReference ||
      client?.authenticatedUserId !== userId ||
      client?.internal?.operatorAccessAuthority !== access
    ) {
      throw new Error("GitHub profile changed; retry publication options.");
    }
  };
  assertConnection();
  currentGitHubClient(options, "operator.sessions.read");
  const profile = profileReference
    ? await prepareUserProfileRoleAuthority(profileReference)
    : undefined;
  assertConnection();
  if (profileReference && !profile) {
    throw new Error("Authenticated profile verification is unavailable; retry the request.");
  }
  const currentClient = () => {
    assertConnection();
    if (profile && !profile.isCurrent()) {
      throw new Error("GitHub profile changed; retry publication options.");
    }
    return currentGitHubClient(options, "operator.sessions.read", profile);
  };
  const eligibleClient = currentClient();
  const personal: PersonalEligibility =
    !eligibleClient?.connId ||
    isIneligiblePersonalGatewayCaller(eligibleClient) ||
    !operatorScopeSatisfied("operator.read", eligibleClient.connect.scopes ?? [])
      ? { kind: "ineligible" }
      : !profile
        ? { kind: "absent" }
        : { kind: "eligible", action: preparePersonalGitHubAction(options) };
  const readSession = (key: string, agentId?: string) => {
    const loaded = loadGatewaySessionEntryReadOnly(key, { agentId, targetDiscoveryCache });
    const filter = createSessionListEntryFilter({
      cfg: options.context.getRuntimeConfig(),
      client: currentClient(),
    });
    return loaded.entry && filter?.(loaded.canonicalKey, loaded.entry) !== false
      ? {
          sessionId: loaded.entry.sessionId,
          sessionKey: loaded.canonicalKey,
          agentId: loaded.agentId,
          lifecycleRevision: loaded.entry.lifecycleRevision ?? null,
          archivedAt: loaded.entry.archivedAt ?? null,
        }
      : null;
  };
  const session = readSession(sessionKey, requestedAgentId);
  if (!session) {
    throw new Error("GitHub publication session was not found.");
  }
  // sessionId/lifecycleRevision pin the incarnation; archivedAt is re-read below because
  // archiving flips it without touching either identity field.
  const readCurrent = () => {
    const current = readSession(session.sessionKey, session.agentId);
    if (
      !current ||
      current.sessionId !== session.sessionId ||
      current.lifecycleRevision !== session.lifecycleRevision
    ) {
      throw new Error("GitHub publication session access changed; select the session again.");
    }
    return current;
  };
  return {
    personal,
    session,
    sessionScoped: authority.sessionScope === "operator.sessions.read",
    currentSession: readCurrent,
    // Callbacks may refresh live facts, but must not replace the response's archive snapshot.
    assertSessionUnchanged: (snapshot: ReturnType<typeof readCurrent>): void => {
      const current = readCurrent();
      if (current.archivedAt !== snapshot.archivedAt) {
        throw new Error("GitHub publication session access changed; select the session again.");
      }
    },
  };
}

/** Authority stays in this direct connection closure; a profile or request id alone grants nothing. */
export function preparePersonalGitHubAction(
  options: Request,
  scope: "operator.read" | "operator.write" = "operator.read",
): PersonalGitHubAction {
  const { client, context } = options;
  const resolveOwner = () => {
    if (
      !client?.connId ||
      client.connect?.role !== "operator" ||
      isIneligiblePersonalGatewayCaller(client) ||
      options.signal?.aborted ||
      !context.getClientConnIds?.((current) => current === client).has(client.connId)
    ) {
      throw new Error("My GitHub requires a current authenticated human Gateway connection.");
    }
    const profile = client.authenticatedUserProfile?.profileId;
    const owner = profile ? resolvePersonalGitHubOwner(profile) : undefined;
    if (!owner) {
      throw new Error("My GitHub requires a verified durable user profile; sign in and try again.");
    }
    currentGitHubClient(options, scope, owner);
    return owner;
  };
  const owner = resolveOwner();
  return {
    owner,
    assertCurrent: () => {
      if (resolveOwner() !== owner) {
        throw new Error("My GitHub owner changed; retry from your current profile.");
      }
    },
  };
}

export function preparePersonalGitHubSessionAction(
  options: Request,
  { sessionKey, agentId }: SessionMutationTarget,
): PersonalGitHubAction & {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  lifecycleRevision: string | null;
} {
  const action = preparePersonalGitHubAction(options, "operator.write");
  const targetDiscoveryCache: GatewaySessionStoreDiscoveryCache = new Map();
  const initial = loadGatewaySessionEntryReadOnly(sessionKey, { agentId, targetDiscoveryCache });
  if (!initial.entry?.sessionId) {
    throw new Error("GitHub publication session was not found.");
  }
  const sessionId = initial.entry.sessionId;
  const lifecycleRevision = initial.entry.lifecycleRevision ?? null;
  const assertCurrent = () => {
    action.assertCurrent();
    const current = loadGatewaySessionEntryReadOnly(initial.canonicalKey, {
      agentId: initial.agentId,
      targetDiscoveryCache,
    });
    if (
      current.entry?.sessionId !== sessionId ||
      (current.entry.lifecycleRevision ?? null) !== lifecycleRevision ||
      current.entry.archivedAt !== undefined ||
      current.canonicalKey !== initial.canonicalKey
    ) {
      throw new GitHubPublicationSessionChangedError();
    }
    // This is a session mutation, not a run start. Preserve current admin rights without
    // retaining an admin grant that the person's live role no longer permits.
    const { error } = resolveSessionMutationAuthorization({
      client: currentGitHubClient(options, "operator.write", action.owner),
      method: "sessions.github.publish",
      requestParams: { sessionKey: initial.canonicalKey, agentId: initial.agentId },
      context: options.context,
    });
    if (error) {
      throw new Error(error.message);
    }
  };
  assertCurrent();
  return {
    ...action,
    assertCurrent,
    sessionId,
    lifecycleRevision,
    sessionKey: initial.canonicalKey,
    agentId: initial.agentId,
  };
}
