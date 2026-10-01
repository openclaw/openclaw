import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { readSessionForkReplySelection } from "./session-transcript-fork-reply.js";
import { searchSessionTranscriptsReadOnlySync } from "./session-transcript-search.js";
import type { SessionTranscriptWorkerInput } from "./session-transcript-worker.types.js";

export function readForkReplySelectionForWorker(
  request: Extract<SessionTranscriptWorkerInput, { kind: "fork-reply-selection" }>,
) {
  return readSessionForkReplySelection({
    target: { ...request.target, env: cloneEnvWithPlatformSemantics(process.env) },
    replyToId: request.replyToId,
    conversation: request.conversation,
    replyConversationRef: request.replyConversationRef,
  });
}

export function searchTranscriptsForWorker(
  request: Extract<SessionTranscriptWorkerInput, { kind: "transcript-search" }>,
) {
  return {
    kind: "transcript-search" as const,
    result: searchSessionTranscriptsReadOnlySync(request.params, {
      ...request.database,
      env: cloneEnvWithPlatformSemantics(request.params.env ?? process.env),
    }),
  };
}
