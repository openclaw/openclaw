import { compareChannelAdmissionParticipants } from "../../../channels/message-access/admission-evidence.js";
import type { FollowupRun } from "./types.js";

export function resolveCollectedRun(items: readonly FollowupRun[], source: FollowupRun["run"]) {
  // A combined prompt represents multiple provider messages, not the source's
  // single transport message. Never attach one source's ID to the aggregate.
  const scopedSource = items.length === 1 ? source : { ...source, inboundTransport: undefined };
  const participantComparison = compareChannelAdmissionParticipants(
    items.map((item) => item.channelAdmissionEvidence),
  );
  if (
    participantComparison === "same" ||
    !items.every(
      (item) => compareChannelAdmissionParticipants([item.channelAdmissionEvidence]) === "same",
    )
  ) {
    return scopedSource;
  }
  // Mixed or unverifiable people share no downstream sender authority. The
  // opaque admission aggregate records unknown identity at the run boundary.
  return {
    ...scopedSource,
    senderId: undefined,
    senderName: undefined,
    senderUsername: undefined,
    senderE164: undefined,
    senderIsOwner: false,
    traceAuthorized: false,
    ownerNumbers: [],
  };
}

/** A synthetic overflow summary is never the original provider message. */
export function resolveSyntheticOverflowRun(
  items: readonly FollowupRun[],
  source: FollowupRun["run"],
) {
  return { ...resolveCollectedRun(items, source), inboundTransport: undefined };
}
