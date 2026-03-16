/**
 * Tests for thinking block preservation utilities.
 *
 * These tests verify that thinking/redacted_thinking blocks are correctly
 * preserved through compaction and other message modifications.
 */

import { describe, it, expect } from "vitest";
import {
  extractLatestAssistantThinkingBlocks,
  restoreLatestAssistantThinkingBlocks,
  validateThinkingBlockPreservation,
  requiresThinkingBlockPreservation,
  withThinkingBlockPreservationSync,
} from "./thinking-block-preservation.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

// ============================================================================
// Test Helpers
// ============================================================================

function createUserMessage(content: string): AgentMessage {
  return {
    role: "user",
    content,
    timestamp: Date.now(),
  } as AgentMessage;
}

function createAssistantMessage(
  content: Array<{ type: string; [key: string]: unknown }>,
): AgentMessage {
  return {
    role: "assistant",
    content,
    timestamp: Date.now(),
  } as AgentMessage;
}

function createThinkingBlock(thinking: string, signature: string) {
  return { type: "thinking", thinking, signature };
}

function createRedactedThinkingBlock(data: string) {
  return { type: "redacted_thinking", data };
}

function createTextBlock(text: string) {
  return { type: "text", text };
}

// ============================================================================
// Provider Detection Tests
// ============================================================================

describe("requiresThinkingBlockPreservation", () => {
  it("returns true for anthropic provider", () => {
    expect(requiresThinkingBlockPreservation("anthropic")).toBe(true);
  });

  it("returns true for amazon-bedrock provider", () => {
    expect(requiresThinkingBlockPreservation("amazon-bedrock")).toBe(true);
  });

  it("returns true for bedrock provider", () => {
    expect(requiresThinkingBlockPreservation("bedrock")).toBe(true);
  });

  it("returns true for anthropic-compatible providers", () => {
    expect(requiresThinkingBlockPreservation("anthropic-proxy")).toBe(true);
    expect(requiresThinkingBlockPreservation("my-anthropic-endpoint")).toBe(true);
  });

  it("returns false for openai provider", () => {
    expect(requiresThinkingBlockPreservation("openai")).toBe(false);
  });

  it("returns false for google provider", () => {
    expect(requiresThinkingBlockPreservation("google")).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(requiresThinkingBlockPreservation(null)).toBe(false);
    expect(requiresThinkingBlockPreservation(undefined)).toBe(false);
  });

  it("handles case insensitivity", () => {
    expect(requiresThinkingBlockPreservation("ANTHROPIC")).toBe(true);
    expect(requiresThinkingBlockPreservation("Anthropic")).toBe(true);
    expect(requiresThinkingBlockPreservation("AnThRoPiC")).toBe(true);
  });
});

// ============================================================================
// Extraction Tests
// ============================================================================

