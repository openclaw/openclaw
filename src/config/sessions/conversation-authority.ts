import type { ConversationAuthority } from "./conversation-authority.types.js";
import type { ConversationRecord } from "./conversation-registry.types.js";
import { resolveConversationRouteFingerprint } from "./conversation-route-fingerprint.js";

/** The reader or transaction supplies current rows; captured fingerprints alone grant nothing. */
export function assertConversationAuthority(
  conversation: ConversationRecord | undefined,
  expected: ConversationAuthority,
): asserts conversation is ConversationRecord {
  if (
    !conversation ||
    conversation.conversationRef !== expected.conversationRef ||
    resolveConversationRouteFingerprint(conversation) !== expected.expectedRouteFingerprint ||
    (expected.expectedSessionId !== undefined &&
      conversation.sessionId !== expected.expectedSessionId) ||
    (expected.expectedSessionKey !== undefined &&
      conversation.sessionKey !== expected.expectedSessionKey)
  ) {
    const error = new Error(
      `Conversation is no longer available to this agent: ${expected.conversationRef}`,
    );
    error.name = "ConversationAuthorityError";
    throw error;
  }
}
