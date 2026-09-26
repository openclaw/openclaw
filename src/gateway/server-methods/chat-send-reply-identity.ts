import { copyReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import type { ReplyDispatchOperation } from "../../auto-reply/reply/reply-dispatcher.types.js";
import {
  applyAssistantDeliveryDirectives,
  type PrepareAssistantTranscriptMessage,
} from "../../config/sessions/transcript-assistant-delivery.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { extractAssistantPhaseText } from "../../shared/chat-message-content.js";
import { parseInlineDirectives, sanitizeReplyDirectiveId } from "../../utils/directive-tags.js";
import { loadSessionEntry } from "../session-utils.js";
import {
  readChatSendReplyPayload,
  replaceChatSendReplyPayload,
} from "./chat-send-command-replies.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";

/** Webchat run ids are transport correlation, never transcript reply targets. */
function resolveChatSendReplyInputIdentity(
  input: ReplyDispatchOperation,
  source: { runId: string; originatingRunId?: string; messageId?: string },
): ReplyDispatchOperation[] {
  const payload = readChatSendReplyPayload(input);
  // Prepared text is literal. Only the raw adapter owns inline directive parsing.
  const parsed =
    input.kind === "raw" && payload.text?.includes("[[")
      ? parseInlineDirectives(payload.text, {
          stripAudioTag: false,
          preserveTrailingWhitespace: true,
        })
      : undefined;
  const replyToId = sanitizeReplyDirectiveId(payload.replyToId) ?? parsed?.replyToExplicitId;
  if (!replyToId || (replyToId !== source.runId && replyToId !== source.originatingRunId)) {
    return [input];
  }
  const next = copyReplyPayloadMetadata(payload, {
    ...payload,
    ...(parsed?.hasReplyTag ? { text: parsed.text } : {}),
    replyToId: source.messageId,
    replyToCurrent: false,
  });
  return replaceChatSendReplyPayload(input, next);
}

export function createChatSendReplyIdentityResolver(params: {
  session: Pick<
    PreparedChatSendSession,
    "agentId" | "clientRunId" | "sessionKey" | "sessionLoadOptions"
  >;
  userTurnRecorder: Pick<UserTurnTranscriptRecorder, "getAdmissionReceipt" | "getPersistedMessage">;
  getAgentRunId: () => string;
}) {
  const { session, userTurnRecorder } = params;
  const { clientRunId } = session;
  const sessionLoadOptions = { ...session.sessionLoadOptions, clone: false };
  const resolveSourceMessageId = () => {
    const admission = userTurnRecorder.getAdmissionReceipt();
    const source = userTurnRecorder.getPersistedMessage?.();
    if (
      !admission ||
      !source ||
      source.display === false ||
      admission.agentId !== session.agentId ||
      admission.sessionKey !== session.sessionKey
    ) {
      return undefined;
    }
    const current = loadSessionEntry(session.sessionKey, sessionLoadOptions);
    return current.entry?.sessionId === admission.sessionId ? admission.entryId : undefined;
  };
  const resolveReplyInputs = (
    input: ReplyDispatchOperation,
    runId = params.getAgentRunId(),
    settled = false,
  ) =>
    !settled && !userTurnRecorder.getAdmissionReceipt()
      ? [input]
      : resolveChatSendReplyInputIdentity(input, {
          runId,
          originatingRunId: clientRunId,
          messageId: resolveSourceMessageId(),
        });

  const prepareTranscriptIdentity = (message: Parameters<PrepareAssistantTranscriptMessage>[0]) => {
    const agentRunId = params.getAgentRunId();
    const parsed = parseInlineDirectives(extractAssistantPhaseText(message) ?? "");
    const replyToId = message.openclawDelivery?.replyToId ?? parsed.replyToExplicitId;
    if (replyToId === clientRunId || replyToId === agentRunId) {
      // Persist the same canonical reference used for live delivery. Never guess
      // another input when this turn was hidden, blocked, or no longer bound.
      applyAssistantDeliveryDirectives(message);
      const facts = { ...message.openclawDelivery };
      delete facts.replyToCurrent;
      delete facts.replyToId;
      const messageId = resolveSourceMessageId();
      if (messageId) {
        facts.replyToId = messageId;
      }
      message.openclawDelivery = facts;
    }

    return message;
  };
  return { resolveReplyInputs, prepareTranscriptIdentity };
}