describe("extractLatestAssistantThinkingBlocks", () => {
  it("extracts thinking blocks from last assistant message", () => {
    const messages: AgentMessage[] = [
      createUserMessage("Hello"),
      createAssistantMessage([
        createThinkingBlock("Let me think about this...", "sig_abc123"),
        createTextBlock("Here's my response"),
      ]),
    ];

    const result = extractLatestAssistantThinkingBlocks(messages, "anthropic");

    expect(result.snapshot).not.toBeNull();
    expect(result.snapshot!.blocks).toHaveLength(1);
    expect(result.snapshot!.blocks[0].type).toBe("thinking");
    expect(result.snapshot!.blocks[0].thinking).toBe("Let me think about this...");
    expect(result.snapshot!.blocks[0].signature).toBe("sig_abc123");
  });

  it("extracts redacted_thinking blocks", () => {
    const messages: AgentMessage[] = [
      createAssistantMessage([
        createRedactedThinkingBlock("encrypted_blob_data"),
        createTextBlock("Response"),
      ]),
    ];

    const result = extractLatestAssistantThinkingBlocks(messages, "anthropic");

    expect(result.snapshot).not.toBeNull();
    expect(result.snapshot!.blocks[0].type).toBe("redacted_thinking");
    expect(result.snapshot!.blocks[0].data).toBe("encrypted_blob_data");
  });

  it("extracts multiple thinking blocks", () => {
    const messages: AgentMessage[] = [
      createAssistantMessage([
        createThinkingBlock("First thought", "sig1"),
        createThinkingBlock("Second thought", "sig2"),
        createRedactedThinkingBlock("redacted"),
        createTextBlock("Final answer"),
      ]),
    ];

    const result = extractLatestAssistantThinkingBlocks(messages, "anthropic");

    expect(result.snapshot!.blocks).toHaveLength(3);
    expect(result.snapshot!.blocks[0].thinking).toBe("First thought");
    expect(result.snapshot!.blocks[1].thinking).toBe("Second thought");
    expect(result.snapshot!.blocks[2].type).toBe("redacted_thinking");
  });

  it("only extracts from the LAST assistant message", () => {
    const messages: AgentMessage[] = [
      createAssistantMessage([
        createThinkingBlock("Old thinking", "old_sig"),
        createTextBlock("Old response"),
      ]),
      createUserMessage("Follow up"),
      createAssistantMessage([
        createThinkingBlock("New thinking", "new_sig"),
        createTextBlock("New response"),
      ]),
    ];

    const result = extractLatestAssistantThinkingBlocks(messages, "anthropic");

    expect(result.snapshot!.blocks).toHaveLength(1);
    expect(result.snapshot!.blocks[0].thinking).toBe("New thinking");
    expect(result.snapshot!.blocks[0].signature).toBe("new_sig");
    expect(result.snapshot!.messageIndex).toBe(2);
  });

  it("returns null snapshot for non-anthropic providers", () => {
    const messages: AgentMessage[] = [
      createAssistantMessage([
        createThinkingBlock("Thinking", "sig"),
        createTextBlock("Response"),
      ]),
    ];

    const result = extractLatestAssistantThinkingBlocks(messages, "openai");

    expect(result.snapshot).toBeNull();
    expect(result.provider).toBe("openai");
  });

  it("returns null snapshot when no assistant messages exist", () => {
    const messages: AgentMessage[] = [
      createUserMessage("Hello"),
    ];

    const result = extractLatestAssistantThinkingBlocks(messages, "anthropic");

    expect(result.snapshot).toBeNull();
  });

  it("returns null snapshot when assistant has no thinking blocks", () => {
    const messages: AgentMessage[] = [
      createAssistantMessage([
        createTextBlock("Just a simple response"),
      ]),
    ];

    const result = extractLatestAssistantThinkingBlocks(messages, "anthropic");

    expect(result.snapshot).toBeNull();
  });

  it("preserves additional/unknown fields in thinking blocks", () => {
    const messages: AgentMessage[] = [
      createAssistantMessage([
        {
          type: "thinking",
          thinking: "Deep thought",
          signature: "sig",
          customField: "custom_value",
          nestedObject: { a: 1, b: 2 },
        },
        createTextBlock("Response"),
      ]),
    ];

    const result = extractLatestAssistantThinkingBlocks(messages, "anthropic");

    expect(result.snapshot!.blocks[0].customField).toBe("custom_value");
    expect(result.snapshot!.blocks[0].nestedObject).toEqual({ a: 1, b: 2 });
  });

  it("deep clones blocks to prevent mutation", () => {
    const originalBlock = createThinkingBlock("Original", "sig");
    const messages: AgentMessage[] = [
      createAssistantMessage([originalBlock, createTextBlock("Response")]),
    ];

    const result = extractLatestAssistantThinkingBlocks(messages, "anthropic");

    // Mutate the extracted block
    result.snapshot!.blocks[0].thinking = "Modified";

    // Original should be unchanged
    expect(originalBlock.thinking).toBe("Original");
  });
});

// ============================================================================
// Restoration Tests
// ============================================================================

