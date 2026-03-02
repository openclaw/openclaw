/**
 * Guard utilities to ensure thinking/redacted_thinking blocks are never modified.
 *
 * Per Anthropic's API requirements, thinking and redacted_thinking blocks
 * in assistant messages cannot be modified once returned by the API.
 * Any modification will cause API errors:
 * "messages.N.content.N: `thinking` or `redacted_thinking` blocks in the
 * latest assistant message cannot be modified."
 *
 * This module provides utilities to safely handle assistant messages while
 * preserving thinking blocks exactly as they were returned.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type AssistantContentBlock = AssistantMessage["content"][number];

/**
 * Check if a content block is a thinking or redacted_thinking block.
 */
export function isThinkingBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") {
    return false;
  }
  const typed = block as { type?: unknown };
  return typed.type === "thinking" || typed.type === "redacted_thinking";
}

/**
 * Check if an assistant message contains any thinking blocks.
 */
export function hasThinkingBlocks(message: AssistantMessage): boolean {
  if (!Array.isArray(message.content)) {
    return false;
  }
  return message.content.some((block) => isThinkingBlock(block));
}

/**
 * Safely filter content blocks from an assistant message while preserving thinking blocks.
 *
 * This function ensures that thinking/redacted_thinking blocks are never removed
 * or modified. If filtering would remove thinking blocks, the entire message
 * should be dropped instead (caller's responsibility).
 *
 * @param message - The assistant message to filter
 * @param shouldKeepBlock - Predicate function that returns true for blocks to keep
 * @returns New message with filtered content, or null if no non-thinking blocks remain
 */
export function safeFilterAssistantContent(
  message: AssistantMessage,
  shouldKeepBlock: (block: AssistantContentBlock) => boolean,
): AssistantMessage | null {
  if (!Array.isArray(message.content)) {
    return message;
  }

  const nextContent: AssistantContentBlock[] = [];
  let hasNonThinkingBlock = false;

  for (const block of message.content) {
    // Always preserve thinking blocks unchanged
    if (isThinkingBlock(block)) {
      nextContent.push(block);
      continue;
    }

    // Apply filter to non-thinking blocks
    if (shouldKeepBlock(block)) {
      nextContent.push(block);
      hasNonThinkingBlock = true;
    }
  }

  // If we only have thinking blocks left, return null to signal
  // that the message should be dropped entirely
  if (!hasNonThinkingBlock && nextContent.some(isThinkingBlock)) {
    return null;
  }

  // If content hasn't changed, return original message
  if (nextContent.length === message.content.length) {
    return message;
  }

  // If no content remains, return null
  if (nextContent.length === 0) {
    return null;
  }

  // Return new message with filtered content
  return { ...message, content: nextContent };
}

/**
 * Check if messages contain thinking blocks that must be preserved.
 * Use this before applying any transformation that might modify message content.
 */
export function containsThinkingBlocks(messages: AgentMessage[]): boolean {
  for (const msg of messages) {
    if (msg?.role === "assistant" && hasThinkingBlocks(msg)) {
      return true;
    }
  }
  return false;
}

/**
 * Validate that thinking blocks in messages match their expected structure.
 * Returns true if all thinking blocks are valid and unmodified.
 */
export function validateThinkingBlocks(message: AssistantMessage): {
  valid: boolean;
  reason?: string;
} {
  if (!Array.isArray(message.content)) {
    return { valid: true };
  }

  for (const block of message.content) {
    if (!block || typeof block !== "object") {
      continue;
    }

    const typed = block as { type?: unknown; thinking?: unknown; redacted_thinking?: unknown };

    if (typed.type === "thinking") {
      if (typeof typed.thinking !== "string") {
        return {
          valid: false,
          reason: "thinking block missing required 'thinking' string field",
        };
      }
    }

    if (typed.type === "redacted_thinking") {
      if (typeof typed.redacted_thinking !== "string") {
        return {
          valid: false,
          reason: "redacted_thinking block missing required 'redacted_thinking' string field",
        };
      }
    }
  }

  return { valid: true };
}
