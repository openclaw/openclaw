import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import type { ReplyOperation } from "./reply-run-registry.contracts.js";

export type GroupParticipationInput = {
  recorder: UserTurnTranscriptRecorder;
  sourceMessageId?: string;
  replyToText?: string;
};

export type GroupParticipationContext = {
  agentName?: string;
  replyToText?: string;
  sources?: readonly GroupParticipationInput[];
};

type AcceptedGroupInputs = {
  revision: number;
  identities: Set<string | object>;
  adoptedRecorders: Set<UserTurnTranscriptRecorder>;
  sources: GroupParticipationInput[];
};

// These facts belong to the live reply owner. They do not survive its process.
const acceptedInputs = new WeakMap<ReplyOperation, AcceptedGroupInputs>();

/** Call only after the existing admission or queue owner accepts this source. */
export function recordGroupParticipationInput(
  operation: ReplyOperation | undefined,
  run: {
    userTurnTranscriptRecorder?: UserTurnTranscriptRecorder;
    messageId?: string;
    originatingChannel?: string;
    run: { messageProvider?: string };
    groupParticipation?: GroupParticipationContext;
  },
  admission: "initial" | "steer" | "queued" = "queued",
): void {
  if (!operation || !run.userTurnTranscriptRecorder) {
    return;
  }
  let accepted = acceptedInputs.get(operation);
  if (!accepted) {
    if (!run.groupParticipation) {
      return;
    }
    accepted = { revision: 0, identities: new Set(), adoptedRecorders: new Set(), sources: [] };
    acceptedInputs.set(operation, accepted);
  }
  const sources = run.groupParticipation?.sources ?? [
    {
      recorder: run.userTurnTranscriptRecorder,
      sourceMessageId: run.messageId,
      replyToText: run.groupParticipation?.replyToText,
    },
  ];
  let adopted = false;
  const fresh = sources.filter((source) => {
    if (admission !== "queued" && !accepted.adoptedRecorders.has(source.recorder)) {
      accepted.adoptedRecorders.add(source.recorder);
      adopted = true;
    }
    const identity = source.sourceMessageId
      ? JSON.stringify([run.originatingChannel ?? run.run.messageProvider, source.sourceMessageId])
      : source.recorder;
    if (accepted.identities.has(identity)) {
      return false;
    }
    accepted.identities.add(identity);
    return true;
  });
  if (fresh.length === 0 && !adopted) {
    return;
  }
  if (admission === "initial") {
    accepted.sources.unshift(...fresh);
  } else {
    accepted.sources.push(...fresh);
  }
  accepted.revision++;
}

export function readGroupParticipationInputs(operation: ReplyOperation) {
  const accepted = acceptedInputs.get(operation);
  return {
    revision: accepted?.revision ?? 0,
    sources: accepted?.sources.slice() ?? [],
    adoptedRecorders: new Set(accepted?.adoptedRecorders),
  };
}