describe("restoreLatestAssistantThinkingBlocks", () => {
  it("restores missing thinking blocks", () => {
    // Original message with thinking
    const originalMessages: AgentMessage[] = [
      createAssistantMessage([
        createThinkingBlock("Important reasoning", "crypto_sig_123"),
        createTextBlock("My response"),
      ]),
    ];

    const preserved = extractLatestAssistantThinkingBlocks(originalMessages, "anthropic");

    // Simulate compaction removing thinking blocks
    const modifiedMessages: AgentMessage[] = [
      createAssistantMessage([
        createTextBlock("My response"),
      ]),
    ];

    const restored = restoreLatestAssistantThinkingBlocks(modifiedMessages, preserved);

    expect(restored[0].content).toHaveLength(2);
    expect(restored[0].content[0].type).toBe("thinking");
    expect(restored[0].content[0].thinking).toBe("Important reasoning");
    expect(restored[0].content[0].signature).toBe("crypto_sig_123");
  });

  it("returns same reference when blocks already match", () => {
    const messages: AgentMessage[] = [
      createAssistantMessage([
        createThinkingBlock("Thinking", "sig"),
        createTextBlock("Response"),
      ]),
    ];

    const preserved = extractLatestAssistantThinkingBlocks(messages, "anthropic");

    // Pass the same messages through restoration
    const result = restoreLatestAssistantThinkingBlocks(messages, preserved);

    // Should be the same reference (no changes needed)
    expect(result).toBe(messages);
  });

  it("restores blocks when signature was corrupted", () => {
    const originalMessages: AgentMessage[] = [
      createAssistantMessage([
        createThinkingBlock("Thinking", "original_signature"),
        createTextBlock("Response"),
      ]),
    ];

    const preserved = extractLatestAssistantThinkingBlocks(originalMessages, "anthropic");

    // Simulate corruption of signature
    const corruptedMessages: AgentMessage[] = [
      createAssistantMessage([
        createThinkingBlock("Thinking", "corrupted_signature"),
        createTextBlock("Response"),
      ]),
    ];

    const restored = restoreLatestAssistantThinkingBlocks(corruptedMessages, preserved);

    expect(restored[0].content[0].signature).toBe("original_signature");
  });

  it("handles null snapshot gracefully", () => {
    const messages: AgentMessage[] = [
      createAssistantMessage([createTextBlock("Response")]),
    ];

    const preserved = {
      snapshot: null,
      provider: "anthropic",
      capturedAt: Date.now(),
    };

    const result = restoreLatestAssistantThinkingBlocks(messages, preserved);

    expect(result).toBe(messages);
  });

  it("handles non-anthropic provider gracefully", () => {
    const messages: AgentMessage[] = [
      createAssistantMessage([createTextBlock("Response")]),
    ];

    const preserved = {
      snapshot: {
        messageIndex: 0,
        blocks: [createThinkingBlock("Thinking", "sig") as any],
        originalContentLength: 2,
        hash: "tb-123",
      },
      provider: "openai",
      capturedAt: Date.now(),
    };

    const result = restoreLatestAssistantThinkingBlocks(messages, preserved);

    // Should not restore for non-anthropic provider
    expect(result).toBe(messages);
    expect(result[0].content).toHaveLength(1);
  });

  it("handles missing assistant message gracefully", () => {
    const preserved = {
      snapshot: {
        messageIndex: 0,
        blocks: [createThinkingBlock("Thinking", "sig") as any],
        originalContentLength: 2,
        hash: "tb-123",
      },
      provider: "anthropic",
      capturedAt: Date.now(),
    };

    const messagesWithoutAssistant: AgentMessage[] = [
      createUserMessage("Hello"),
    ];

    const result = restoreLatestAssistantThinkingBlocks(messagesWithoutAssistant, preserved);

    // Should return unchanged (can't restore without assistant)
    expect(result).toBe(messagesWithoutAssistant);
  });

  it("prepends thinking blocks before other content", () => {
    const originalMessages: AgentMessage[] = [
      createAssistantMessage([
        createThinkingBlock("Thinking", "sig"),
        createTextBlock("Response"),
      ]),
    ];

    const preserved = extractLatestAssistantThinkingBlocks(originalMessages, "anthropic");

    // Simulate modified message with extra content
    const modifiedMessages: AgentMessage[] = [
      createAssistantMessage([
        createTextBlock("Modified response"),
        { type: "tool_use", id: "tool_1", name: "test" },
      ]),
    ];

    const restored = restoreLatestAssistantThinkingBlocks(modifiedMessages, preserved);

    // Thinking should be first
    expect(restored[0].content[0].type).toBe("thinking");
    expect(restored[0].content[1].type).toBe("text");
    expect(restored[0].content[2].type).toBe("tool_use");
  });
});

// ============================================================================
// Validation Tests
// ============================================================================

