import { getRuntimeConfigSnapshotMetadata } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { operatorScopeSatisfied } from "../../shared/operator-scope-compat.js";
import { captureResidentUserProfileAccess } from "../../state/user-profile-list.js";
import type { PersonalGitHubAction } from "../github-personal-oauth.js";
import type { PersonalGitHubSessionActionV2 } from "../github-personal-publication.js";
import {
  currentGitHubPublicationConfig,
  prepareGitHubPublicationSession,
} from "../github-publication-availability.js";
import { GitHubPublicationSessionChangedError } from "../github-publication-failure.js";
import { prepareGitHubPublicationRequesterV2 } from "../github-publication-requester.js";
import { operatorSessionCap } from "../operator-role-policy.js";
import type { SessionMutationTarget } from "../session-mutation-authorization-error.js";
import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import { prepareSessionSharingRead } from "../session-sharing-target-read.js";
import { createSessionListEntryFilter } from "../session-sharing.js";
import { hasCurrentPersonalGatewaySource } from "./gateway-personal-caller.js";
import {
  currentPersonalProfileClient as currentGitHubClient,
  preparePersonalProfileAction,
} from "./personal-profile-authorization.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type Request = Pick<GatewayRequestHandlerOptions, "client" | "context" | "signal">;

type PersonalEligibility =
  | { kind: "eligible"; action: PersonalGitHubAction }
  | { kind: "absent" | "ineligible" };

type OptionsSessionFlight = {
  pending: ReturnType<typeof prepareGitHubPublicationSession>;
  readers: number;
};
const optionsSessionFlights = new WeakMap<OpenClawConfig, Map<string, OptionsSessionFlight>>();

/** Share only pending durable preparation; each caller keeps its admitted authority. */
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
  purpose: "options" | "shared-observation" = "options",
) {
  const authority = readGatewayRequestMutationAuthority(options);
  const requestSignal = options.signal;
  const runSignal = options.client?.internal?.operatorRunAuthority?.signal;
  const assertCurrent = () => {
    signal?.throwIfAborted();
    requestSignal?.throwIfAborted();
    runSignal?.throwIfAborted();
  };
  assertCurrent();
  authority.assertCurrent();
  const profileReference = options.client?.authenticatedUserProfile?.profileId;
  const profileAccess = profileReference
    ? captureResidentUserProfileAccess(profileReference)
    : undefined;
  const profile = profileAccess?.assertCurrent();
  const personalOwner = profile?.id;
  const eligibleClient = currentGitHubClient(
    options,
    "operator.sessions.read",
    profile
      ? { profileId: profile.id, role: profile.role ?? null, githubLogin: profile.githubLogin }
      : undefined,
  );
  const personal: PersonalEligibility =
    purpose === "shared-observation" ||
    !eligibleClient ||
    !hasCurrentPersonalGatewaySource(options.client, options.context) ||
    !operatorScopeSatisfied("operator.read", eligibleClient.connect.scopes ?? [])
      ? { kind: "ineligible" }
      : !personalOwner || !profileAccess
        ? { kind: "absent" }
        : {
            kind: "eligible",
            action: {
              owner: personalOwner,
              assertCurrent: () => {
                assertCurrent();
                if (profileAccess.assertCurrent().id !== personalOwner) {
                  throw new Error("My GitHub owner changed; retry from your current profile.");
                }
              },
            },
          };
  const preparedSession =
    purpose === "shared-observation"
      ? await prepareGitHubPublicationSession(sessionKey, {
          agentId: requestedAgentId,
          assertCurrent,
          // Workspace changes belong to source observation, not disclosure authority.
          fields: [
            "sessionId",
            "lifecycleRevision",
            "owner",
            "createdActor",
            "visibility",
            "incognito",
          ],
        })
      : await prepareOptionsSession(sessionKey, requestedAgentId, assertCurrent);
  let sharing: Awaited<ReturnType<typeof prepareSessionSharingRead>> | undefined;
  const release = () => {
    sharing?.release();
    preparedSession.release();
  };
  try {
    const initialCfg = options.context.getRuntimeConfig();
    if (operatorSessionCap(eligibleClient, initialCfg) === "invited") {
      const loaded = preparedSession.readCurrent();
      sharing = await prepareSessionSharingRead({
        cfg: initialCfg,
        sessionKey,
        agentId: loaded.agentId,
      });
    }
    const filter = createSessionListEntryFilter({
      cfg: initialCfg,
      client: eligibleClient,
      membership: sharing?.readCurrent(initialCfg).membership,
    });
    const readSession = () => {
      assertCurrent();
      const loaded = preparedSession.readCurrent();
      const sharingRead = sharing?.readCurrent(initialCfg);
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
      client: options.client,
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
  const personal = await preparePersonalProfileAction(options, "operator.write");
  const bound = await bindPersonalGitHubSessionAction(
    { ...options, client: personal.client },
    personal,
    target,
  );
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
          prepareDispatchCredential: admitted.requester.prepareDispatchCredential,
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
