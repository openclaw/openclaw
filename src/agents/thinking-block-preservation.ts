/**
 * Thinking Block Preservation for Anthropic API Compatibility
 *
 * Anthropic's API requires that `thinking` and `redacted_thinking` blocks in the
 * LATEST assistant message remain byte-for-byte identical to the original response.
 * These blocks contain cryptographic signatures that are validated server-side.
 *
 * This module provides utilities to:
 * 1. Extract thinking blocks before compaction/modification
 * 2. Restore them exactly after processing
 * 3. Validate that preservation was successful
 *
 * @see https://github.com/openclaw/openclaw/issues/30157
 * @see https://platform.claude.com/docs/en/build-with-claude/extended-thinking
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("thinking-block-preservation");

// ============================================================================
// Types
// ============================================================================

/**
 * A thinking or redacted_thinking content block from an assistant message.
 * We preserve ALL fields to ensure byte-for-byte compatibility.
 */
export type ThinkingBlock = {
  type: "thinking" | "redacted_thinking";
  /** The visible thinking text (for `thinking` type) */
  thinking?: string;
  /** Cryptographic signature validating the block */
  signature?: string;
  /** Encrypted data (for `redacted_thinking` type) */
  data?: string;
  /** Preserve any additional/future fields */
  [key: string]: unknown;
};

/**
 * Snapshot of thinking blocks from the latest assistant message.
 */
export type ThinkingBlockSnapshot = {
  /** Index of the assistant message in the original array */
  messageIndex: number;
  /** Complete thinking blocks, preserved exactly */
  blocks: ThinkingBlock[];
  /** Content array length for validation */
  originalContentLength: number;
  /** Hash of the serialized blocks for quick comparison */
  hash: string;
};

/**
 * State container for preserved thinking blocks.
 */
export type PreservedThinkingState = {
  /** The snapshot, or null if nothing to preserve */
  snapshot: ThinkingBlockSnapshot | null;
  /** Provider that was active when snapshot was taken */
  provider: string;
  /** Timestamp for debugging */
  capturedAt: number;
};

/**
 * Result of validation check.
 */
export type ThinkingBlockValidation = {
  valid: boolean;
  error?: string;
  details?: {
    expectedBlocks: number;
    actualBlocks: number;
    hashMatch: boolean;
  };
};

// ============================================================================
// Provider Detection
// ============================================================================

/**
 * Providers that require thinking block preservation.
 * Anthropic-family providers validate thinking block signatures server-side.
 */
const ANTHROPIC_FAMILY_PROVIDERS = new Set([
  "anthropic",
  "amazon-bedrock",
  "bedrock",
]);

const ANTHROPIC_FAMILY_PATTERNS = [
  /anthropic/i,
  /bedrock/i,
  /claude/i, // Some providers use "claude" in the provider name
];

/**
 * Check if a provider requires thinking block preservation.
 */
export function requiresThinkingBlockPreservation(provider: string | null | undefined): boolean {
  if (!provider) return false;

  const normalized = provider.toLowerCase().trim();

  // Check exact matches first (fast path)
  if (ANTHROPIC_FAMILY_PROVIDERS.has(normalized)) {
    return true;
  }

  // Check patterns for derived/proxied providers
  return ANTHROPIC_FAMILY_PATTERNS.some((pattern) => pattern.test(normalized));
}

// ============================================================================
// Block Detection
// ============================================================================

/**
 * Check if a content block is a thinking or redacted_thinking block.
 */
function isThinkingBlock(block: unknown): block is ThinkingBlock {
  if (!block || typeof block !== "object") return false;

  const type = (block as { type?: unknown }).type;
  return type === "thinking" || type === "redacted_thinking";
}

/**
 * Deep clone a thinking block to ensure we preserve the exact original.
 * Using JSON parse/stringify for true isolation.
 */
function cloneThinkingBlock(block: ThinkingBlock): ThinkingBlock {
  return JSON.parse(JSON.stringify(block));
}

/**
 * Create a hash of thinking blocks for quick comparison.
 * Uses JSON serialization - stable for our use case.
 */
