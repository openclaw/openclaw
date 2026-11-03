import { compareChannelAdmissionParticipants } from "../../../channels/message-access/admission-evidence.js";
import {
  bindCommandOwnerAuthority,
  getCommandOwnerAuthority,
} from "../../command-owner-authority.js";
import type { FollowupRun } from "./types.js";

export function resolveCollectedRun(items: readonly FollowupRun[], source: FollowupRun["run"]) {
  const participantComparison = compareChannelAdmissionParticipants(
    items.map((item) => item.channelAdmissionEvidence),
  );
  if (
    participantComparison === "same" ||
    !items.every(
      (item) => compareChannelAdmissionParticipants([item.channelAdmissionEvidence]) === "same",
    )
  ) {
    const owner = getCommandOwnerAuthority(source);
    if (!owner || items.length < 2) {
      return source;
    }
    // Delivery-context grouping already binds the same source identity and policy.
    // Every contribution must retain its own live owner; the last item cannot
    // lend its authority to an unverified or revoked contribution.
    const owners = items.map((item) => getCommandOwnerAuthority(item.run));
    const collected = { ...source };
    bindCommandOwnerAuthority(collected, {
      ...owner,
      isCurrent: () => owner.isCurrent() && owners.every((entry) => entry?.isCurrent() === true),
    });
    return collected;
  }
  // Mixed or unverifiable people share no downstream sender authority. The
  // opaque admission aggregate records unknown identity at the run boundary.
  return {
    ...source,
    senderId: undefined,
    senderName: undefined,
    senderUsername: undefined,
    senderE164: undefined,
    senderIsOwner: false,
    traceAuthorized: false,
    ownerNumbers: [],
  };
}
