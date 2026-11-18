import { isDeepStrictEqual } from "node:util";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { readSessionSubmittedInput } from "../../config/sessions/session-accessor.js";
import type { SessionPendingInputEndCause } from "../../config/sessions/session-pending-input-end-cause.types.js";
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
  state?: string;
  endCause?: SessionPendingInputEndCause;
  completion?: import("../../agents/agent-run-terminal-outcome.types.js").AgentRunTerminalOutcome;
};

export function chatSendRequestConflictError(unverifiable = false) {
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    unverifiable
      ? "The previous mention selections cannot be verified. Check the conversation history and use a new message ID to send again."
      : "This message ID was already used for different input. Check the conversation history and use a new message ID to send again.",
    { details: { reason: "chat-request-conflict" } },
  );
}

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
      state: submitted?.state,
      endCause: submitted?.endCause,
      completion: submitted?.completion,
    };
  });
}

export function compareChatSendSubmittedInput(
  request: Pick<
    NormalizedChatSendRequest,
    | "requestIdentity"
    | "rawMessage"
    | "mentions"
    | "workContext"
    | "appContext"
    | "activeSteer"
    | "p"
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
    return request.activeSteer ||
      request.mentions?.length ||
      request.workContext ||
      request.appContext
      ? "unverifiable"
      : false;
  }
  const storedSteer = asOptionalRecord(submitted["__openclaw"]?.activeSteer);
  if (request.activeSteer) {
    // Active-only receipts must match their exact operation even without an HMAC.
    if (
      !storedSteer ||
      typeof storedSteer.profileId !== "string" ||
      typeof storedSteer.sessionId !== "string" ||
      typeof storedSteer.runId !== "string"
    ) {
      return "unverifiable";
    }
    if (
      storedSteer.profileId !== request.activeSteer.profileId ||
      storedSteer.sessionId !== request.p.sessionId ||
      storedSteer.runId !== request.activeSteer.runId
    ) {
      return true;
    }
  } else if (storedSteer) {
    return true;
  }
  const storedIdentity = submitted["__openclaw"]?.chatRequestIdentity;
  if (typeof storedIdentity === "string") {
    return storedIdentity !== request.requestIdentity;
  }
  if (request.activeSteer) {
    // Never retain original plaintext to bypass hook redaction. Without a keyed
    // identity, only exact approved text can establish the original input.
    const storedText = extractTextFromChatContent(submitted.content, {
      joinWith: "\n",
      normalizeText: (text) => text,
    });
    return storedSteer?.textUnchanged === true && storedText === request.p.message
      ? false
      : "unverifiable";
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
    !storedContext &&
    !request.appContext &&
    !submitted["__openclaw"]?.appContext
  ) {
    return false;
  }
  return (
    storedText !== request.rawMessage ||
    !isDeepStrictEqual(storedMentions ?? [], request.mentions ?? []) ||
    !isDeepStrictEqual(storedContext, request.workContext) ||
    !isDeepStrictEqual(submitted["__openclaw"]?.appContext, request.appContext)
  );
}
