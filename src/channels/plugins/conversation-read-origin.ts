/**
 * Server-owned origin for one tool or message-action invocation.
 *
 * Missing and unknown values must remain delegated; callers must never derive
 * this from model arguments, provider parameters, config, or persisted state.
 */
export type ConversationReadInvocationOrigin = "delegated" | "direct-operator";

export const CONVERSATION_READ_POLICY_V1 = "current-or-configured-v1" as const;

export type ConversationReadPolicy = typeof CONVERSATION_READ_POLICY_V1;

export function normalizeConversationReadInvocationOrigin(
  value: unknown,
): ConversationReadInvocationOrigin {
  return value === "direct-operator" ? "direct-operator" : "delegated";
}

export function supportsConversationReadPolicyV1(value: unknown): value is ConversationReadPolicy {
  return value === CONVERSATION_READ_POLICY_V1;
}
