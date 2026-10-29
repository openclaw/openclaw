import { getRuntimeConfigSnapshotMetadata } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import {
  intersectOperatorScopes,
  operatorScopeSatisfied,
  roleScopesAllow,
} from "../../shared/operator-scope-compat.js";
import { prepareUserProfileRolePolicyAuthority } from "../../state/user-channel-identity-operations.js";
import { captureResidentUserProfileAccess } from "../../state/user-profile-list.js";
import type { PersonalGitHubAction, PersonalGitHubActionV2 } from "../github-personal-oauth.js";
import type { PersonalGitHubSessionActionV2 } from "../github-personal-publication.js";
import {
  currentGitHubPublicationConfig,
  prepareGitHubPublicationSession,
} from "../github-publication-availability.js";
import { GitHubPublicationSessionChangedError } from "../github-publication-failure.js";
import { prepareGitHubPublicationRequesterV2 } from "../github-publication-requester.js";
import { hasCurrentGatewayOperatorAccess } from "../operator-access-policy.js";
import {
  resolveOperatorRolePolicy,
  resolveOperatorRolePolicyForProfile,
  resolveOperatorRolePolicyForAssignment,
  operatorSessionCap,
} from "../operator-role-policy.js";
import type { SessionMutationTarget } from "../session-mutation-authorization-error.js";
import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import { prepareSessionSharingRead } from "../session-sharing-target-read.js";
import { createSessionListEntryFilter } from "../session-sharing.js";
import { isGatewayClientProfilePending } from "./gateway-client-identity.js";
import {
  hasCurrentPersonalGatewaySource,
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
    (client?.internal?.remoteIngressPrincipal &&
      !hasCurrentPersonalGatewaySource(client, context)) ||
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

type OptionsSessionFlight = {
  pending: ReturnType<typeof prepareGitHubPublicationSession>;
  readers: number;
};
const optionsSessionFlights = new WeakMap<OpenClawConfig, Map<string, OptionsSessionFlight>>();

/** Share only pending durable preparation; every caller retains its own live authority. */
async function prepareOptionsSession(
  sessionKey: string,
  agentId: string | undefined,
  assertCurrent: () => void,
) {
  assertCurrent();
  const cfg = currentGitHubPublicationConfig();
  // Memory actors belong to the caller's storage context.
  if (isIncognitoSessionKey(sessionKey)) {
    return prepareGitHubPublicationSession(sessionKey, { agentId, cfg, assertCurrent });
  }
  let flights = optionsSessionFlights.get(cfg);
  if (!flights) {
    flights = new Map();
    optionsSessionFlights.set(cfg, flights);
  }
  const key = JSON.stringify([getRuntimeConfigSnapshotMetadata()?.revision, agentId, sessionKey]);
  let flight = flights.get(key);
  if (!flight) {
    flight = {
      pending: prepareGitHubPublicationSession(sessionKey, { agentId, cfg }).finally(() => {
        flights.delete(key);
      }),
      readers: 0,
    };
    flights.set(key, flight);
  }
  const selected = flight;
  selected.readers++;
  const session = await selected.pending;
  let active = true;
  const release = () => {
    if (!active) {
      return;
    }
    active = false;
    if (--selected.readers === 0) {
      session.release();
    }
  };
  try {
    assertCurrent();
    return {
      readCurrent: () => {
        if (!active) {
          throw new GitHubPublicationSessionChangedError();
        }
        return session.readCurrent();
      },
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}

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
    !eligibleClient ||
    !hasCurrentPersonalGatewaySource(options.client, options.context) ||
    !operatorScopeSatisfied("operator.read", eligibleClient.connect.scopes ?? [])
      ? { kind: "ineligible" }
      : !profile
        ? { kind: "absent" }
        : {
            kind: "eligible",
            action: preparePersonalGitHubAction(options, signal),
          };
  const preparedSession = await prepareOptionsSession(sessionKey, requestedAgentId, currentClient);
  let sharing: Awaited<ReturnType<typeof prepareSessionSharingRead>> | undefined;
  const release = () => {
    sharing?.release();
    preparedSession.release();
  };
  try {
    const initialCfg = options.context.getRuntimeConfig();
    if (operatorSessionCap(currentClient(), initialCfg) === "invited") {
      const loaded = preparedSession.readCurrent();
      sharing = await prepareSessionSharingRead({
        cfg: initialCfg,
        sessionKey,
        agentId: loaded.agentId,
      });
    }
    const readSession = () => {
      const current = currentClient();
      const loaded = preparedSession.readCurrent();
      const cfg = options.context.getRuntimeConfig();
      const sharingRead = sharing?.readCurrent(cfg);
      const target = sharingRead?.target;
      // Separately prepared membership must authorize the retained publication target.
      if (
        sharingRead &&
        (!target ||
          target.agentId !== loaded.agentId ||
          target.canonicalKey !== loaded.canonicalKey ||
          target.storePath !== loaded.storePath ||
          target.entry.sessionId !== loaded.entry?.sessionId ||
          target.entry.lifecycleRevision !== loaded.entry?.lifecycleRevision)
      ) {
        throw new GitHubPublicationSessionChangedError();
      }
      const filter = createSessionListEntryFilter({
        cfg,
        client: current,
        membership: sharingRead?.membership,
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
    const session = readSession();
    if (!session) {
      throw new Error("GitHub publication session was not found.");
    }
    // Archive and access changes invalidate the prepared response through write receipts.
    const readCurrent = () => {
      const current = readSession();
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
      release,
      [Symbol.dispose]: release,
      sessionScoped: authority.sessionScope === "operator.sessions.read",
      currentSession: readCurrent,
      currentSessionRead: () => {
        readCurrent();
        return preparedSession.readCurrent();
      },
      // Callbacks may refresh live facts, but must not replace the response's archive snapshot.
      assertSessionUnchanged: (snapshot: ReturnType<typeof readCurrent>): void => {
        const current = readCurrent();
        if (current.archivedAt !== snapshot.archivedAt) {
          throw new Error("GitHub publication session access changed; select the session again.");
        }
      },
    };
  } catch (error) {
    release();
    throw error;
  }
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
    if (!hasCurrentPersonalGatewaySource(client, context)) {
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
function preparePersonalGitHubAction(options: Request, signal?: AbortSignal): PersonalGitHubAction {
  const { client, context } = options;
  const resolveOwner = () => {
    signal?.throwIfAborted();
    if (!hasCurrentPersonalGatewaySource(client, context) || options.signal?.aborted) {
      throw new Error("My GitHub requires a current authenticated human Gateway connection.");
    }
    const profile = client.authenticatedUserProfile?.profileId;
    if (!profile) {
      throw new Error("My GitHub requires a verified durable user profile; sign in and try again.");
    }
    const current = captureResidentUserProfileAccess(profile).assertCurrent();
    if (current.merged_into) {
      throw new Error("My GitHub requires a verified durable user profile; sign in and try again.");
    }
    currentGitHubClient(options, "operator.read", {
      profileId: current.id,
      role: current.role ?? null,
      githubLogin: current.githubLogin,
    });
    return current.id;
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

async function bindPersonalGitHubSessionAction(
  options: Request,
  action: PersonalGitHubAction,
  target: SessionMutationTarget,
) {
  const prepared = await prepareGitHubPublicationSession(target.sessionKey, {
    agentId: target.agentId,
    assertCurrent: action.assertCurrent,
    fields: [
      "sessionId",
      "lifecycleRevision",
      "archivedAt",
      "owner",
      "createdActor",
      "visibility",
      "incognito",
    ],
  });
  let releaseAuthorization = () => {};
  try {
    const initial = prepared.readCurrent();
    if (!initial.entry?.sessionId) {
      throw new Error("GitHub publication session was not found.");
    }
    const { authorization, error } = await resolveSessionMutationAuthorizationAsync({
      client: currentGitHubClient(options, "operator.write", action.owner),
      method: "sessions.github.publish",
      requestParams: { sessionKey: initial.canonicalKey, agentId: initial.agentId },
      context: options.context,
      assertInvocationCurrent: action.assertCurrent,
    });
    releaseAuthorization = () => authorization?.release?.();
    if (error) {
      throw new Error(error.message);
    }
    const assertCurrent = () => {
      action.assertCurrent();
      currentGitHubClient(options, "operator.write", action.owner);
      const current = prepared.readCurrent();
      if (current.entry?.archivedAt !== undefined) {
        throw new GitHubPublicationSessionChangedError();
      }
      authorization?.assertCurrent();
    };
    assertCurrent();
    return {
      action: {
        ...action,
        assertCurrent,
        sessionId: initial.entry.sessionId,
        lifecycleRevision: initial.entry.lifecycleRevision ?? null,
        sessionKey: initial.canonicalKey,
        agentId: initial.agentId,
      },
      release: () => {
        releaseAuthorization();
        prepared.release();
      },
    };
  } catch (error) {
    releaseAuthorization();
    prepared.release();
    throw error;
  }
}

/** Retain the authenticated policy owner for worker commits as well as immediate effects. */
export async function preparePersonalGitHubSessionActionV2(
  options: Request & Parameters<typeof prepareGitHubPublicationRequesterV2>[0],
  target: SessionMutationTarget,
): Promise<{ action: PersonalGitHubSessionActionV2; release: () => void }> {
  const personal = await preparePersonalGitHubActionV2(options, "operator.write");
  const bound = await bindPersonalGitHubSessionAction(options, personal, target);
  const { action } = bound;
  try {
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
        release: () => {
          admitted.release();
          bound.release();
        },
      };
    } catch (error) {
      admitted.release();
      throw error;
    }
  } catch (error) {
    bound.release();
    throw error;
  }
}
