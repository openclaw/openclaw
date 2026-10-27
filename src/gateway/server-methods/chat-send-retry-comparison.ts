import { isDeepStrictEqual } from "node:util";
import { readSessionSubmittedInput } from "../../config/sessions/session-accessor.js";
import { SessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-transcript-projection-error.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { LoadedChatSendSession } from "./chat-send-session.js";

type ComparisonSession = Pick<
  LoadedChatSendSession,
  "agentId" | "storePath" | "sessionKey" | "clientRunId" | "entry"
>;
export type ChatSendRetryComparison = {
  agentId: string;
  storePath: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string | undefined;
  clientRunId: string;
  submitted: Awaited<ReturnType<typeof readSessionSubmittedInput>>;
  source?: "pending" | "transcript";
  messageSeq?: number;
};

/** Submitted bytes compare input; the caller's current owner still decides replay. */
export function readChatSendRetryComparison(session: ComparisonSession) {
  if (!session.entry?.sessionId) {
    return undefined;
  }
  const { agentId, storePath, sessionKey, clientRunId } = session;
  const { sessionId, lifecycleRevision } = session.entry;
  return readSessionSubmittedInput(
    { agentId, storePath, sessionKey, sessionId },
    `${clientRunId}:user`,
    { includeSource: true },
  ).then((submitted): ChatSendRetryComparison => {
    return {
      agentId,
      storePath,
      sessionKey,
      sessionId,
      lifecycleRevision,
      clientRunId,
      submitted: submitted?.message,
      source: submitted?.source,
      messageSeq: submitted?.messageSeq,
    };
  });
}

export function compareChatSendSubmittedInput(
  request: Pick<
    NormalizedChatSendRequest,
    "requestIdentity" | "rawMessage" | "mentions" | "workContext"
  >,
  session: ComparisonSession,
  comparison?: ChatSendRetryComparison,
) {
  if (
    (!comparison && session.entry?.sessionId) ||
    (comparison &&
      (comparison.agentId !== session.agentId ||
        comparison.storePath !== session.storePath ||
        comparison.sessionKey !== session.sessionKey ||
        comparison.sessionId !== session.entry?.sessionId ||
        comparison.lifecycleRevision !== session.entry?.lifecycleRevision ||
        comparison.clientRunId !== session.clientRunId))
  ) {
    throw new SessionTranscriptProjectionUnavailableError(
      session.entry?.sessionId ?? comparison?.sessionId ?? session.clientRunId,
      "window-changed",
    );
  }
  const submitted = comparison?.submitted;
  if (!submitted) {
    return request.mentions?.length || request.workContext ? "unverifiable" : false;
  }
  const storedIdentity = submitted["__openclaw"]?.chatRequestIdentity;
  if (typeof storedIdentity === "string") {
    return storedIdentity !== request.requestIdentity;
  }
  // Pre-fingerprint transcripts retain their existing annotation comparison contract.
  const storedMentions = submitted["__openclaw"]?.humanMentions;
  const storedContext = submitted["__openclaw"]?.workContext;
  const storedText =
    extractTextFromChatContent(submitted.content, {
      joinWith: "\n",
      normalizeText: (text) => text,
    }) ?? "";
  // Legacy pending inputs have no raw-request fingerprint. A transformed legacy
  // message is therefore unverifiable; only identical retained text can acknowledge it.
  if (comparison?.source === "pending" && storedText !== request.rawMessage) {
    return "unverifiable";
  }
  if (
    !request.mentions?.length &&
    !storedMentions?.length &&
    !request.workContext &&
    !storedContext
  ) {
    return false;
  }
  return (
    storedText !== request.rawMessage ||
    !isDeepStrictEqual(storedMentions ?? [], request.mentions ?? []) ||
    !isDeepStrictEqual(storedContext, request.workContext)
  );
}
