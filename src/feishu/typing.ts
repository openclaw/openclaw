import type { Client } from "@larksuiteoapi/node-sdk";
import { formatErrorMessage } from "../infra/errors.js";
import { getChildLogger } from "../logging.js";
import { addReactionFeishu, removeReactionFeishu, FeishuEmoji } from "./reactions.js";

const logger = getChildLogger({ module: "feishu-typing" });

/**
 * Typing indicator state
 */
export type TypingIndicatorState = {
  messageId: string;
  reactionId: string | null;
};

/**
 * Add a typing indicator (reaction) to a message.
 *
 * Feishu doesn't have a native typing indicator API, so we use emoji reactions
 * as a visual substitute. The "Typing" emoji provides immediate feedback to users.
 *
 * Requires permission: im:message.reaction:read_write
 */
export async function addTypingIndicator(
  client: Client,
  messageId: string,
): Promise<TypingIndicatorState> {
  try {
    const { reactionId } = await addReactionFeishu(client, messageId, FeishuEmoji.TYPING);
    logger.debug(`Added typing indicator reaction: ${reactionId}`);
    return { messageId, reactionId };
  } catch (err) {
    // Silently fail - typing indicator is not critical
    logger.debug(`Failed to add typing indicator: ${formatErrorMessage(err)}`);
    return { messageId, reactionId: null };
  }
}

/**
 * Remove a typing indicator (reaction) from a message.
 */
export async function removeTypingIndicator(
  client: Client,
  state: TypingIndicatorState,
): Promise<void> {
  if (!state.reactionId) {
    return;
  }

  try {
    await removeReactionFeishu(client, state.messageId, state.reactionId);
    logger.debug(`Removed typing indicator reaction: ${state.reactionId}`);
  } catch (err) {
    // Silently fail - cleanup is not critical
    logger.debug(`Failed to remove typing indicator: ${formatErrorMessage(err)}`);
  }
}

/**
 * Create typing indicator callbacks for use with reply dispatchers.
 * These callbacks automatically manage the typing indicator lifecycle.
 */
export function createTypingIndicatorCallbacks(
  client: Client,
  messageId: string | undefined,
): {
  state: { current: TypingIndicatorState | null };
  onReplyStart: () => Promise<void>;
  onIdle: () => Promise<void>;
} {
  const state: { current: TypingIndicatorState | null } = { current: null };

  return {
    state,
    onReplyStart: async () => {
      if (!messageId) {
        return;
      }
      state.current = await addTypingIndicator(client, messageId);
    },
    onIdle: async () => {
      if (!state.current) {
        return;
      }
      await removeTypingIndicator(client, state.current);
      state.current = null;
    },
  };
}
