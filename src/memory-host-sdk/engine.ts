// Aggregate workspace contract for the memory engine surface.
// Keep focused subpaths preferred for new code.

export * from "./engine-foundation.js";
export * from "./engine-storage.js";
export * from "./engine-embeddings.js";
export * from "./engine-qmd.js";

/**
 * Re-anchoring validation: Ensures the current execution branch is still valid.
 * This utility should be called by the orchestrator after long-running tool phases
 * to verify that no new user messages have arrived in the session since the turn started.
 */
export async function validateTurnFreshness(
  sessionId: string,
  expectedLastMessageId: string,
  fetchLatestMessageId: (sid: string) => Promise<string>
): Promise<void> {
  const currentLatestId = await fetchLatestMessageId(sessionId);
  if (currentLatestId !== expectedLastMessageId) {
    throw new Error("STALE_CONVERSATION_BRANCH: A new user message was received during tool execution. Re-anchoring required.");
  }
}