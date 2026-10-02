import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getGatewayRestartDrainSignal } from "../process/gateway-work-admission.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import {
  decodeGitHubPublicationRequester,
  type GitHubPublicationRequesterSnapshot,
} from "../state/github-publication-requester.js";
import { UserProfileMutationUnsettledError } from "../state/user-profile-events.js";
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import type { UserProfileAccessFacts } from "../state/user-profiles.types.js";
import { GitHubPublicationRequesterUnavailableError } from "./github-publication-failure.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import {
  GatewayOperatorAccessDeniedError,
  resumeGatewayOperatorAccessGrant,
} from "./operator-access-policy.js";
import {
  resolveGatewayOperatorRoleActor,
  resolveOperatorRolePolicyForAssignment,
} from "./operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import {
  authorizeIncognitoSessionTarget,
  authorizePreparedSessionMutation,
} from "./session-sharing-policy.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";

type PublicationSession = { sessionKey: string; agentId: string };
type PreparedProfileIdentity = Awaited<ReturnType<typeof prepareUserProfileIdentity>>;
type PreparedPublicationSession = Awaited<ReturnType<typeof prepareSessionMutationFacts>>;

function assertPublicationIncognitoAccess(
  profileId: string,
  scopes: readonly string[],
  sessionKey: string,
): void {
  const client = createSyntheticPluginRuntimeClient({
    operatorRoleActor: { kind: "operator", profileId },
    scopes: [...scopes],
  });
  if (authorizeIncognitoSessionTarget({ client, sessionKey, target: null })) {
    throw new GitHubPublicationRequesterUnavailableError();
  }
}

async function preparePublicationSession(
  session: PublicationSession,
  config: OpenClawConfig,
): Promise<PreparedPublicationSession> {
  try {
    return await prepareSessionMutationFacts({ cfg: config, ...session });
  } catch (error) {
    throw new GitHubPublicationRecoveryPendingError(
      "GitHub publication session authorization is unavailable; retry after session storage is ready.",
      { cause: error },
    );
  }
}

export type GitHubPublicationRequesterPolicy = Readonly<{
  snapshot: GitHubPublicationRequesterSnapshot;
  assertCurrent: () => void;
}>;

export type GitHubPublicationRequester = GitHubPublicationRequesterPolicy &
  Readonly<{
    /** An accepted row keeps its own policy while the current invocation retains its fences. */
    assertInvocationCurrent: () => void;
    requiresReview?: boolean;
    /** Only a live captured source can transfer a bounded candidate confirmation. */
    retainForReview?: () => {
      requester: GitHubPublicationRequester;
      signal: AbortSignal;
      release: () => void;
    };
  }>;

function prepareRequesterPolicy(
  snapshot: GitHubPublicationRequesterSnapshot,
  session: PublicationSession,
  getCommittedRuntimeConfig: () => OpenClawConfig,
  identity: PreparedProfileIdentity | undefined,
  sessionFacts: PreparedPublicationSession | undefined,
) {
  const client = createSyntheticPluginRuntimeClient({
    operatorRoleActor: snapshot.actor,
    scopes: [...snapshot.scopes],
  });
  const assertIdentity = () => {
    if (snapshot.actor.kind !== "operator") {
      return undefined;
    }
    try {
      if (!identity) {
        throw new GitHubPublicationRequesterUnavailableError();
      }
      return identity.readCurrentFacts(snapshot.grant?.aliasBindingIds);
    } catch (error) {
      if (error instanceof UserProfileMutationUnsettledError) {
        throw new GitHubPublicationRecoveryPendingError(
          "GitHub publication identity authorization is unavailable; retry after the profile mutation settles.",
          { cause: error },
        );
      }
      throw new GitHubPublicationRequesterUnavailableError();
    }
  };
  const assertRole = (profile: UserProfileAccessFacts | undefined, config: OpenClawConfig) => {
    const role = profile
      ? resolveOperatorRolePolicyForAssignment(profile.profileId, profile.assignedRole, config)
      : undefined;
    if (
      !roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.write"],
        allowedScopes: snapshot.scopes,
      }) ||
      (role &&
        (!roleScopesAllow({
          role: "operator",
          requestedScopes: snapshot.scopes,
          allowedScopes: role.scopes,
        }) ||
          (role.accessPolicyPlugin && role.accessPolicyPlugin !== snapshot.grant?.pluginId)))
    ) {
      throw new GitHubPublicationRequesterUnavailableError();
    }
    return role;
  };
  const assertPrepared = (config: OpenClawConfig) => {
    const current = assertIdentity();
    const role = assertRole(current?.profile, config);
    if (current) {
      let facts;
      try {
        if (!sessionFacts) {
          throw new Error("Prepared publication session is missing");
        }
        facts = sessionFacts.readCurrent(config);
      } catch (error) {
        throw new GitHubPublicationRecoveryPendingError(
          "GitHub publication session authorization is unavailable; retry after session storage is ready.",
          { cause: error },
        );
      }
      if (
        authorizePreparedSessionMutation(
          { cfg: config, client, ...session },
          facts,
          { policy: role, aliases: current.aliases },
          { intent: "mutation" },
        )
      ) {
        throw new GitHubPublicationRequesterUnavailableError();
      }
    }
    return current?.profile;
  };
  return () => {
    const config = getCommittedRuntimeConfig();
    const profile = assertPrepared(config);
    if (profile) {
      try {
        resumeGatewayOperatorAccessGrant(profile, config, snapshot.grant);
      } catch (error) {
        if (error instanceof GatewayOperatorAccessDeniedError) {
          throw new GitHubPublicationRequesterUnavailableError();
        }
        throw error;
      }
      // A policy callback can synchronously change identity, role, or committed config.
      assertPrepared(getCommittedRuntimeConfig());
    }
  };
}

