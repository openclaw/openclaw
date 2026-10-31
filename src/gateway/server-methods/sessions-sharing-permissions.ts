import type {
  SessionMemberEvidence,
  SessionMemberPermission,
  SessionMemberPermissionLevel,
  SessionSharingIdentity,
} from "../../../packages/gateway-protocol/src/schema/sessions-sharing.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { profileCatalogPath } from "../../state/user-profile-identity.read.js";
import {
  listResidentUserProfileDisplayFacts,
  readResidentUserProfileRevision,
} from "../../state/user-profile-list.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { resolveOperatorRolePolicyForAssignment } from "../operator-role-policy.js";
import { prepareSessionCreatorProfile } from "../session-creator.js";
import {
  authorizeOwnSessionMutation,
  authorizeSessionAgentRun,
  resolveSessionVisibility,
  type SessionSharingTarget,
} from "../session-sharing-policy.js";
import { prepareProjectedSessionSharing } from "../session-sharing-read.js";
import { sessionSuggestionAddPermissionError } from "./sessions-suggestions-access.js";
import type { GatewayClient } from "./types.js";

/** Synchronous profile-policy projection, not a login or transport admission. */
export function projectSessionMemberPermissions(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  target: SessionSharingTarget;
  members: readonly SessionMemberEvidence[];
  identities: readonly SessionSharingIdentity[];
  profiles: ReturnType<typeof listResidentUserProfileDisplayFacts>;
}): SessionMemberPermission[] {
  const visibility = resolveSessionVisibility(params.target.entry);
  if (visibility === "shared" || visibility === "draft" || !params.client) {
    return [];
  }
  const pathname = profileCatalogPath({});
  const identities = new Map(params.identities.map((identity) => [identity.id, identity]));
  const profiles = new Map<
    string,
    {
      profileId: string;
      role: string | null;
      githubLogin: string | null;
      aliases: Set<string>;
    }
  >();
  // Resolve aliases once for the roster; per-profile identity reads would each scan the catalog.
  for (const display of params.profiles) {
    const current = readResidentUserProfileRevision(display.id, pathname);
    if (!current || current.id === GATEWAY_OWNER_PROFILE_ID) {
      continue;
    }
    let profile = profiles.get(current.id);
    if (!profile) {
      profile = {
        profileId: current.id,
        role: current.role ?? null,
        githubLogin: current.githubLogin ?? null,
        aliases: new Set<string>(),
      };
      profiles.set(current.id, profile);
    }
    profile.aliases.add(display.id);
  }
  const members = new Set(params.members.map((member) => member.identityId));
  const permissions: SessionMemberPermission[] = [];
  for (const profile of profiles.values()) {
    const identity = identities.get(profile.profileId);
    const isCreator = prepareSessionCreatorProfile(profile.profileId, profile.aliases);
    if (
      identity?.type !== "human" ||
      identity.identity?.type !== "profile" ||
      isCreator(params.target.entry.createdActor)
    ) {
      continue;
    }
    const policy = resolveOperatorRolePolicyForAssignment(
      profile.profileId,
      profile.role,
      params.cfg,
      profile.githubLogin ?? null,
    );
    // With no named policy, the profile has no configured scope ceiling. A device can still be narrower.
    const scopes = policy?.scopes ?? ["operator.read", "operator.write"];
    const client: GatewayClient = {
      connect: { ...params.client.connect, scopes },
      internal: { operatorRoleActor: { kind: "operator", profileId: profile.profileId } },
      preparedSessionProfile: profile,
    };
    const profilesForRead = { readCurrent: () => ({ profile, roleProfile: profile }) };
    const sharing = (member: boolean) =>
      prepareProjectedSessionSharing({
        cfg: params.cfg,
        client,
        profiles: profilesForRead,
        isMember: () => member,
      });
    const baseline = sharing(false);
    if (
      !authorizeOperatorScopesForMethod("chat.history", scopes).allowed ||
      baseline.entryFilter?.(params.target.canonicalKey, params.target.entry) === false
    ) {
      continue;
    }
    const sendScope = authorizeOperatorScopesForMethod("chat.send", scopes);
    const canStart =
      sendScope.allowed &&
      !authorizeOwnSessionMutation({
        client,
        target: params.target,
        expectedProfileId: sendScope.sessionScope ? profile.profileId : undefined,
        isCreator,
      }) &&
      !authorizeSessionAgentRun({ cfg: params.cfg, client, target: params.target }, { policy });
    const canSuggest = authorizeOperatorScopesForMethod("session.suggestions.add", scopes).allowed;
    const level = (member: boolean): SessionMemberPermissionLevel => {
      const access = member ? sharing(true) : baseline;
      if (canStart && !access.authorizeTarget(params.target)) {
        return "send";
      }
      if (
        canSuggest &&
        !sessionSuggestionAddPermissionError(
          access.roleForTarget(params.target),
          policy?.sessions.others,
          visibility,
        )
      ) {
        return "suggest";
      }
      return "read";
    };
    const withoutGrant = level(false);
    const withGrant = level(true);
    const options: SessionMemberPermissionLevel[] =
      withoutGrant !== "send" && withGrant === "send"
        ? [withoutGrant, "send"]
        : [members.has(profile.profileId) ? withGrant : withoutGrant];
    permissions.push({
      identityId: profile.profileId,
      level: members.has(profile.profileId) ? withGrant : withoutGrant,
      options,
    });
  }
  return permissions;
}
