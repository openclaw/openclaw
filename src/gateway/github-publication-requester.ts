import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginGatewayAccessAuthority } from "../plugins/gateway-access-policy.types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import {
  decodeGitHubPublicationRequester,
  type GitHubPublicationRequesterSnapshot,
} from "../state/github-publication-requester.js";
import type { GitHubPublicationSourceSelector } from "../state/github-publication-source.types.js";
import { UserProfileMutationUnsettledError } from "../state/user-profile-events.js";
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import type { UserProfileAccessFacts } from "../state/user-profiles.types.js";
import { GitHubPublicationRequesterUnavailableError } from "./github-publication-failure.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import {
  prepareGitHubPublicationSource,
  type GitHubPublicationSourceCapability,
} from "./github-publication-source.js";
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
import { prepareSessionCreatorProfile } from "./session-creator.js";
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

/** @deprecated Use GitHubPublicationRequesterPolicyV2; removed in the next Plugin SDK major. */
export type GitHubPublicationRequesterPolicy = Readonly<{
  snapshot: GitHubPublicationRequesterSnapshot;
  assertCurrent: () => void;
}>;

/** @deprecated Use GitHubPublicationRequesterV2; removed in the next Plugin SDK major. */
export type GitHubPublicationRequester = GitHubPublicationRequesterPolicy &
  Readonly<{
    /** An accepted row keeps its own policy while the current invocation retains its fences. */
    assertInvocationCurrent: () => void;
  }>;

/** Prepared host policy and a required live source capability for worker-owned writes. */
export type GitHubPublicationRequesterPolicyV2 = GitHubPublicationRequesterPolicy &
  Readonly<{
    version: 2;
    signal: AbortSignal;
    prepareSource(
      selector: GitHubPublicationSourceSelector,
    ): Promise<GitHubPublicationSourceCapability>;
  }>;
export type GitHubPublicationRequesterV2 = GitHubPublicationRequesterPolicyV2 &
  Pick<GitHubPublicationRequester, "assertInvocationCurrent">;
const workerRequesters = resolveGlobalSingleton(
  Symbol.for("openclaw.githubPublicationWorkerRequesters"),
  () => new WeakSet<GitHubPublicationRequesterPolicy>(),
);

/** Classify before invoking any released assertion; a failed worker command never selects legacy. */
export function isGitHubPublicationRequesterV2(
  requester: GitHubPublicationRequesterPolicy,
): requester is GitHubPublicationRequesterPolicyV2 {
  return workerRequesters.has(requester);
}