describe("validateThinkingBlockPreservation", () => {
  it("returns valid for null snapshot", () => {
    const messages: AgentMessage[] = [
      createAssistantMessage([createTextBlock("Response")]),
    ];

    const preserved = {
      snapshot: null,
      provider: "anthropic",
      capturedAt: Date.now(),
    };

    const result = validateThinkingBlockPreservation(messages, preserved);

    expect(result.valid).toBe(true);
  });

  it("returns valid when blocks match", () => {
    const messages: AgentMessage[] = [
      createAssistantMessage([
        createThinkingBlock("Thinking", "sig"),
        createTextBlock("Response"),
      ]),
    ];

    const preserved = extractLatestAssistantThinkingBlocks(messages, "anthropic");

    const result = validateThinkingBlockPreservation(messages, preserved);

    expect(result.valid).toBe(true);
    expect(result.details?.hashMatch).toBe(true);
  });

  it("returns invalid when assistant message is missing", () => {
    const preserved = {
      snapshot: {
        messageIndex: 0,
        blocks: [createThinkingBlock("Thinking", "sig") as any],
        originalContentLength: 2,
        hash: "tb-123",
      },
      provider: "anthropic",
      capturedAt: Date.now(),
    };

    const messages: AgentMessage[] = [
      createUserMessage("Only user message"),
    ];

    const result = validateThinkingBlockPreservation(messages, preserved);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("removed");
  });

  it("returns invalid when thinking blocks were modified", () => {
    const originalMessages: AgentMessage[] = [
      createAssistantMessage([
        createThinkingBlock("Original thinking", "original_sig"),
        createTextBlock("Response"),
      ]),
    ];

    const preserved = extractLatestAssistantThinkingBlocks(originalMessages, "anthropic");

    const modifiedMessages: AgentMessage[] = [
      createAssistantMessage([
        createThinkingBlock("Modified thinking", "different_sig"),
        createTextBlock("Response"),
      ]),
    ];

    const result = validateThinkingBlockPreservation(modifiedMessages, preserved);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("modified");
    expect(result.details?.hashMatch).toBe(false);
  });
});

// ============================================================================
// Integration / Wrapper Tests
// ============================================================================

describe("withThinkingBlockPreservationSync", () => {
  it("preserves thinking blocks through modification", () => {
    const originalMessages: AgentMessage[] = [
      createUserMessage("Hello"),
      createAssistantMessage([
        createThinkingBlock("Deep reasoning here", "crypto_sig_xyz"),
        createTextBlock("My response"),
      ]),
    ];

    // Simulate a compaction-like operation that removes thinking blocks
    const result = withThinkingBlockPreservationSync(
      originalMessages,
      "anthropic",
      (messages) => {
        // Strip thinking blocks (simulating what compaction might do)
        const modified = messages.map((msg) => {
          if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
            return msg;
          }
          return {
            ...msg,
            content: msg.content.filter(
              (block: any) => block.type !== "thinking" && block.type !== "redacted_thinking"
            ),
          };
        }) as AgentMessage[];

        return { messages: modified };
      }
    );

    // Thinking blocks should be restored
    const lastAssistant = result.messages.find((m) => m.role === "assistant");
    expect(lastAssistant).toBeDefined();
    expect(lastAssistant!.content).toHaveLength(2);
    expect(lastAssistant!.content[0].type).toBe("thinking");
    expect(lastAssistant!.content[0].signature).toBe("crypto_sig_xyz");
  });

  it("handles operations that don't modify thinking blocks", () => {
    const messages: AgentMessage[] = [
      createAssistantMessage([
        createThinkingBlock("Thinking", "sig"),
        createTextBlock("Response"),
      ]),
    ];

    // Operation that doesn't touch thinking blocks
    const result = withThinkingBlockPreservationSync(
      messages,
      "anthropic",
      (msgs) => {
        return { messages: msgs };
      }
    );

    // Should return same reference
    expect(result.messages).toBe(messages);
  });

  it("skips preservation for non-anthropic providers", () => {
    const messages: AgentMessage[] = [
      createAssistantMessage([
        createThinkingBlock("Thinking", "sig"),
        createTextBlock("Response"),
      ]),
    ];

    let operationCalled = false;

    const result = withThinkingBlockPreservationSync(
      messages,
      "openai",
      (msgs) => {
        operationCalled = true;
        // Remove thinking blocks
        const modified = msgs.map((msg) => {
          if (msg.role !== "assistant") return msg;
          return {
            ...msg,
            content: (msg.content as any[]).filter((b) => b.type !== "thinking"),
          };
        }) as AgentMessage[];
        return { messages: modified };
      }
    );

    expect(operationCalled).toBe(true);
    // Thinking blocks should NOT be restored for OpenAI
    expect(result.messages[0].content).toHaveLength(1);
    expect(result.messages[0].content[0].type).toBe("text");
  });
});
