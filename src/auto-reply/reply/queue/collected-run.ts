import { compareChannelAdmissionParticipants } from "../../../channels/message-access/admission-evidence.js";
import { resolveFollowupReplyAnchor } from "./delivery-context.js";
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
    return source;
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

/** Preserve routing while withholding causal identity when several sources become one run. */
export function resolveCollectGroupIdentity(
  items: readonly FollowupRun[],
  groupSource: FollowupRun,
): { messageId: string | undefined; causalMessageId?: string } {
  return {
    messageId: groupSource.messageId ?? resolveFollowupReplyAnchor(groupSource),
    ...(items.length === 1 && items[0]?.causalMessageId
      ? { causalMessageId: items[0].causalMessageId }
      : {}),
  };
}
