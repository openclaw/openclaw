import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import {
  participationAllowsTool,
  resolveParticipationTools,
  type ParticipationCeiling,
} from "../agents/participation-ceiling.js";
import { captureSessionEntryView } from "../config/sessions/session-entry-view.js";
import {
  captureSessionParticipationSource,
  captureSessionParticipationTarget,
  matchesSessionParticipationSource,
  matchesSessionParticipationTarget,
} from "../config/sessions/session-participation-source.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { GatewayOperatorAccessUnavailableError } from "../infra/operator-authority-error.js";
import { intersectOperatorScopes, roleScopesAllow } from "../shared/operator-scope-compat.js";
import {
  immutableGitHubPublicationParticipation,
  type GitHubPublicationParticipation,
  type GitHubPublicationRequesterSnapshot,
} from "../state/github-publication-requester.js";
import { UserProfileMutationUnsettledError } from "../state/user-profile-events.js";
import type { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import type { UserProfileAccessFacts } from "../state/user-profiles.types.js";
import { GitHubPublicationRequesterUnavailableError } from "./github-publication-failure.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import {
  isOpenClawIdTunnelPrincipalCurrent,
  openclawIdSubjectRolePolicy,
} from "./openclaw-id/tunnel-principal.js";
import {
  GatewayOperatorAccessDeniedError,
  resolveGatewayOperatorAccessAuthority,
} from "./operator-access-policy.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { prepareSessionCreatorProfile } from "./session-creator.js";
import { resolveSessionMemberAccess } from "./session-member-access.js";
import {
  authorizePreparedSessionMutation,
  authorizeSessionAgentRun,
  resolveSessionVisibility,
} from "./session-sharing-policy.js";
import type { prepareSessionMutationFacts } from "./session-sharing-preparation.js";
import type { ExistingSessionMutationFacts } from "./session-sharing-target.types.js";

type PublicationSession = { sessionKey: string; agentId: string };
type PreparedPublicationSession = Awaited<ReturnType<typeof prepareSessionMutationFacts>>;

export function publicationParticipationTarget(facts: ExistingSessionMutationFacts) {
  return captureSessionParticipationTarget(facts.target);
}

/** The original invitation is distinct from the exact session selected for publication. */
export function capturePublicationParticipation(
  ceiling: ParticipationCeiling,
  facts: ExistingSessionMutationFacts,
  config: OpenClawConfig,
): GitHubPublicationParticipation {
  let source = ceiling.source;
  if (!source) {
    try {
      source = captureSessionParticipationSource(
        ceiling.sessionKey,
        facts.target,
        resolveAgentWorkspaceDir(config, facts.target.agentId),
      );
    } catch {
      throw new GitHubPublicationRequesterUnavailableError();
    }
  }
  if (!source.creatorProfileId) {
    throw new GitHubPublicationRequesterUnavailableError();
  }
  return immutableGitHubPublicationParticipation({
    ceiling: { ...ceiling, source },
    target: publicationParticipationTarget(facts),
  });
}

function readPublicationFacts(
  prepared: PreparedPublicationSession | undefined,
  config: OpenClawConfig,
) {
  try {
    if (!prepared) {
      throw new Error("Prepared publication session is missing");
    }
    return prepared.readCurrent(config);
  } catch (error) {
    throw new GitHubPublicationRecoveryPendingError(
      "GitHub publication session authorization is unavailable; retry after session storage is ready.",
      { cause: error },
    );
  }
}

