import { getRuntimeConfigSnapshotMetadata } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { operatorScopeSatisfied } from "../../shared/operator-scope-compat.js";
import { prepareUserProfileRolePolicyAuthority } from "../../state/user-channel-identity-operations.js";
import { captureResidentUserProfileAccess } from "../../state/user-profile-list.js";
import type { PersonalGitHubAction, PersonalGitHubActionV2 } from "../github-personal-oauth.js";
import type { PersonalGitHubSessionActionV2 } from "../github-personal-publication.js";
import {
  currentGitHubPublicationConfig,
  prepareGitHubPublicationSession,
} from "../github-publication-availability.js";
import { GitHubPublicationSessionChangedError } from "../github-publication-failure.js";
import type { GitHubPublicationRequesterV2 } from "../github-publication-requester.js";
import { prepareGitHubPublicationRequesterV2 } from "../github-publication-requester.js";
import type { SessionMutationTarget } from "../session-mutation-authorization-error.js";
import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import { createSessionListEntryFilter } from "../session-sharing.js";
import { hasCurrentPersonalGatewaySource } from "./gateway-personal-caller.js";
import {
  currentPersonalForgeClient,
  preparePersonalForgeAction,
  type PersonalForgeAction,
} from "./personal-forge-authorization.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type Request = Pick<GatewayRequestHandlerOptions, "client" | "context" | "signal">;