/** Capture from the admitted caller, never request arguments, publisher, or session attribution. */
export async function captureGitHubPublicationRequester(
  options: Parameters<typeof captureGatewayOperatorRunAuthority>[0] &
    Pick<GatewayRequestHandlerOptions, "signal" | "sessionMutationAuthorization">,
  session: PublicationSession,
): Promise<{ requester: GitHubPublicationRequester; release: () => void }> {
  options.signal?.throwIfAborted();
  options.sessionMutationAuthorization?.assertCurrent();
  const source = await captureGatewayOperatorRunAuthority(options);
  let identity: PreparedProfileIdentity | undefined;
  let sessionFacts: PreparedPublicationSession | undefined;
  let references = 1;
  let released = false;
  const releaseReference = () => {
    references -= 1;
    if (references !== 0) {
      return;
    }
    sessionFacts?.release();
    identity?.release();
    source?.release();
  };
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    releaseReference();
  };
  try {
    const actor = source
      ? { kind: "operator" as const, profileId: source.authority.profileId }
      : resolveGatewayOperatorRoleActor(options.client);
    const system =
      actor?.kind === "system" ||
      options.client?.authenticatedUserProfile?.profileId === GATEWAY_OWNER_PROFILE_ID;
    if (
      (!source && !system) ||
      options.client?.connect.role !== "operator" ||
      (source && source.authority.gatewayAccessGrant === undefined)
    ) {
      throw new GitHubPublicationRequesterUnavailableError();
    }
    let grant: GitHubPublicationRequesterSnapshot["grant"] = null;
    if (source) {
      assertPublicationIncognitoAccess(
        source.authority.profileId,
        source.authority.scopes,
        session.sessionKey,
      );
      identity = await prepareUserProfileIdentity(source.authority.profileId);
      sessionFacts = await preparePublicationSession(
        session,
        (options.context.getCommittedRuntimeConfig ?? options.context.getRuntimeConfig)(),
      );
      if (source.authority.gatewayAccessGrant) {
        grant = Object.freeze({
          ...source.authority.gatewayAccessGrant,
          aliasBindingIds: identity.emailBindingIds,
        });
      }
    }
    const snapshot: GitHubPublicationRequesterSnapshot = Object.freeze({
      version: 1,
      actor: Object.freeze(
        source
          ? { kind: "operator" as const, profileId: source.authority.profileId }
          : { kind: "system" as const },
      ),
      scopes: Object.freeze([...(source?.authority.scopes ?? options.client.connect.scopes ?? [])]),
      grant,
    });
    const assertPolicy = prepareRequesterPolicy(
      snapshot,
      session,
      options.context.getCommittedRuntimeConfig ?? options.context.getRuntimeConfig,
      identity,
      sessionFacts,
    );
    const assertInvocationCurrent = () => {
      try {
        if (released) {
          throw new GitHubPublicationRequesterUnavailableError();
        }
        options.signal?.throwIfAborted();
        if (options.hasCurrentClientAuthority?.() === false) {
          throw new GitHubPublicationRequesterUnavailableError();
        }
        options.sessionMutationAuthorization?.assertCurrent();
        source?.authority.assertCurrent();
      } catch {
        throw new GitHubPublicationRequesterUnavailableError();
      }
    };
    const requester = Object.freeze({
      snapshot,
      requiresReview: source?.authority.rolePolicy?.sandboxRequired === true,
      assertInvocationCurrent,
      assertCurrent: () => {
        assertInvocationCurrent();
        assertPolicy();
        assertInvocationCurrent();
      },
      retainForReview: () => {
        requester.assertCurrent();
        if (!source) {
          throw new GitHubPublicationRequesterUnavailableError();
        }
        const lifetime = new AbortController();
        const signals = [source.authority.signal, getGatewayRestartDrainSignal()].filter(
          (signal): signal is AbortSignal => signal !== undefined,
        );
        references += 1;
        const releaseReviewHold = () => {
          if (lifetime.signal.aborted) {
            return;
          }
          lifetime.abort(new GitHubPublicationRequesterUnavailableError());
          for (const signal of signals) {
            signal.removeEventListener("abort", releaseReviewHold);
          }
          releaseReference();
        };
        for (const signal of signals) {
          signal.addEventListener("abort", releaseReviewHold, { once: true });
        }
        if (signals.some((signal) => signal.aborted)) {
          releaseReviewHold();
        }
        const assertSource = () => {
          lifetime.signal.throwIfAborted();
          source.authority.assertCurrent();
          lifetime.signal.throwIfAborted();
        };
        // The accepted publication owns this hold. The completed tool/RPC no longer
        // owns its lifetime, but original source, role, grant and session policy still do.
        const held = Object.freeze({
          snapshot,
          requiresReview: requester.requiresReview,
          assertInvocationCurrent: assertSource,
          assertCurrent: () => {
            assertSource();
            assertPolicy();
            assertSource();
          },
        });
        try {
          held.assertCurrent();
          return { requester: held, signal: lifetime.signal, release: releaseReviewHold };
        } catch (error) {
          releaseReviewHold();
          throw error;
        }
      },
    });
    requester.assertCurrent();
    return { requester, release };
  } catch (error) {
    release();
    throw error;
  }
}

