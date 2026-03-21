/**
 * Config resolution for auto-topic-label feature.
 * Kept separate from LLM logic to avoid heavy transitive dependencies in tests.
 */
import type { AutoTopicLabelConfig } from "../../config/types.telegram.js";

export const AUTO_TOPIC_LABEL_DEFAULT_PROMPT =
  "Generate a short topic label (max 50 chars) for a chat conversation based on the user's first message below. Start with a relevant emoji. Use the same language as the message. Be concise and descriptive. Return ONLY the topic name, nothing else.";

/**
 * Resolve whether auto topic labeling is enabled and get the prompt.
 * Returns null if disabled.
 */
export function resolveAutoTopicLabelConfig(
  directConfig?: AutoTopicLabelConfig,
  accountConfig?: AutoTopicLabelConfig,
): { enabled: true; prompt: string } | null {
  // Per-DM config takes priority over account-level config.
  const config = directConfig ?? accountConfig;

  // Default: enabled (when config is undefined, treat as true).
  if (config === undefined || config === true) {
    return { enabled: true, prompt: AUTO_TOPIC_LABEL_DEFAULT_PROMPT };
  }
  if (config === false) {
    return null;
  }
  // Object form.
  if (config.enabled === false) {
    return null;
  }
  return {
    enabled: true,
    prompt: config.prompt?.trim() || AUTO_TOPIC_LABEL_DEFAULT_PROMPT,
  };
}
