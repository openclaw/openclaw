function matchesTrigger(bodyLower: string, triggers: string[]): boolean {
  for (const trigger of triggers) {
    if (!trigger) {
      continue;
    }
    const triggerLower = trigger.toLowerCase();
    if (bodyLower === triggerLower) {
      return true;
    }
    if (bodyLower.startsWith(`${triggerLower} `)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a message body matches any liveness trigger.
 * Accepts an optional mention-stripped body for group-chat support.
 */
export function checkLivenessTrigger(
  body: string,
  triggers: string[],
  mentionStrippedBody?: string,
): boolean {
  const trimmedBodyLower = body.trim().toLowerCase();
  if (matchesTrigger(trimmedBodyLower, triggers)) {
    return true;
  }
  if (mentionStrippedBody) {
    const strippedLower = mentionStrippedBody.trim().toLowerCase();
    if (strippedLower !== trimmedBodyLower && matchesTrigger(strippedLower, triggers)) {
      return true;
    }
  }
  return false;
}

export function buildLivenessResponse(): string {
  return "✅ Online";
}