function assertPublicationParticipation(
  snapshot: GitHubPublicationRequesterSnapshot,
  session: PublicationSession,
  config: OpenClawConfig,
  current: { profile: UserProfileAccessFacts; aliases: ReadonlySet<string> } | undefined,
  role: GatewayOperatorRoleDefinition | undefined,
  participationFacts: PreparedPublicationSession | undefined,
  /** Access policy is admitted once per attempt; later checks keep only identity and source fences. */
  phase: "admission" | "current",
) {
  const client = createSyntheticPluginRuntimeClient({
    operatorRoleActor: snapshot.actor,
    openclawIdPrincipal: snapshot.openclawIdPrincipal,
    scopes: [...snapshot.scopes],
  });
  const participation = snapshot.participation;
  if (participation) {
    const { ceiling, target } = participation;
    const facts = readPublicationFacts(participationFacts, config);
    const admission = phase === "admission";
    const access = resolveSessionMemberAccess({
      policy: role,
      scopes: snapshot.scopes,
      creator: false,
      admin: false,
      member: {
        present: facts.membership.has(ceiling.profileId),
        access: facts.memberAccess?.[ceiling.profileId],
      },
      visibility: resolveSessionVisibility(facts.target.entry),
      incognito: facts.target.entry.incognito,
    });
    if (
      !current ||
      snapshot.actor.kind !== "operator" ||
      snapshot.actor.profileId !== ceiling.profileId ||
      target.agentId !== session.agentId ||
      target.sessionKey !== session.sessionKey ||
      facts.target.canonicalKey !== ceiling.sessionKey ||
      facts.target.agentId !== session.agentId ||
      !matchesSessionParticipationSource(
        ceiling,
        facts.target,
        resolveAgentWorkspaceDir(config, facts.target.agentId),
      ) ||
      !ceiling.tools ||
      !participationAllowsTool(ceiling, "github_publish") ||
      (admission &&
        (facts.target.entry.archivedAt !== undefined ||
          access.access !== "send" ||
          access.invitedAccessCeiling !== "send" ||
          !participationAllowsTool(
            {
              ...ceiling,
              tools: resolveParticipationTools(role?.sessions),
              toolConstraints: undefined,
            },
            "github_publish",
          ) ||
          authorizeSessionAgentRun(
            { cfg: config, client, target: facts.target, invitedSession: true },
            { policy: role },
          )))
    ) {
      throw new GitHubPublicationRequesterUnavailableError();
    }
  }
}

type PreparedProfileIdentity = Awaited<ReturnType<typeof prepareUserProfileIdentity>>;