function hashThinkingBlocks(blocks: ThinkingBlock[]): string {
  const serialized = JSON.stringify(blocks);
  // Simple hash for comparison (not cryptographic)
  let hash = 0;
  for (let i = 0; i < serialized.length; i++) {
    const char = serialized.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return `tb-${Math.abs(hash).toString(36)}`;
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Extract thinking blocks from the LATEST assistant message.
 *
 * This must be called BEFORE any compaction or message modification.
 * The returned state should be passed to `restoreLatestAssistantThinkingBlocks`
 * after processing is complete.
 *
 * @param messages - The current message array
 * @param provider - The active provider (e.g., "anthropic")
 * @returns State object containing the snapshot (or null if nothing to preserve)
 */
export function extractLatestAssistantThinkingBlocks(
  messages: AgentMessage[],
  provider: string,
): PreservedThinkingState {
  const result: PreservedThinkingState = {
    snapshot: null,
    provider,
    capturedAt: Date.now(),
  };

  // Fast path: skip if provider doesn't need preservation
  if (!requiresThinkingBlockPreservation(provider)) {
    log.debug(`Skipping thinking block extraction: provider "${provider}" doesn't require it`);
    return result;
  }

  // Find the LAST assistant message (working backwards)
  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && typeof msg === "object" && msg.role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }

  if (lastAssistantIndex === -1) {
    log.debug("No assistant message found for thinking block extraction");
    return result;
  }

  const assistant = messages[lastAssistantIndex] as Extract<AgentMessage, { role: "assistant" }>;

  // Check for content array
  if (!Array.isArray(assistant.content)) {
    log.debug("Assistant message has no content array");
    return result;
  }

  // Extract all thinking/redacted_thinking blocks
  const thinkingBlocks: ThinkingBlock[] = [];
  for (const block of assistant.content) {
    if (isThinkingBlock(block)) {
      thinkingBlocks.push(cloneThinkingBlock(block));
    }
  }

  if (thinkingBlocks.length === 0) {
    log.debug("No thinking blocks found in latest assistant message");
    return result;
  }

  const hash = hashThinkingBlocks(thinkingBlocks);

  result.snapshot = {
    messageIndex: lastAssistantIndex,
    blocks: thinkingBlocks,
    originalContentLength: assistant.content.length,
    hash,
  };

  log.info(
    `Extracted ${thinkingBlocks.length} thinking block(s) from message index ${lastAssistantIndex} ` +
    `(hash: ${hash}, provider: ${provider})`
  );

  return result;
}

/**
 * Restore preserved thinking blocks to the latest assistant message.
 *
 * This must be called AFTER compaction or message modification completes.
 * It ensures the thinking blocks in the latest assistant message match
 * the original exactly.
 *
 * @param messages - The (possibly modified) message array
 * @param preserved - The state returned by `extractLatestAssistantThinkingBlocks`
 * @returns The message array with thinking blocks restored (may be same reference if unchanged)
 */
export function restoreLatestAssistantThinkingBlocks(
  messages: AgentMessage[],
  preserved: PreservedThinkingState,
): AgentMessage[] {
  // Nothing to restore
  if (!preserved.snapshot) {
    return messages;
  }

  // Provider changed or doesn't need preservation
  if (!requiresThinkingBlockPreservation(preserved.provider)) {
    return messages;
  }

  // Find the LAST assistant message in the (possibly modified) array
  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && typeof msg === "object" && msg.role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }

  if (lastAssistantIndex === -1) {
    log.warn(
      "Cannot restore thinking blocks: no assistant message found. " +
      "The latest assistant message may have been removed during compaction."
    );
    return messages;
  }

  const assistant = messages[lastAssistantIndex] as Extract<AgentMessage, { role: "assistant" }>;

  if (!Array.isArray(assistant.content)) {
    log.warn("Cannot restore thinking blocks: assistant has no content array");
    return messages;
  }

  // Check if current thinking blocks already match
  const currentThinking = assistant.content.filter(isThinkingBlock);
  const currentHash = hashThinkingBlocks(currentThinking as ThinkingBlock[]);

  if (currentHash === preserved.snapshot.hash) {
    log.debug("Thinking blocks already match preserved snapshot (hash: " + currentHash + ")");
    return messages;
  }

  log.info(
    `Restoring thinking blocks: current hash ${currentHash} differs from preserved ${preserved.snapshot.hash}`
  );

  // Remove any existing thinking blocks and prepend the preserved ones
  // This ensures the preserved blocks come first (matching Anthropic's expected order)
  const nonThinkingContent = assistant.content.filter((block) => !isThinkingBlock(block));

  const restoredContent = [
    // Deep clone preserved blocks to avoid mutations
    ...preserved.snapshot.blocks.map(cloneThinkingBlock),
    ...nonThinkingContent,
  ];

  const restoredAssistant = {
    ...assistant,
    content: restoredContent,
  };

  // Create new array with restored assistant
  const result = [...messages];
  result[lastAssistantIndex] = restoredAssistant as AgentMessage;

  log.info(
    `Restored ${preserved.snapshot.blocks.length} thinking block(s) to message index ${lastAssistantIndex}`
  );

  return result;
}

