// Presentation for linking an approved DM sender to a Gateway person.
import {
  GATEWAY_OWNER_PROFILE_ID,
  type UserProfile,
} from "../../../../packages/gateway-protocol/src/schema/users.js";
import type { ChannelsPairingApproveResult } from "../../api/types.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { profileDirectory } from "../../lib/profile-directory.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import type { ChannelPairingLinkTargets } from "./view.types.ts";

/** The Gateway's people; reading it starts the shared directory load. */
export function projectPairingPeople(gateway: ApplicationGateway) {
  return projectOwner(profileDirectory(gateway), (owner) => owner.result?.profiles ?? []);
}

/** People who can receive a link; the shared Owner and merged aliases are not people. */
export function readPairingLinkTargets(
  profiles: readonly UserProfile[],
  selfId: string | undefined,
): ChannelPairingLinkTargets {
  const self = profiles.find((profile) => profile.id === selfId);
  return {
    selfProfileId: self?.mergedInto ?? selfId ?? null,
    people: profiles
      .filter((profile) => !profile.mergedInto && profile.id !== GATEWAY_OWNER_PROFILE_ID)
      .map((profile) => ({
        id: profile.id,
        label:
          profile.displayName ?? profile.githubIdentity?.login ?? profile.emails[0] ?? profile.id,
      })),
  };
}

export function pairingLinkLabel(profiles: readonly UserProfile[], profileId: string): string {
  return (
    readPairingLinkTargets(profiles, undefined).people.find((person) => person.id === profileId)
      ?.label ?? profileId
  );
}

/** One notice for the approval and each optional follow-up the administrator chose. */
export function formatPairingApprovalNotice(
  result: ChannelsPairingApproveResult,
  linkedName: string,
): string {
  const approval = t(
    result.commandOwnerBootstrap === "unavailable"
      ? result.notification === "failed"
        ? "channels.pairing.approvedFollowupsFailedNotice"
        : "channels.pairing.approvedOwnerFailedNotice"
      : result.notification === "failed"
        ? "channels.pairing.approvedNotificationFailedNotice"
        : result.commandOwnerBootstrap === "configured"
          ? "channels.pairing.approvedOwnerNotice"
          : "channels.pairing.approvedNotice",
  );
  const link =
    result.identityLink === "linked"
      ? t("channels.pairing.linkedNotice", { name: linkedName })
      : result.identityLink === "linked-elsewhere"
        ? t("channels.pairing.linkedElsewhereNotice")
        : result.identityLink === "unavailable"
          ? t("channels.pairing.linkFailedNotice")
          : null;
  return link ? approval + " " + link : approval;
}
