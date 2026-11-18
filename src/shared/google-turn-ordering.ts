import type { AgentMessage } from "../agents/runtime/index.js";

export const GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT = "(session bootstrap)";

/** Shared eligibility before provider callbacks and after generic normalization. */
export function needsGoogleAssistantFirstOrdering(messages: readonly { role?: string }[]): boolean {
  return messages[0]?.role === "assistant";
}

/** Reference-preserving ordering owner for payload messages and detached replay facts. */
export function sanitizeGoogleAssistantFirstOrderingWithAdapter<T extends { role?: string }>(
  messages: T[],
  bootstrap: () => T,
): T[] {
  return needsGoogleAssistantFirstOrdering(messages) ? [bootstrap(), ...messages] : messages;
}

/** Add a synthetic user bootstrap when Google-style providers receive assistant-first turns. */
export function sanitizeGoogleAssistantFirstOrdering(messages: AgentMessage[]): AgentMessage[] {
  return sanitizeGoogleAssistantFirstOrderingWithAdapter(messages, () => ({
    role: "user",
    content: GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT,
    timestamp: Date.now(),
  }));
}
