import type { AgentMessage } from "../agents/runtime/index.js";

const GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT = "(session bootstrap)";

/** Add a synthetic user bootstrap when Google-style providers receive assistant-first turns. */
export function sanitizeGoogleAssistantFirstOrdering(messages: AgentMessage[]): AgentMessage[] {
  if (messages[0]?.role !== "assistant") {
    return messages;
  }

  // Google chat APIs reject assistant-first transcripts. The bootstrap marker
  // makes the mutation idempotent while preserving the original assistant turn.
  const bootstrap: AgentMessage = {
    role: "user",
    content: GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT,
    timestamp: Date.now(),
  };

  return [bootstrap, ...messages];
}
