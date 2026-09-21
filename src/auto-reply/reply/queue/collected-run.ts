import { compareChannelAdmissionParticipants } from "../../../channels/message-access/admission-evidence.js";
import { readUserProfileIdentity } from "../../../state/user-profile-list.js";
import type { FollowupRun } from "./types.js";

function hasVerifiedAdmissionParticipant(run: FollowupRun): boolean {
  return compareChannelAdmissionParticipants([run.channelAdmissionEvidence]) === "same";
}

export function resolveCollectedRun(items: readonly FollowupRun[], source: FollowupRun["run"]) {
  // A collected prompt with several (or unidentified) people has no personal overlay.
  const profileIds = items.map((item) =>
    item.run.bootstrapUserProfileId
      ? readUserProfileIdentity(item.run.bootstrapUserProfileId)?.profileId
      : undefined,
  );
  const collectedSource = {
    ...source,
    bootstrapUserProfileId: profileIds.every((id) => id === profileIds[0])
      ? profileIds[0]
      : undefined,
  };
  const participantComparison = compareChannelAdmissionParticipants(
    items.map((item) => item.channelAdmissionEvidence),
  );
  if (
    participantComparison === "same" ||
    !items.every((item) => hasVerifiedAdmissionParticipant(item))
  ) {
    return collectedSource;
  }
  // Mixed or unverifiable people share no downstream sender authority. The
  // opaque admission aggregate records unknown identity at the run boundary.
  return {
    ...collectedSource,
    senderId: undefined,
    senderName: undefined,
    senderUsername: undefined,
    senderE164: undefined,
    senderIsOwner: false,
    traceAuthorized: false,
    ownerNumbers: [],
  };
}
