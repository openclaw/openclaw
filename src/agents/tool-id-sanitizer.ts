/**
 * Tool ID sanitization for Claude model compatibility.
 *
 * Claude (especially Opus 4.6) requires tool_use.id to match pattern: ^[a-zA-Z0-9_-]+$
 * Other models (e.g., Kimi K2.5) generate IDs with characters like : and | which are
 * valid for their APIs but not for Anthropic Claude.
 *
 * When OpenClaw switches models mid-session without sanitizing IDs, Claude rejects
 * the request with validation error.
 *
 * Solution: Sanitize tool IDs to match Claude's requirements when needed.
 */

/**
 * Check if model is from Anthropic (Claude family).
 */
export function isAnthropicModel(modelId?: string): boolean {
  if (!modelId) return false;
  const lower = modelId.toLowerCase();
  return (
    lower.includes("claude") ||
    lower.includes("anthropic") ||
    lower.startsWith("anthropic/")
  );
}

/**
 * Sanitize tool ID for Anthropic Claude compatibility.
 *
 * Claude requires: ^[a-zA-Z0-9_-]+$
 * This replaces invalid characters with underscore.
 *
 * Examples:
 *   "call_123|abc:def" → "call_123_abc_def"
 *   "550e8400-e29b-41d4-a716-446655440000" → unchanged (valid UUID)
 *   "call_123_abc_def" → unchanged (already valid)
 *   "<script>alert</script>" → "_script_alert_script_"
 */
export function sanitizeToolUseIdForAnthropic(id: string): string {
  if (!id) return id;
  // Replace any character that is NOT alphanumeric, underscore, or hyphen
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Process a message to sanitize tool_use IDs for Claude models.
 *
 * This is applied when:
 * 1. Target model is from Anthropic (Claude family)
 * 2. Message history contains tool_use content blocks from other models
 * 3. Before sending to Claude API
 */
export function sanitizeMessageForAnthropic(
  message: any,
  targetModelId?: string
): any {
  if (!isAnthropicModel(targetModelId) || !message || !message.content) {
    return message;
  }

  // Only process if content is an array of blocks
  if (!Array.isArray(message.content)) {
    return message;
  }

  // Create a shallow copy to avoid mutating original
  const sanitized = {
    ...message,
    content: message.content.map((block: any) => {
      // Sanitize tool_use blocks
      if (block.type === "tool_use" && block.id) {
        return {
          ...block,
          id: sanitizeToolUseIdForAnthropic(block.id),
        };
      }
      return block;
    }),
  };

  return sanitized;
}

/**
 * Process messages array to sanitize all tool_use IDs for Claude.
 */
export function sanitizeMessagesForAnthropic(
  messages: any[],
  targetModelId?: string
): any[] {
  if (!isAnthropicModel(targetModelId) || !messages || !Array.isArray(messages)) {
    return messages;
  }

  return messages.map((msg) => sanitizeMessageForAnthropic(msg, targetModelId));
}
