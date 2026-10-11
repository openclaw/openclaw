import {
  intersectOperatorScopes,
  operatorScopeSatisfied,
  roleScopesAllow,
} from "../../shared/operator-scope-compat.js";
import { prepareUserProfileRolePolicyAuthority } from "../../state/user-channel-identity-operations.js";
import { resolvePersonalGitHubOwner } from "../../state/user-github-connections.js";
import type { PersonalGitHubAction, PersonalGitHubActionV2 } from "../github-personal-oauth.js";
import type { PersonalGitHubSessionActionV2 } from "../github-personal-publication.js";
import { readGitHubPublicationSession } from "../github-publication-availability.js";
import { GitHubPublicationSessionChangedError } from "../github-publication-failure.js";
import { prepareGitHubPublicationRequesterV2 } from "../github-publication-requester.js";
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
import { loadGatewaySessionEntryReadOnlyInWorker } from "../session-utils-store-worker.js";
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
  owner?: string | { profileId: string; role: string | null; githubLogin?: string | null },
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
      ? resolveOperatorRolePolicyForAssignment(
          owner.profileId,
          owner.role,
          cfg,
          owner.githubLogin ?? null,
        )
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
  signal?: AbortSignal,
) {
  // Store discovery is stable within this request; session rows remain live reads.
  const targetDiscoveryCache: GatewaySessionStoreDiscoveryCache = new Map();
  const authority = readGatewayRequestMutationAuthority(options);
  const client = options.client;
  const profileReference = client?.authenticatedUserProfile?.profileId;
  const userId = client?.authenticatedUserId;
  const access = client?.internal?.operatorAccessAuthority;
  const assertConnection = () => {
    signal?.throwIfAborted();
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
    ? await prepareUserProfileRolePolicyAuthority(profileReference)
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
        : {
            kind: "eligible",
            action: preparePersonalGitHubAction(options, "operator.read", signal),
          };
  const readSession = (key: string, agentId?: string) => {
    const loaded = readGitHubPublicationSession(key, { agentId, targetDiscoveryCache });
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

/** Prepare canonical role facts off-thread; live checks consume the profile owner's revisions. */
export async function preparePersonalGitHubActionV2(
  options: Request,
  scope: "operator.read" | "operator.write" = "operator.read",
  callerSignal?: AbortSignal,
): Promise<PersonalGitHubActionV2> {
  const { client, context } = options;
  const profileReference = client?.authenticatedUserProfile?.profileId;
  const userId = client?.authenticatedUserId;
  const access = client?.internal?.operatorAccessAuthority;
  const signals = [options.signal, callerSignal, client?.connectionSignal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const signal = AbortSignal.any(signals);
  const assertConnection = () => {
    signal.throwIfAborted();
    if (
      !client?.connId ||
      client.connect?.role !== "operator" ||
      isIneligiblePersonalGatewayCaller(client) ||
      !context.getClientConnIds?.((current) => current === client).has(client.connId)
    ) {
      throw new Error("My GitHub requires a current authenticated human Gateway connection.");
    }
    if (
      client.authenticatedUserProfile?.profileId !== profileReference ||
      client.authenticatedUserId !== userId ||
      client.internal?.operatorAccessAuthority !== access
    ) {
      throw new Error("My GitHub owner changed; retry from your current profile.");
    }
  };
  assertConnection();
  const profile = profileReference
    ? await prepareUserProfileRolePolicyAuthority(profileReference)
    : undefined;
  assertConnection();
  if (!profile) {
    throw new Error("My GitHub requires a verified durable user profile; sign in and try again.");
  }
  const assertCurrent = () => {
    assertConnection();
    if (!profile.isCurrent()) {
      throw new Error("My GitHub owner changed; retry from your current profile.");
    }
    currentGitHubClient(options, scope, profile);
  };
  assertCurrent();
  return { owner: profile.profileId, signal, assertCurrent };
}

/** Authority stays in this direct connection closure; a profile or request id alone grants nothing. */
function preparePersonalGitHubAction(
  options: Request,
  scope: "operator.read" | "operator.write" = "operator.read",
  signal?: AbortSignal,
): PersonalGitHubAction {
  const { client, context } = options;
  const resolveOwner = () => {
    signal?.throwIfAborted();
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

function bindPersonalGitHubSessionAction(
  options: Request,
  action: PersonalGitHubAction,
  initial: Pick<
    ReturnType<typeof readGitHubPublicationSession>,
    "entry" | "canonicalKey" | "agentId"
  >,
  targetDiscoveryCache: GatewaySessionStoreDiscoveryCache,
) {
  if (!initial.entry?.sessionId) {
    throw new Error("GitHub publication session was not found.");
  }
  const sessionId = initial.entry.sessionId;
  const lifecycleRevision = initial.entry.lifecycleRevision ?? null;
  const assertCurrent = () => {
    action.assertCurrent();
    const current = readGitHubPublicationSession(initial.canonicalKey, {
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

/** Retain the authenticated policy owner for worker commits as well as immediate effects. */
export async function preparePersonalGitHubSessionActionV2(
  options: Request & Parameters<typeof prepareGitHubPublicationRequesterV2>[0],
  target: SessionMutationTarget,
): Promise<{ action: PersonalGitHubSessionActionV2; release: () => void }> {
  const personal = await preparePersonalGitHubActionV2(options, "operator.write");
  const initial = await loadGatewaySessionEntryReadOnlyInWorker({
    cfg: options.context.getRuntimeConfig(),
    key: target.sessionKey,
    agentId: target.agentId,
    assertActive: personal.assertCurrent,
  });
  const action = bindPersonalGitHubSessionAction(options, personal, initial, new Map());
  const admitted = await prepareGitHubPublicationRequesterV2(options, action);
  try {
    action.assertCurrent();
    return {
      action: {
        ...action,
        version: 2,
        signal: admitted.requester.signal,
        prepareSource: (selector) => {
          action.assertCurrent();
          return admitted.requester.prepareSource({
            ...selector,
            personalOwnerProfileId: action.owner,
          });
        },
      },
      release: admitted.release,
    };
  } catch (error) {
    admitted.release();
    throw error;
  }
}