function prepareRequesterPolicy(
  snapshot: GitHubPublicationRequesterSnapshot,
  session: PublicationSession,
  getCommittedRuntimeConfig: () => OpenClawConfig,
  identity: PreparedProfileIdentity | undefined,
  sessionFacts: PreparedPublicationSession | undefined,
  onPolicy?: (authority: PluginGatewayAccessAuthority | undefined) => void,
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
      ? resolveOperatorRolePolicyForAssignment(
          profile.profileId,
          profile.assignedRole,
          config,
          profile.githubLogin ?? null,
        )
      : undefined;
    if (
      !roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.sessions.write"],
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
      // Publication's creator restriction must preserve independently admitted capabilities.
      if (
        snapshot.actor.kind === "operator" &&
        !roleScopesAllow({
          role: "operator",
          requestedScopes: ["operator.write"],
          allowedScopes: snapshot.scopes,
        }) &&
        !prepareSessionCreatorProfile(
          snapshot.actor.profileId,
          current.aliases,
        )(facts.target.entry.createdActor)
      ) {
        throw new GitHubPublicationRequesterUnavailableError();
      }
      if (
        authorizePreparedSessionMutation({ cfg: config, client, ...session }, facts, {
          policy: role,
          aliases: current.aliases,
          // Publication mutates a session without starting an agent run.
          authorizesAgentRun: false,
        })
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
        const authority = resumeGatewayOperatorAccessGrant(profile, config, snapshot.grant);
        onPolicy?.(authority);
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
export async function prepareGitHubPublicationRequesterV2(
  options: Parameters<typeof captureGatewayOperatorRunAuthority>[0] &
    Pick<GatewayRequestHandlerOptions, "signal" | "sessionMutationAuthorization">,
  session: PublicationSession,
): Promise<{ requester: GitHubPublicationRequesterV2; release: () => void }> {
  options.signal?.throwIfAborted();
  options.sessionMutationAuthorization?.assertCurrent();
  const source = await captureGatewayOperatorRunAuthority(options);
  let identity: PreparedProfileIdentity | undefined;
  let sessionFacts: PreparedPublicationSession | undefined;
  const lifetime = new AbortController();
  const release = () => {
    lifetime.abort(new GitHubPublicationRequesterUnavailableError());
    sessionFacts?.release();
    identity?.release();
    source?.release();
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
    let policyAuthority: PluginGatewayAccessAuthority | undefined;
    const assertPolicy = prepareRequesterPolicy(
      snapshot,
      session,
      options.context.getCommittedRuntimeConfig ?? options.context.getRuntimeConfig,
      identity,
      sessionFacts,
      (authority) => {
        policyAuthority = authority;
      },
    );
    const signal = AbortSignal.any([
      lifetime.signal,
      ...(options.signal ? [options.signal] : []),
      ...(source?.authority.signal ? [source.authority.signal] : []),
    ]);
    const assertInvocationCurrent = () => {
      try {
        signal.throwIfAborted();
        if (options.hasCurrentClientAuthority?.() === false) {
          throw new GitHubPublicationRequesterUnavailableError();
        }
        options.sessionMutationAuthorization?.assertCurrent();
        source?.authority.assertCurrent();
      } catch {
        throw new GitHubPublicationRequesterUnavailableError();
      }
    };
    const requester: GitHubPublicationRequesterV2 = Object.freeze({
      version: 2 as const,
      signal,
      snapshot,
      assertInvocationCurrent,
      assertCurrent: () => {
        assertInvocationCurrent();
        assertPolicy();
        assertInvocationCurrent();
      },
      async prepareSource(selector: GitHubPublicationSourceSelector) {
        requester.assertCurrent();
        if (selector.agentId !== session.agentId || selector.sessionKey !== session.sessionKey) {
          throw new GitHubPublicationRequesterUnavailableError();
        }
        sessionFacts ??= await preparePublicationSession(
          session,
          (options.context.getCommittedRuntimeConfig ?? options.context.getRuntimeConfig)(),
        );
        requester.assertCurrent();
        const { sourcePath } = sessionFacts.readCurrent(
          (options.context.getCommittedRuntimeConfig ?? options.context.getRuntimeConfig)(),
        );
        if (!sourcePath) {
          throw new GitHubPublicationRecoveryPendingError(
            "GitHub publication source is unavailable; retry after session storage is ready.",
          );
        }
        return await prepareGitHubPublicationSource({
          sourcePath,
          selector: {
            ...selector,
            ...(snapshot.actor.kind === "operator"
              ? {
                  profileId: snapshot.actor.profileId,
                  aliasBindingIds: snapshot.grant?.aliasBindingIds,
                }
              : {}),
          },
          signal: AbortSignal.any([signal, ...(policyAuthority ? [policyAuthority.signal] : [])]),
          assertCurrent: requester.assertCurrent,
        });
      },
    });
    workerRequesters.add(requester);
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
): Promise<GitHubPublicationRequesterPolicyV2 & { release: () => void }> {
  const snapshot = decodeGitHubPublicationRequester(json);
  if (!snapshot) {
    throw new GitHubPublicationRequesterUnavailableError();
  }
  let identity: PreparedProfileIdentity | undefined;
  let sessionFacts: PreparedPublicationSession | undefined;
  const lifetime = new AbortController();
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
    lifetime.abort(new GitHubPublicationRequesterUnavailableError());
    sessionFacts?.release();
    identity?.release();
  };
  try {
    let policyAuthority: PluginGatewayAccessAuthority | undefined;
    const assertPolicy = prepareRequesterPolicy(
      snapshot,
      session,
      getCommittedRuntimeConfig,
      identity,
      sessionFacts,
      (authority) => {
        policyAuthority = authority;
      },
    );
    const requester: GitHubPublicationRequesterPolicyV2 & { release: () => void } = Object.freeze({
      version: 2 as const,
      signal: lifetime.signal,
      snapshot,
      assertCurrent() {
        lifetime.signal.throwIfAborted();
        assertPolicy();
      },
      async prepareSource(selector: GitHubPublicationSourceSelector) {
        requester.assertCurrent();
        if (selector.agentId !== session.agentId || selector.sessionKey !== session.sessionKey) {
          throw new GitHubPublicationRequesterUnavailableError();
        }
        sessionFacts ??= await preparePublicationSession(session, getCommittedRuntimeConfig());
        requester.assertCurrent();
        const { sourcePath } = sessionFacts.readCurrent(getCommittedRuntimeConfig());
        if (!sourcePath) {
          throw new GitHubPublicationRecoveryPendingError(
            "GitHub publication source is unavailable; retry after session storage is ready.",
          );
        }
        return await prepareGitHubPublicationSource({
          sourcePath,
          selector: {
            ...selector,
            ...(snapshot.actor.kind === "operator"
              ? {
                  profileId: snapshot.actor.profileId,
                  aliasBindingIds: snapshot.grant?.aliasBindingIds,
                }
              : {}),
          },
          signal: AbortSignal.any([
            lifetime.signal,
            ...(policyAuthority ? [policyAuthority.signal] : []),
          ]),
          assertCurrent: requester.assertCurrent,
        });
      },
      release,
    });
    workerRequesters.add(requester);
    requester.assertCurrent();
    return requester;
  } catch (error) {
    release();
    throw error;
  }
}
