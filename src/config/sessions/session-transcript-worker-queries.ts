import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import type { SessionTranscriptWorkerInput } from "./session-transcript-worker.types.js";

type ForkReplyRequest = Extract<SessionTranscriptWorkerInput, { kind: "fork-reply-selection" }>;
type TranscriptSearchRequest = Extract<SessionTranscriptWorkerInput, { kind: "transcript-search" }>;

export async function selectForkReplyInTranscriptWorker(request: ForkReplyRequest) {
  const { readSessionForkReplySelection } = await import("./session-transcript-fork-reply.js");
  return readSessionForkReplySelection({
    target: {
      ...request.target,
      env: cloneEnvWithPlatformSemantics(request.target.env ?? process.env),
    },
    replyToId: request.replyToId,
    conversation: request.conversation,
    replyConversationRef: request.replyConversationRef,
  });
}

export async function searchTranscriptsInWorker(request: TranscriptSearchRequest) {
  const { searchSessionTranscriptsReadOnlySync } = await import("./session-transcript-search.js");
  return {
    kind: "transcript-search" as const,
    result: searchSessionTranscriptsReadOnlySync(request.params, {
      ...request.database,
      env: cloneEnvWithPlatformSemantics(request.params.env ?? process.env),
    }),
  };
}
