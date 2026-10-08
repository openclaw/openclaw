import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import type { SessionTranscriptWorkerInput } from "./session-transcript-worker.types.js";

type ForkReplyRequest = Extract<SessionTranscriptWorkerInput, { kind: "fork-reply-selection" }>;

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
