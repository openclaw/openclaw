const TRANSCRIPT_ONLY_OPENCLAW_ASSISTANT_MODELS = new Set(["delivery-mirror", "gateway-injected"]);

export function isTranscriptOnlyOpenClawAssistantMessage(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }
  const entry = message as Record<string, unknown>;
  return (
    entry.role === "assistant" &&
    entry.provider === "openclaw" &&
    typeof entry.model === "string" &&
    TRANSCRIPT_ONLY_OPENCLAW_ASSISTANT_MODELS.has(entry.model)
  );
}

export function filterTranscriptOnlyOpenClawAssistantMessages<T>(messages: T[]): T[] {
  return messages.some(isTranscriptOnlyOpenClawAssistantMessage)
    ? messages.filter((message) => !isTranscriptOnlyOpenClawAssistantMessage(message))
    : messages;
}
