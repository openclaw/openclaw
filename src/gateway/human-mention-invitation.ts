import { isDeepStrictEqual } from "node:util";
import type { SessionMentionInvitation } from "../config/sessions/session-sharing-authority.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readResidentUserProfileAliases } from "../state/user-profile-list.js";
import type { createHumanMentionPolicy } from "./human-mention-policy.js";
import type { MentionInbox } from "./mention-inbox.contracts.js";
import { resolveOperatorRolePolicyForProfile } from "./operator-role-policy.js";
import { resolveSessionInvitationAccess } from "./session-member-access.js";

type Policy = ReturnType<typeof createHumanMentionPolicy>;

/** Prepare the transcript owner's invitation payload and its existing commit guard. */
export function prepareHumanMentionInvitation(
  context: { getRuntimeConfig: () => OpenClawConfig; isActive: () => boolean } & Pick<
    Policy,
    "readProfile" | "identify" | "recipientProfile"
  >,
  ...[client, target, mentions]: Parameters<MentionInbox["prepareInvitation"]>
): ReturnType<MentionInbox["prepareInvitation"]> {
  const { getRuntimeConfig, isActive, readProfile, identify, recipientProfile } = context;
  const select = (): SessionMentionInvitation | undefined => {
    if (!isActive()) {
      throw new Error("Mention invitation authority is closed");
    }
    const cfg = getRuntimeConfig();
    const candidates = mentions.flatMap((mention) => {
      const profile = readProfile(mention.profileId);
      if (!profile) {
        throw new Error("Mention recipient changed; select the recipients again");
      }
      const policy = resolveOperatorRolePolicyForProfile(profile.profileId, cfg);
      const access = resolveSessionInvitationAccess(policy, mention.access);
      if (!access.ok) {
        throw new Error(access.error);
      }
      return policy?.sessions.others === "invited"
        ? [{ ...mention, access: access.value, profile }]
        : [];
    });
    if (!candidates.length) {
      return undefined;
    }
    if (!target.entry) {
      throw new Error("Mention invitation requires an admitted session");
    }
    const requester = identify(client, cfg);
    if (!requester.ok) {
      throw new Error(requester.error.message);
    }
    const selectedTarget = { ...target, entry: target.entry };
    if (!requester.value.canInvite(selectedTarget)) {
      if (mentions.some((mention) => mention.access !== undefined)) {
        throw new Error("Only the session creator or an admin can set invitation access");
      }
      return undefined;
    }
    const profiles = new Map<string, SessionMentionInvitation["profiles"][number]>();
    for (const { profile, token, access } of candidates) {
      if (!recipientProfile(profile.profileId, selectedTarget, cfg, true)) {
        throw new Error("Mention recipient changed; select the recipients again");
      }
      const previous = profiles.get(profile.profileId);
      if (previous && previous.access !== access) {
        throw new Error("Conflicting invitation levels for the same recipient");
      }
      profiles.set(profile.profileId, {
        profileId: profile.profileId,
        ...(access ? { access } : {}),
        aliases: [...readResidentUserProfileAliases(profile.profileId)].toSorted(),
        tokens: [...new Set([...(previous?.tokens ?? []), token])],
      });
    }
    return {
      addedBy: requester.value.profile.profileId,
      expectedEntry: {
        sessionId: target.entry.sessionId,
        createdActor: target.entry.createdActor,
        visibility: target.entry.visibility,
        incognito: target.entry.incognito,
      },
      profiles: [...profiles.values()],
    };
  };
  const invitation = select();
  return invitation
    ? {
        invitation,
        assertCurrent() {
          const current = select();
          // The store owns transcript/view preconditions; this hook checks current authority.
          if (
            !current ||
            current.addedBy !== invitation.addedBy ||
            !isDeepStrictEqual(current.profiles, invitation.profiles)
          ) {
            throw new Error("Mention invitation is not authorized");
          }
        },
      }
    : undefined;
}