/** Restoration rechecks the original immutable basis; a new role or invitation cannot replace it. */
export async function restoreGitHubPublicationRequester(
  json: string | null | undefined,
  session: PublicationSession,
  getCommittedRuntimeConfig: () => OpenClawConfig,
): Promise<GitHubPublicationRequesterPolicy & { release: () => void }> {
  const snapshot = decodeGitHubPublicationRequester(json);
  if (!snapshot) {
    throw new GitHubPublicationRequesterUnavailableError();
  }
  let identity: PreparedProfileIdentity | undefined;
  let sessionFacts: PreparedPublicationSession | undefined;
  if (snapshot.actor.kind === "operator") {
    assertPublicationIncognitoAccess(snapshot.actor.profileId, snapshot.scopes, session.sessionKey);
    try {
      identity = await prepareUserProfileIdentity(snapshot.actor.profileId);
      sessionFacts = await preparePublicationSession(session, getCommittedRuntimeConfig());
    } catch (error) {
      identity?.release();
      if (error instanceof GitHubPublicationRecoveryPendingError) {
        throw error;
      }
      throw new GitHubPublicationRecoveryPendingError(
        "GitHub publication requester identity is unavailable; retry recovery after profile storage is ready.",
        { cause: error },
      );
    }
  }
  const release = () => {
    sessionFacts?.release();
    identity?.release();
  };
  try {
    const requester = Object.freeze({
      snapshot,
      assertCurrent: prepareRequesterPolicy(
        snapshot,
        session,
        getCommittedRuntimeConfig,
        identity,
        sessionFacts,
      ),
      release,
    });
    requester.assertCurrent();
    return requester;
  } catch (error) {
    release();
    throw error;
  }
}