/**
 * Validate that thinking blocks in the latest assistant message match the preserved state.
 *
 * @param messages - The message array to validate
 * @param preserved - The original preserved state
 * @returns Validation result with details
 */
export function validateThinkingBlockPreservation(
  messages: AgentMessage[],
  preserved: PreservedThinkingState,
): ThinkingBlockValidation {
  if (!preserved.snapshot) {
    return { valid: true };
  }

  if (!requiresThinkingBlockPreservation(preserved.provider)) {
    return { valid: true };
  }

  // Find latest assistant
  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }

  if (lastAssistantIndex === -1) {
    return {
      valid: false,
      error: "Latest assistant message was removed during processing",
      details: {
        expectedBlocks: preserved.snapshot.blocks.length,
        actualBlocks: 0,
        hashMatch: false,
      },
    };
  }

  const assistant = messages[lastAssistantIndex];
  const content = (assistant as { content?: unknown[] }).content;

  if (!Array.isArray(content)) {
    return {
      valid: false,
      error: "Latest assistant message has no content array",
      details: {
        expectedBlocks: preserved.snapshot.blocks.length,
        actualBlocks: 0,
        hashMatch: false,
      },
    };
  }

  const currentThinking = content.filter(isThinkingBlock) as ThinkingBlock[];
  const currentHash = hashThinkingBlocks(currentThinking);
  const hashMatch = currentHash === preserved.snapshot.hash;

  if (!hashMatch) {
    return {
      valid: false,
      error: "Thinking blocks in latest assistant message were modified",
      details: {
        expectedBlocks: preserved.snapshot.blocks.length,
        actualBlocks: currentThinking.length,
        hashMatch: false,
      },
    };
  }

  return {
    valid: true,
    details: {
      expectedBlocks: preserved.snapshot.blocks.length,
      actualBlocks: currentThinking.length,
      hashMatch: true,
    },
  };
}

/**
 * Wrapper function for compaction operations.
 *
 * Automatically extracts thinking blocks before the operation and
 * restores them after. Use this to wrap any function that might
 * modify the message array in a way that could corrupt thinking blocks.
 *
 * @param messages - The input message array
 * @param provider - The active provider
 * @param operation - The async operation that may modify messages
 * @returns The operation result with thinking blocks preserved
 */
export async function withThinkingBlockPreservation<T extends { messages: AgentMessage[] }>(
  messages: AgentMessage[],
  provider: string,
  operation: (messages: AgentMessage[]) => Promise<T>,
): Promise<T> {
  const preserved = extractLatestAssistantThinkingBlocks(messages, provider);

  const result = await operation(messages);

  if (preserved.snapshot) {
    result.messages = restoreLatestAssistantThinkingBlocks(result.messages, preserved);

    // Validate restoration
    const validation = validateThinkingBlockPreservation(result.messages, preserved);
    if (!validation.valid) {
      log.error(`Thinking block restoration failed: ${validation.error}`, validation.details);
    }
  }

  return result;
}

/**
 * Synchronous version of withThinkingBlockPreservation for operations
 * that don't need async.
 */
export function withThinkingBlockPreservationSync<T extends { messages: AgentMessage[] }>(
  messages: AgentMessage[],
  provider: string,
  operation: (messages: AgentMessage[]) => T,
): T {
  const preserved = extractLatestAssistantThinkingBlocks(messages, provider);

  const result = operation(messages);

  if (preserved.snapshot) {
    result.messages = restoreLatestAssistantThinkingBlocks(result.messages, preserved);

    const validation = validateThinkingBlockPreservation(result.messages, preserved);
    if (!validation.valid) {
      log.error(`Thinking block restoration failed: ${validation.error}`, validation.details);
    }
  }

  return result;
}
