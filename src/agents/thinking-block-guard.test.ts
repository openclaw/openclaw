import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  containsThinkingBlocks,
  hasThinkingBlocks,
  isThinkingBlock,
  safeFilterAssistantContent,
  validateThinkingBlocks,
} from "./thinking-block-guard.js";

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

// Helper to create mock assistant messages for testing
function createMockAssistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    timestamp: Date.now(),
    api: "anthropic-messages" as const,
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022",
    usage: { input: 0, output: 0 },
    stopReason: "end_turn" as const,
  } as unknown as AssistantMessage;
}

describe("thinking-block-guard", () => {
  describe("isThinkingBlock", () => {
    it("identifies thinking blocks", () => {
      expect(isThinkingBlock({ type: "thinking", thinking: "test" })).toBe(true);
      expect(isThinkingBlock({ type: "redacted_thinking", redacted_thinking: "test" })).toBe(true);
      expect(isThinkingBlock({ type: "text", text: "test" })).toBe(false);
      expect(isThinkingBlock(null)).toBe(false);
      expect(isThinkingBlock(undefined)).toBe(false);
    });
  });

  describe("hasThinkingBlocks", () => {
    it("detects thinking blocks in assistant messages", () => {
      const withThinking = createMockAssistant([
        { type: "thinking", thinking: "analyzing..." },
        { type: "text", text: "response" },
      ]);
      expect(hasThinkingBlocks(withThinking)).toBe(true);

      const withoutThinking = createMockAssistant([{ type: "text", text: "response" }]);
      expect(hasThinkingBlocks(withoutThinking)).toBe(false);
    });
  });

  describe("containsThinkingBlocks", () => {
    it("detects thinking blocks across multiple messages", () => {
      const messages: AgentMessage[] = [
        { role: "user", content: "hello", timestamp: Date.now() },
        createMockAssistant([
          { type: "thinking", thinking: "hmm..." },
          { type: "text", text: "hi" },
        ]),
      ];
      expect(containsThinkingBlocks(messages)).toBe(true);

      const messagesNoThinking: AgentMessage[] = [
        { role: "user", content: "hello", timestamp: Date.now() },
        createMockAssistant([{ type: "text", text: "hi" }]),
      ];
      expect(containsThinkingBlocks(messagesNoThinking)).toBe(false);
    });
  });

  describe("safeFilterAssistantContent", () => {
    it("preserves thinking blocks when filtering", () => {
      const message = createMockAssistant([
        { type: "thinking", thinking: "test" },
        { type: "toolCall", id: "1", name: "test", arguments: {} },
        { type: "text", text: "result" },
      ]);

      // Filter out tool calls
      const filtered = safeFilterAssistantContent(message, (block) => {
        return block.type !== "toolCall";
      });

      expect(filtered).not.toBeNull();
      expect(filtered?.content).toHaveLength(2);
      expect(filtered?.content[0]).toEqual({ type: "thinking", thinking: "test" });
      expect(filtered?.content[1]).toEqual({ type: "text", text: "result" });
    });

    it("returns null when only thinking blocks remain after filtering", () => {
      const message = createMockAssistant([
        { type: "thinking", thinking: "test" },
        { type: "toolCall", id: "1", name: "test", arguments: {} },
      ]);

      // Filter out everything except thinking blocks
      const filtered = safeFilterAssistantContent(message, (block) => {
        return block.type === "thinking";
      });

      // Should return null because only thinking blocks remain
      expect(filtered).toBeNull();
    });

    it("returns original message when nothing is filtered", () => {
      const message = createMockAssistant([
        { type: "thinking", thinking: "test" },
        { type: "text", text: "result" },
      ]);

      const filtered = safeFilterAssistantContent(message, () => true);

      expect(filtered).toBe(message); // Same reference
    });
  });

  describe("validateThinkingBlocks", () => {
    it("validates well-formed thinking blocks", () => {
      const message = createMockAssistant([
        { type: "thinking", thinking: "valid" },
        { type: "text", text: "response" },
      ]);

      const result = validateThinkingBlocks(message);
      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("detects invalid thinking blocks missing required fields", () => {
      // Create a message with an invalid thinking block (missing 'thinking' field)
      const message = {
        ...createMockAssistant([{ type: "text" as const, text: "response" }]),
        content: [
          { type: "thinking" as const } as { type: "thinking"; thinking: string },
          { type: "text" as const, text: "response" },
        ],
      } as unknown as AssistantMessage;

      const result = validateThinkingBlocks(message);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("missing required");
    });

    it("validates redacted_thinking blocks", () => {
      // Use unknown cast since redacted_thinking isn't in the strict type
      const message = {
        ...createMockAssistant([{ type: "text" as const, text: "response" }]),
        content: [
          { type: "redacted_thinking", redacted_thinking: "..." } as unknown,
          { type: "text" as const, text: "response" },
        ],
      } as unknown as AssistantMessage;

      const result = validateThinkingBlocks(message);
      expect(result.valid).toBe(true);
    });
  });
});