export function prepareRequesterPolicy(
  snapshot: GitHubPublicationRequesterSnapshot,
  session: PublicationSession,
  getCommittedRuntimeConfig: () => OpenClawConfig,
  identity: PreparedProfileIdentity | undefined,
  readRole: (
    profile: UserProfileAccessFacts,
    cfg: OpenClawConfig,
  ) => GatewayOperatorRoleDefinition | undefined,
  sessionFacts: PreparedPublicationSession | undefined,
  originFacts?: PreparedPublicationSession,
  participationFacts?: PreparedPublicationSession,
) {
  const config = getCommittedRuntimeConfig();
  let current: { profile: UserProfileAccessFacts; aliases: ReadonlySet<string> } | undefined;
  if (snapshot.actor.kind === "operator") {
    try {
      if (!identity) {
        throw new GitHubPublicationRequesterUnavailableError();
      }
      current = identity.readCurrentFacts(snapshot.grant?.aliasBindingIds);
    } catch (error) {
      if (error instanceof UserProfileMutationUnsettledError) {
        throw new GitHubPublicationRecoveryPendingError(
          "GitHub publication identity authorization is unavailable; retry after the profile mutation settles.",
          { cause: error },
        );
      }
      throw new GitHubPublicationRequesterUnavailableError();
    }
    // Legacy records cannot recover authentication facts they never retained.
    if (
      !snapshot.authenticationSource &&
      !snapshot.openclawIdPrincipal &&
      current.profile.hasOpenClawIdIdentity
    ) {
      throw new GitHubPublicationRequesterUnavailableError();
    }
  }
  const principal = snapshot.openclawIdPrincipal;
  if (principal && !isOpenClawIdTunnelPrincipalCurrent(principal)) {
    throw new GitHubPublicationRequesterUnavailableError();
  }
  const role = openclawIdSubjectRolePolicy(principal, () =>
    current ? readRole(current.profile, config) : undefined,
  );
  const scopes = role ? intersectOperatorScopes(snapshot.scopes, role.scopes) : snapshot.scopes;
  if (
    !roleScopesAllow({
      role: "operator",
      requestedScopes: [
        snapshot.participation ? "operator.sessions.read" : "operator.sessions.write",
      ],
      allowedScopes: scopes,
    })
  ) {
    throw new GitHubPublicationRequesterUnavailableError();
  }
  if (current) {
    try {
      resolveGatewayOperatorAccessAuthority(current.profile.profileId, config, {
        requireLivePolicySet: true,
        openclawIdPrincipal: principal,
        grant: snapshot.grant,
      })?.assertCurrent();
    } catch (error) {
      if (error instanceof GatewayOperatorAccessDeniedError) {
        if (error.accessCause === "policy-unavailable") {
          throw new GatewayOperatorAccessUnavailableError();
        }
        throw new GitHubPublicationRequesterUnavailableError();
      }
      throw error;
    }
  }
  if (role?.accessPolicyPlugin && role.accessPolicyPlugin !== snapshot.grant?.pluginId) {
    throw new GitHubPublicationRequesterUnavailableError();
  }
  assertPublicationParticipation(
    snapshot,
    session,
    config,
    current,
    role,
    participationFacts,
    "admission",
  );
  const admitted = Object.freeze({ ...snapshot, scopes });
  const client = createSyntheticPluginRuntimeClient({
    operatorRoleActor: admitted.actor,
    openclawIdPrincipal: principal,
    scopes: [...scopes],
  });
  const targets = [
    { session, prepared: sessionFacts, origin: undefined },
    ...(snapshot.origin
      ? [{ session: snapshot.origin, prepared: originFacts, origin: snapshot.origin }]
      : []),
  ].flatMap((target) => {
    if (!current && !target.origin) {
      return [];
    }
    if (!target.prepared) {
      throw new GitHubPublicationRecoveryPendingError(
        "GitHub publication session authorization is unavailable; retry after session storage is ready.",
      );
    }
    let facts;
    try {
      facts = target.prepared.readCurrent(config);
    } catch (cause) {
      throw new GitHubPublicationRecoveryPendingError(
        "GitHub publication session authorization is unavailable; retry after session storage is ready.",
        { cause },
      );
    }
    const participation = snapshot.participation;
    if (
      participation &&
      !target.origin &&
      (!matchesSessionParticipationTarget(
        participation.target,
        captureSessionParticipationTarget(facts.target),
      ) ||
        facts.target.entry.archivedAt !== undefined)
    ) {
      throw new GitHubPublicationRequesterUnavailableError();
    }
    if (
      current &&
      !snapshot.participation &&
      ((admitted.actor.kind === "operator" &&
        !roleScopesAllow({
          role: "operator",
          requestedScopes: ["operator.write"],
          allowedScopes: scopes,
        }) &&
        !prepareSessionCreatorProfile(
          admitted.actor.profileId,
          current.aliases,
        )(facts.target.entry.createdActor)) ||
        authorizePreparedSessionMutation({ cfg: config, client, ...target.session }, facts, {
          policy: role,
          aliases: current.aliases,
          authorizesAgentRun: false,
        }))
    ) {
      throw new GitHubPublicationRequesterUnavailableError();
    }
    return [
      {
        prepared: target.prepared,
        view: captureSessionEntryView(
          {
            ...facts.target.entry,
            ...(target.origin
              ? {
                  sessionId: target.origin.sessionId,
                  lifecycleRevision: target.origin.lifecycleRevision,
                }
              : {}),
          },
          // Data fence on the session incarnation only; ownership is not re-checked after admission.
          ["sessionId", "lifecycleRevision"],
        ),
      },
    ];
  });
  const assertCurrent = () => {
    if (snapshot.participation) {
      assertPublicationParticipation(
        snapshot,
        session,
        getCommittedRuntimeConfig(),
        current,
        role,
        participationFacts,
        "current",
      );
    }
    for (const target of targets) {
      let entry;
      try {
        entry = target.prepared.readCurrent(getCommittedRuntimeConfig()).target.entry;
      } catch (cause) {
        throw new GitHubPublicationRecoveryPendingError(
          "GitHub publication session authorization is unavailable; retry after session storage is ready.",
          { cause },
        );
      }
      if (!target.view.matches(entry)) {
        throw new GitHubPublicationRequesterUnavailableError();
      }
    }
  };
  assertCurrent();
  return { snapshot: admitted, assertCurrent };
}
