import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import {
  PARTICIPATION_TOOL_ALLOWLIST,
  type ParticipationCeiling,
} from "../agents/participation-ceiling.js";
import { sessionCreatorProfileId } from "../config/sessions/session-entry-provenance.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginGatewayAccessAuthority } from "../plugins/gateway-access-policy.types.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import {
  immutableGitHubPublicationParticipation,
  type GitHubPublicationParticipation,
  type GitHubPublicationRequesterSnapshot,
} from "../state/github-publication-requester.js";
import { UserProfileMutationUnsettledError } from "../state/user-profile-events.js";
import type { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import type { UserProfileAccessFacts } from "../state/user-profiles.types.js";
import { resolveUserPath } from "../utils.js";
import { GitHubPublicationRequesterUnavailableError } from "./github-publication-failure.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import {
  isOpenClawIdTunnelPrincipalCurrent,
  openclawIdSubjectRolePolicy,
} from "./openclaw-id/tunnel-principal.js";
import {
  GatewayOperatorAccessDeniedError,
  resumeGatewayOperatorAccessGrant,
} from "./operator-access-policy.js";
import { operatorRoleSubject } from "./operator-role-enforcement.js";
import { resolveOperatorRolePolicyForAssignment } from "./operator-role-policy.js";
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
type PreparedProfileIdentity = Awaited<ReturnType<typeof prepareUserProfileIdentity>>;
type PreparedPublicationSession = Awaited<ReturnType<typeof prepareSessionMutationFacts>>;

export function publicationParticipationTarget(facts: ExistingSessionMutationFacts) {
  return Object.freeze({
    agentId: facts.target.agentId,
    sessionKey: facts.target.canonicalKey,
    sessionId: facts.target.entry.sessionId,
    lifecycleRevision: facts.target.entry.lifecycleRevision ?? null,
  });
}

function publicationParticipationSource(
  facts: ExistingSessionMutationFacts,
  config: OpenClawConfig,
) {
  return {
    agentId: facts.target.agentId,
    sessionId: facts.target.entry.sessionId,
    lifecycleRevision: facts.target.entry.lifecycleRevision ?? null,
    creatorProfileId: sessionCreatorProfileId(facts.target.entry.createdActor),
    root: resolveUserPath(
      facts.target.entry.sessionRoot ??
        facts.target.entry.spawnedWorkspaceDir ??
        resolveAgentWorkspaceDir(config, facts.target.agentId),
    ),
  };
}

/** The original invitation is distinct from the exact session selected for publication. */
export function capturePublicationParticipation(
  ceiling: ParticipationCeiling,
  facts: ExistingSessionMutationFacts,
  config: OpenClawConfig,
): GitHubPublicationParticipation {
  const source = ceiling.source ?? publicationParticipationSource(facts, config);
  if (
    !source.creatorProfileId ||
    (!ceiling.source && ceiling.sessionKey !== facts.target.canonicalKey)
  ) {
    throw new GitHubPublicationRequesterUnavailableError();
  }
  return immutableGitHubPublicationParticipation({
    ceiling: { ...ceiling, source: { ...source, creatorProfileId: source.creatorProfileId } },
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

export function assertPublicationParticipation(
  snapshot: GitHubPublicationRequesterSnapshot,
  session: PublicationSession,
  config: OpenClawConfig,
  current: { profile: UserProfileAccessFacts; aliases: ReadonlySet<string> } | undefined,
  role: ReturnType<typeof resolveOperatorRolePolicyForAssignment>,
  participationFacts: PreparedPublicationSession | undefined,
) {
  const client = createSyntheticPluginRuntimeClient({ operatorRoleActor: snapshot.actor, openclawIdPrincipal: snapshot.openclawIdPrincipal, scopes: [...snapshot.scopes] });
  const participation = snapshot.participation;
    if (participation) {
      const { ceiling, target } = participation;
      const facts = readPublicationFacts(participationFacts, config);
      const source = publicationParticipationSource(facts, config);
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
        source.agentId !== session.agentId ||
        source.agentId !== ceiling.source.agentId ||
        source.sessionId !== ceiling.source.sessionId ||
        source.lifecycleRevision !== ceiling.source.lifecycleRevision ||
        source.creatorProfileId !== ceiling.source.creatorProfileId ||
        source.root !== ceiling.source.root ||
        facts.target.entry.archivedAt !== undefined ||
        access.access !== "send" ||
        access.invitedAccessCeiling !== "send" ||
        !ceiling.tools?.includes("github_publish") ||
        !(role?.sessions.invitedTools ?? PARTICIPATION_TOOL_ALLOWLIST).includes("github_publish") ||
        authorizeSessionAgentRun(
          { cfg: config, client, target: facts.target, invitedSession: true },
          { policy: role },
        )
      ) {
        throw new GitHubPublicationRequesterUnavailableError();
      }
    }
}