const currentGitHubClient = currentPersonalForgeClient;

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
  label: "GitHub" | "GitLab" = "GitHub",
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
      throw new Error(`${label} profile changed; retry publication options.`);
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
      throw new Error(`${label} profile changed; retry publication options.`);
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
  try {
    const readSession = () => {
      const current = currentClient();
      const loaded = preparedSession.readCurrent();
      const filter = createSessionListEntryFilter({
        cfg: options.context.getRuntimeConfig(),
        client: current,
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
      throw new Error(`${label} publication session was not found.`);
    }
    // Archive and access changes invalidate the prepared response through write receipts.
    const readCurrent = () => {
      const current = readSession();
      if (
        !current ||
        current.sessionId !== session.sessionId ||
        current.lifecycleRevision !== session.lifecycleRevision
      ) {
        throw new Error(`${label} publication session access changed; select the session again.`);
      }
      return current;
    };
    return {
      personal,
      session,
      release: preparedSession.release,
      [Symbol.dispose]: preparedSession.release,
      sessionScoped: authority.sessionScope === "operator.sessions.read",
      currentSession: readCurrent,
      currentSessionRead: () => {
        currentClient();
        return preparedSession.readCurrent();
      },
      // Callbacks may refresh live facts, but must not replace the response's archive snapshot.
      assertSessionUnchanged: (snapshot: ReturnType<typeof readCurrent>): void => {
        const current = readCurrent();
        if (current.archivedAt !== snapshot.archivedAt) {
          throw new Error(`${label} publication session access changed; select the session again.`);
        }
      },
    };
  } catch (error) {
    preparedSession.release();
    throw error;
  }
}

export type PersonalGitLabPublicationReadAction = PersonalForgeAction & {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  lifecycleRevision: string | null;
};

/** Read access retains the selected session and direct human source even when disconnected. */
export async function preparePersonalGitLabPublicationOptionsRead(
  options: Parameters<typeof prepareGitHubPublicationOptionsRead>[0],
  target: SessionMutationTarget,
  signal?: AbortSignal,
) {
  const read = await prepareGitHubPublicationOptionsRead(options, target, signal, "GitLab");
  try {
    const session = read.currentSession();
    const personal =
      read.personal.kind === "eligible"
        ? await preparePersonalForgeAction(options, "operator.read", signal, "GitLab")
        : null;
    const action: PersonalGitLabPublicationReadAction | null = personal
      ? {
          ...personal,
          sessionId: session.sessionId,
          sessionKey: session.sessionKey,
          agentId: session.agentId,
          lifecycleRevision: session.lifecycleRevision,
          assertCurrent: () => {
            personal.assertCurrent();
            read.assertSessionUnchanged(session);
          },
        }
      : null;
    action?.assertCurrent();
    return {
      read,
      action,
      release: () => read.release(),
      [Symbol.dispose]: () => read.release(),
    };
  } catch (error) {
    read.release();
    throw error;
  }
}

/** The shared host owner admits both forge providers with the same human authority. */
export async function preparePersonalGitHubActionV2(
  options: Request,
  scope: "operator.read" | "operator.write" = "operator.read",
  callerSignal?: AbortSignal,
): Promise<PersonalGitHubActionV2> {
  return preparePersonalForgeAction(options, scope, callerSignal);
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

export async function bindPersonalForgeSessionAction<Action extends PersonalGitHubAction>(
  options: Request,
  action: Action,
  target: SessionMutationTarget,
  method = "sessions.github.publish",
  label = "GitHub",
  scope: "operator.write" | "operator.sessions.read" | "operator.sessions.write" = "operator.write",
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
      throw new Error(`${label} publication session was not found.`);
    }
    const { authorization, error } = await resolveSessionMutationAuthorizationAsync({
      client: currentGitHubClient(options, scope, action.owner, label),
      method,
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
      currentGitHubClient(options, scope, action.owner, label);
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

/** Both providers retain one native requester lifetime; only GitHub binds its personal store. */
async function preparePersonalForgeSessionActionV2(
  options: Request & Parameters<typeof prepareGitHubPublicationRequesterV2>[0],
  target: SessionMutationTarget,
  provider: "GitHub" | "GitLab",
  method: string,
) {
  const personal =
    provider === "GitHub"
      ? await preparePersonalGitHubActionV2(options, "operator.write")
      : await preparePersonalForgeAction(options, "operator.write", undefined, "GitLab");
  return retainPersonalForgePublicationSession(options, personal, target, provider, method);
}

/** Both direct UI actions and admitted tool handoffs use the native source owner. */
export async function retainPersonalForgePublicationSession(
  options: Request & Parameters<typeof prepareGitHubPublicationRequesterV2>[0],
  personal: PersonalForgeAction,
  target: SessionMutationTarget,
  provider: "GitHub" | "GitLab",
  method: string,
  scope: "operator.write" | "operator.sessions.write" = "operator.write",
) {
  const bound = await bindPersonalForgeSessionAction(
    options,
    personal,
    target,
    method,
    provider,
    scope,
  );
  const { action } = bound;
  try {
    const admitted = await prepareGitHubPublicationRequesterV2(options, action);
    try {
      action.assertCurrent();
      return {
        action: {
          ...action,
          version: 2 as const,
          signal: admitted.requester.signal,
          prepareSource: (
            selector: Parameters<GitHubPublicationRequesterV2["prepareSource"]>[0],
          ) => {
            action.assertCurrent();
            return admitted.requester.prepareSource(
              provider === "GitHub"
                ? { ...selector, personalOwnerProfileId: action.owner }
                : selector,
            );
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

/** Retain the authenticated policy owner for worker commits as well as immediate effects. */
export async function preparePersonalGitHubSessionActionV2(
  options: Request & Parameters<typeof prepareGitHubPublicationRequesterV2>[0],
  target: SessionMutationTarget,
): Promise<{ action: PersonalGitHubSessionActionV2; release: () => void }> {
  return preparePersonalForgeSessionActionV2(options, target, "GitHub", "sessions.github.publish");
}

/** GitLab source custody must not depend on the caller's separate GitHub connection. */
export async function preparePersonalGitLabSessionActionV2(
  options: Request & Parameters<typeof prepareGitHubPublicationRequesterV2>[0],
  target: SessionMutationTarget,
  method: "sessions.gitlab.publish" | "sessions.gitlab.confirm" = "sessions.gitlab.publish",
) {
  return preparePersonalForgeSessionActionV2(options, target, "GitLab", method);
}
