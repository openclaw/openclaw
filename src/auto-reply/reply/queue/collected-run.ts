import { compareChannelAdmissionParticipants } from "../../../channels/message-access/admission-evidence.js";
import { readUserTurnDelegatedInputPolicy } from "../../../sessions/user-turn-transcript.metadata.js";
import type { FollowupRun } from "./types.js";

function hasVerifiedAdmissionParticipant(run: FollowupRun): boolean {
  return compareChannelAdmissionParticipants([run.channelAdmissionEvidence]) === "same";
}

export function resolveCollectedRun(items: readonly FollowupRun[], source: FollowupRun["run"]) {
  const participantComparison = compareChannelAdmissionParticipants(
    items.map((item) => item.channelAdmissionEvidence),
  );
  if (
    participantComparison === "same" ||
    !items.every((item) => hasVerifiedAdmissionParticipant(item))
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

function hasRuntimeOnlyFollowupMetadata(item: FollowupRun): boolean {
  return item.currentInboundEventKind === "room_event" || item.currentInboundAudio === true;
}

export function requiresIndividualCollectDrain(item: FollowupRun): boolean {
  return (
    // A definitive native rejection can return an already-committed source.
    // Keep its original recorder/event; only unconsumed sources may regroup.
    item.userTurnTranscriptRecorder?.hasPersisted() === true ||
    item.disableCollectBatching === true ||
    readUserTurnDelegatedInputPolicy(
      item.userTurnTranscriptRecorder?.getPendingInputMessage?.() ??
        item.userTurnTranscriptRecorder?.message,
    ) !== undefined ||
    item.run.skillWorkshopProposalRevision !== undefined ||
    item.run.skillLibraryAuthoring !== undefined ||
    hasRuntimeOnlyFollowupMetadata(item)
  );
}
